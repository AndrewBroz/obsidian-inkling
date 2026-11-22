import { browser, expect } from "@wdio/globals";
import { before, beforeEach, describe, it } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

import {
	atLeast,
	captureConsole,
	consoleErrors,
	dismissNotices,
	notices,
	obsidianVersion,
	PLUGIN_ID,
	settle,
	type,
} from "../helpers";

// Settings: the 0.14.0 format notice shows an existing install once; settings saved without a version (0.1.x) migrate
// without "Migration to new settings failed" (0.13.3); on Obsidian 1.13+, Inkling's settings are in settings search.

const FORMAT_NOTICE = "Inkling now saves comments and suggestions in a new format";
const MIGRATION_FAILED = /migration to new settings failed/i;

let dataPath: string;

/** Replaces the plugin's saved settings with `settings` and reloads the plugin, as on the next app start. */
async function restartWith(settings: Record<string, unknown> | null) {
	if (settings) {
		await browser.executeObsidian(
			async ({ app }, path, json) => {
				await app.vault.adapter.write(path, json);
			},
			dataPath,
			JSON.stringify(settings, null, "\t"),
		);
	}
	await obsidianPage.disablePlugin(PLUGIN_ID);
	await obsidianPage.enablePlugin(PLUGIN_ID);
	await browser.waitUntil(() =>
		browser.executeObsidian(({ app }, id) => app.plugins.getPlugin(id) !== null, PLUGIN_ID)
	);
	await settle(500);
}

async function savedSettings(): Promise<Record<string, unknown>> {
	const json = await browser.executeObsidian(({ app }, path) => app.vault.adapter.read(path), dataPath);
	return JSON.parse(json) as Record<string, unknown>;
}

describe("Settings", function() {
	let preset: Record<string, unknown>;

	before(async function() {
		await captureConsole();
		dataPath = `${await obsidianPage.getConfigDir()}/plugins/${PLUGIN_ID}/data.json`;
		preset = await savedSettings();
	});

	beforeEach(async function() {
		await dismissNotices();
	});

	describe("an existing install from before 0.14.0", function() {
		it("sees the format notice", async function() {
			// The fixture's settings, as saved before 0.14.0 added the flag.
			const { metadata_syntax_migrated: _, ...older } = preset;
			await restartWith(older);
			expect((await notices()).some(n => n.includes(FORMAT_NOTICE))).toBe(true);
			expect(await savedSettings()).toHaveProperty("metadata_syntax_migrated", true);
		});

		it("doesn't see it again", async function() {
			await restartWith(null);
			expect((await notices()).filter(n => n.includes(FORMAT_NOTICE))).toEqual([]);
		});
	});

	describe("settings saved without a version (0.1.x)", function() {
		it("migrate without a migration-failed notice", async function() {
			await restartWith({ author: "Tester" });
			expect((await notices()).filter(n => MIGRATION_FAILED.test(n))).toEqual([]);
			expect((await consoleErrors()).filter(l => /settings migration failed/i.test(l))).toEqual([]);
			const saved = await savedSettings();
			expect(saved.version).toBeTruthy();
			expect(saved.author).toBe("Tester");
		});
	});

	describe("settings search", function() {
		before(async function() {
			if (!atLeast(await obsidianVersion(), "1.13.0")) this.skip();
		});

		it("finds Inkling's settings by name", async function() {
			const main = await obsidianPage.getMainWindowHandle();
			const name = await browser.executeObsidian(
				({ app }, id) => app.plugins.manifests[id]?.name ?? "(not installed)",
				PLUGIN_ID,
			);
			await browser.executeObsidian(({ app }) => {
				(app as unknown as { setting: { open(): void } }).setting.open();
			});
			try {
				// Obsidian 1.15 opens its settings in a window of their own; older versions in a modal in the main one.
				await settle(500);
				for (const handle of await browser.getWindowHandles()) {
					await browser.switchToWindow(handle);
					if (await browser.$(".modal.mod-settings").isExisting()) break;
				}
				await browser.$(".modal.mod-settings .setting-search-container input[type=search]").click();
				await type("Default edit mode");
				// Results are grouped under each settings tab's name; Inkling's tab is named after the plugin.
				const results = await browser.waitUntil(async () => {
					const groups: Record<string, string> = {};
					for (const group of await browser.$$(".modal.mod-settings .setting-search-result-group").getElements()) {
						groups[await group.$(".setting-search-result-tab-label").getText()] = await group.$(
							".setting-search-result-group-items",
						).getText();
					}
					return groups[name] === undefined ? false : groups;
				}, { timeoutMsg: `no "${name}" group in the settings search results` });
				expect(results[name]).toContain("Default edit mode");
			} finally {
				await browser.keys("Escape");
				await browser.switchToWindow(main);
			}
		});
	});
});
