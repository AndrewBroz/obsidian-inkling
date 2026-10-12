import {
	disableLegacyPlugin,
	isOwnLegacyManifest,
	LEGACY_PLUGIN_ID,
	migrateLegacyHotkeys,
	PLUGIN_ID,
	readLegacySettings,
} from "../src/plugin-id";

// EXPL: The plugin moved from id "inkling" to "inkling-markup" because an unrelated plugin
//       (bluewolf135/Inkling) registered "inkling" in the community store. Migration must only
//       ever touch an "inkling" install that is ours.
const OWN_MANIFEST = {
	id: "inkling",
	name: "Inkling",
	author: "Andrew Brož",
	authorUrl: "https://github.com/AndrewBroz/obsidian-inkling",
	version: "0.11.1",
};
const FOREIGN_MANIFEST = {
	id: "inkling",
	name: "Inkling",
	author: "William DeStefano",
	version: "1.0.1",
};

function fakeApp(
	files: Record<string, unknown>,
	opts: { enabled?: string[]; customKeys?: Record<string, unknown> } = {},
) {
	const enabled = new Set(opts.enabled ?? []);
	const manifests: Record<string, unknown> = {};
	for (const [path, content] of Object.entries(files)) {
		const match = path.match(/^\.obsidian\/plugins\/([^/]+)\/manifest\.json$/);
		if (match)
			manifests[match[1]] = content;
	}
	return {
		vault: {
			configDir: ".obsidian",
			adapter: {
				exists: async (path: string) => path in files,
				read: async (path: string) => JSON.stringify(files[path]),
			},
		},
		plugins: {
			manifests,
			enabledPlugins: enabled,
			disablePluginAndSave: jest.fn(async (id: string) => {
				enabled.delete(id);
			}),
		},
		hotkeyManager: {
			customKeys: { ...(opts.customKeys ?? {}) } as Record<string, unknown>,
			setHotkeys(command: string, keys: unknown) {
				this.customKeys[command] = keys;
			},
			save: jest.fn(),
		},
	} as any;
}

describe("plugin id migration (inkling → inkling-markup)", () => {
	test("ids", () => {
		expect(PLUGIN_ID).toBe("inkling-markup");
		expect(LEGACY_PLUGIN_ID).toBe("inkling");
	});

	test("ownership is decided by the manifest's author, not its id", () => {
		expect(isOwnLegacyManifest(OWN_MANIFEST)).toBe(true);
		expect(isOwnLegacyManifest({ ...OWN_MANIFEST, authorUrl: undefined })).toBe(true);
		expect(isOwnLegacyManifest({ ...OWN_MANIFEST, author: "Andrew Brož".normalize("NFD"), authorUrl: undefined }))
			.toBe(true);
		expect(isOwnLegacyManifest(FOREIGN_MANIFEST)).toBe(false);
		expect(isOwnLegacyManifest({ ...OWN_MANIFEST, id: "something-else" })).toBe(false);
		expect(isOwnLegacyManifest(null)).toBe(false);
	});

	test("imports settings from our own legacy inkling install", async () => {
		const app = fakeApp({
			".obsidian/plugins/inkling/manifest.json": OWN_MANIFEST,
			".obsidian/plugins/inkling/data.json": { author: "Alice" },
			".obsidian/plugins/commentator/data.json": { author: "Old" },
		});
		expect(await readLegacySettings(app)).toEqual({ id: "inkling", settings: { author: "Alice" } });
	});

	test("never imports the data.json of the unrelated inkling plugin", async () => {
		const app = fakeApp({
			".obsidian/plugins/inkling/manifest.json": FOREIGN_MANIFEST,
			".obsidian/plugins/inkling/data.json": { penColor: "red" },
		});
		expect(await readLegacySettings(app)).toBeNull();
	});

	test("falls back to the commentator id", async () => {
		const app = fakeApp({
			".obsidian/plugins/inkling/manifest.json": FOREIGN_MANIFEST,
			".obsidian/plugins/commentator/data.json": { author: "Old" },
		});
		expect(await readLegacySettings(app)).toEqual({ id: "commentator", settings: { author: "Old" } });
	});

	test("returns null when there is nothing to import", async () => {
		expect(await readLegacySettings(fakeApp({}))).toBeNull();
	});

	test("copies inkling:* hotkeys without overriding new-id bindings", () => {
		const keys = (key: string) => [{ modifiers: ["Mod"], key }];
		const app = fakeApp({}, {
			customKeys: {
				"inkling:accept-all": keys("A"),
				"inkling:reject-all": keys("R"),
				"inkling-markup:reject-all": keys("X"),
				"other-plugin:thing": keys("T"),
			},
		});
		expect(migrateLegacyHotkeys(app)).toBe(1);
		expect(app.hotkeyManager.customKeys["inkling-markup:accept-all"]).toEqual(keys("A"));
		expect(app.hotkeyManager.customKeys["inkling-markup:reject-all"]).toEqual(keys("X"));
		expect(app.hotkeyManager.customKeys["inkling-markup:thing"]).toBeUndefined();
		expect(app.hotkeyManager.save).toHaveBeenCalledTimes(1);
	});

	test("does not save hotkeys when nothing was copied", () => {
		const app = fakeApp({});
		expect(migrateLegacyHotkeys(app)).toBe(0);
		expect(app.hotkeyManager.save).not.toHaveBeenCalled();
	});

	test("disables our own enabled legacy copy", async () => {
		const app = fakeApp({ ".obsidian/plugins/inkling/manifest.json": OWN_MANIFEST }, { enabled: ["inkling"] });
		expect(await disableLegacyPlugin(app)).toBe(true);
		expect(app.plugins.disablePluginAndSave).toHaveBeenCalledWith("inkling");
	});

	test("leaves the unrelated inkling plugin alone", async () => {
		const app = fakeApp({ ".obsidian/plugins/inkling/manifest.json": FOREIGN_MANIFEST }, { enabled: ["inkling"] });
		expect(await disableLegacyPlugin(app)).toBe(false);
		expect(app.plugins.disablePluginAndSave).not.toHaveBeenCalled();
	});

	test("does nothing when our legacy copy is already disabled", async () => {
		const app = fakeApp({ ".obsidian/plugins/inkling/manifest.json": OWN_MANIFEST });
		expect(await disableLegacyPlugin(app)).toBe(false);
		expect(app.plugins.disablePluginAndSave).not.toHaveBeenCalled();
	});
});
