// EXPL: The indexer worker is a bundler import with no jest equivalent; migrateSettings never touches it.
jest.mock("../src/database/indexer.worker", () => ({ __esModule: true, default: class {} }));
jest.mock("svelte", () => ({ mount: jest.fn(), unmount: jest.fn() }));
jest.mock("obsidian", () => ({ ...jest.requireActual("../__mocks__/obsidian"), Plugin: class {} }));

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
});
