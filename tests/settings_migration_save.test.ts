// EXPL: The indexer worker is a bundler import with no jest equivalent; migrateSettings never touches it.
jest.mock("../src/database/indexer.worker", () => ({ __esModule: true, default: class {} }));
jest.mock("svelte", () => ({ mount: jest.fn(), unmount: jest.fn() }));
jest.mock("obsidian", () => ({ ...jest.requireActual("../__mocks__/obsidian"), Plugin: class {} }));

import { DEFAULT_SETTINGS } from "../src/constants";
import { create_range } from "../src/editor/base/edit-util/range-create";
import { SuggestionType } from "../src/editor/base/ranges";
import CommentatorPlugin from "../src/main";
import * as pluginId from "../src/plugin-id";

describe("settings migration saves", () => {
	test("settings imported from a legacy plugin id are saved once", async () => {
		jest.spyOn(pluginId, "readLegacySettings").mockResolvedValue({ id: "commentator", settings: { version: "0.0.1" } });
		const saveData = jest.fn().mockResolvedValue(undefined);
		const plugin = Object.assign(Object.create(CommentatorPlugin.prototype), {
			app: { workspace: { onLayoutReady: () => {} } },
			saveData,
		});
		await plugin.migrateSettings(null);
		expect(plugin.legacy_import_id).toBe("commentator");
		expect(saveData).toHaveBeenCalledTimes(1);

		// EXPL: A later reload of already-migrated settings (an external change to data.json) writes nothing.
		await plugin.migrateSettings({ ...plugin.settings });
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	test("settings from 0.1.x (no version field) migrate without a false failure notice", async () => {
		jest.spyOn(pluginId, "readLegacySettings").mockResolvedValue(null);
		const error = jest.spyOn(console, "error").mockImplementation(() => {});
		const plugin = Object.assign(Object.create(CommentatorPlugin.prototype), {
			app: { workspace: { onLayoutReady: () => {} } },
			saveData: jest.fn().mockResolvedValue(undefined),
		});
		await plugin.migrateSettings({ author: "Bea", enable_metadata: true });
		expect(error).not.toHaveBeenCalled();
		expect(plugin.settings.author).toBe("Bea");
		expect(plugin.saveData).toHaveBeenCalledWith(expect.objectContaining({ version: DEFAULT_SETTINGS.version }));
		error.mockRestore();
	});
	// EXPL: Release B (0.14.0): legacy metadata is deprecated and the Metadata format setting is gone. A saved
	//       `metadata_syntax: "legacy"` must have no effect, and existing installs see the notice once.
	function release_b_plugin() {
		jest.spyOn(pluginId, "readLegacySettings").mockResolvedValue(null);
		const notices: (() => void)[] = [];
		const plugin = Object.assign(Object.create(CommentatorPlugin.prototype), {
			app: { workspace: { onLayoutReady: (fn: () => void) => notices.push(fn) } },
			saveData: jest.fn().mockResolvedValue(undefined),
		});
		return { plugin, notices };
	}

	test("an existing install that saved the legacy format gets the notice once, and writes attribute blocks", async () => {
		const { plugin, notices } = release_b_plugin();
		await plugin.migrateSettings({ version: DEFAULT_SETTINGS.version, metadata_syntax: "legacy", author: "A" });
		expect(notices).toHaveLength(1);
		expect(plugin.settings).not.toHaveProperty("metadata_syntax");
		expect(plugin.saveData).toHaveBeenCalledWith(expect.objectContaining({ metadata_syntax_migrated: true }));
		expect(plugin.saveData).toHaveBeenCalledWith(expect.not.objectContaining({ metadata_syntax: "legacy" }));
		expect(create_range(
			{ ...plugin.settings, add_metadata: true, add_author_metadata: true, add_timestamp_metadata: true },
			SuggestionType.COMMENT,
			"hi",
		))
			.toMatch(/^\{>>hi<<\}\{author=A time=\d+\}$/);

		// The next load: no notice again, and a stale saved value still has no effect.
		const again = release_b_plugin();
		await again.plugin.migrateSettings({ ...plugin.settings, metadata_syntax: "legacy" });
		expect(again.notices).toHaveLength(0);
		expect(again.plugin.settings).not.toHaveProperty("metadata_syntax");
	});

	test("a new install shows no notice", async () => {
		const { plugin, notices } = release_b_plugin();
		await plugin.migrateSettings(null);
		expect(notices).toHaveLength(0);
		expect(plugin.settings.metadata_syntax_migrated).toBe(true);
		expect(plugin.settings).not.toHaveProperty("metadata_syntax");
	});
});
