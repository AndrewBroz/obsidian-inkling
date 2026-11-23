import { browser, expect } from "@wdio/globals";
import { afterEach, before, beforeEach, describe, it } from "mocha";
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
// The tab renders on every version: before 1.13 the Svelte page (display()), from 1.13 the declarative definitions,
// where a toggle that shows or hides other settings updates them (0.15.4 put setControlValue's refreshDomState() behind
// requireApiVersion; the latest Obsidian also refreshes after a control change by itself, so this checks the result).

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

/** Opens Obsidian's settings on Inkling's tab. */
async function openInklingTab() {
	await browser.executeObsidian(({ app }, id) => {
		const setting = (app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
		setting.open();
		setting.openTabById(id);
	}, PLUGIN_ID);
	await settle(500);
}

async function closeSettings() {
	await browser.executeObsidian(({ app }) => {
		(app as unknown as { setting: { close(): void } }).setting.close();
	});
	await settle(300);
}

/** The id of the settings tab on screen and its rendered text (innerText: hidden settings are left out). */
async function activeTab(): Promise<{ id: string | undefined; text: string }> {
	return browser.executeObsidian(({ app }) => {
		const tab = (app as unknown as { setting: { activeTab: { id: string; containerEl: HTMLElement } | null } })
			.setting.activeTab;
		return { id: tab?.id, text: tab?.containerEl.innerText ?? "" };
	});
}

/** Clicks the toggle of the setting named `name` on the tab on screen. */
async function clickToggle(name: string) {
	const clicked = await browser.executeObsidian(({ app }, settingName) => {
		const tab = (app as unknown as { setting: { activeTab: { containerEl: HTMLElement } | null } }).setting.activeTab;
		const item = [...(tab?.containerEl.querySelectorAll<HTMLElement>(".setting-item") ?? [])]
			.find(el => el.querySelector(".setting-item-name")?.textContent === settingName);
		const toggle = item?.querySelector<HTMLElement>(".checkbox-container");
		toggle?.click();
		return toggle !== undefined && toggle !== null;
	}, name);
	expect(clicked).toBe(true);
	await settle(300);
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

	describe("the settings tab", function() {
		afterEach(async function() {
			await closeSettings();
		});

		it("renders on this version", async function() {
			await restartWith(preset);
			const before = (await consoleErrors()).length;
			await openInklingTab();
			const tab = await activeTab();
			expect(tab.id).toBe(PLUGIN_ID);
			// The first setting, on the Svelte page's General tab and in the first declarative group.
			expect(tab.text).toContain("Default edit mode");
			expect((await consoleErrors()).slice(before)).toEqual([]);
		});

		it("shows and hides the author settings with Enable Authorship (1.13+)", async function() {
			if (!atLeast(await obsidianVersion(), "1.13.0")) this.skip();
			await restartWith(preset);
			await openInklingTab();
			expect((await activeTab()).text).toContain("Add Author Metadata");
			try {
				await clickToggle("Enable Authorship");
				expect(await savedSettings()).toHaveProperty("enable_author_metadata", false);
				expect((await activeTab()).text).not.toContain("Add Author Metadata");
				await clickToggle("Enable Authorship");
				expect(await savedSettings()).toHaveProperty("enable_author_metadata", true);
				expect((await activeTab()).text).toContain("Add Author Metadata");
			} finally {
				await closeSettings();
				await restartWith(preset);
			}
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
