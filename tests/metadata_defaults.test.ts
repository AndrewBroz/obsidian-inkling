import { backfillLegacyMetadataFlags, DEFAULT_SETTINGS } from "../src/constants";
import { generate_metadata } from "../src/editor/base/edit-util/metadata";
import type { PluginSettings } from "../src/types";

describe("attribution defaults (Phase 3a)", () => {
	test("metadata parsing and writing are on by default", () => {
		expect(DEFAULT_SETTINGS.enable_metadata).toBe(true);
		expect(DEFAULT_SETTINGS.enable_author_metadata).toBe(true);
		expect(DEFAULT_SETTINGS.enable_timestamp_metadata).toBe(true);
		expect(DEFAULT_SETTINGS.add_metadata).toBe(true);
		expect(DEFAULT_SETTINGS.add_author_metadata).toBe(true);
		expect(DEFAULT_SETTINGS.add_timestamp_metadata).toBe(true);
	});

	test("generate_metadata produces author and timestamp under defaults", () => {
		const metadata = generate_metadata({
			...DEFAULT_SETTINGS,
			author: "Test Author",
		});
		expect(metadata).toBeDefined();
		expect(metadata!.author).toBe("Test Author");
		expect(typeof metadata!.time).toBe("number");
	});

	test("generate_metadata omits author when name is unset", () => {
		const metadata = generate_metadata({ ...DEFAULT_SETTINGS, author: "" });
		expect(metadata).toBeDefined();
		expect(metadata!.author).toBeUndefined();
		expect(typeof metadata!.time).toBe("number");
	});

	// EXPL: Exercises the real backfillLegacyMetadataFlags function used by
	//       CommentatorPlugin.migrateSettings (src/main.ts) — the plugin class itself can't be
	//       instantiated under jest (extends Obsidian's Plugin), so this calls the extracted
	//       pure function directly rather than mirroring its logic.
	test("legacy saved settings without metadata keys must not inherit the new true defaults", () => {
		const legacy_saved = { author: "Old User" } as Partial<PluginSettings>; // predates the six keys
		const merged = Object.assign({}, DEFAULT_SETTINGS, legacy_saved);
		backfillLegacyMetadataFlags(merged, legacy_saved);

		expect(merged.add_metadata).toBe(false);
		expect(merged.enable_metadata).toBe(false);
		expect(merged.author).toBe("Old User");
	});
});
