import { DEFAULT_SETTINGS, disableDiffGutterOnce } from "../src/constants";
import type { PluginSettings } from "../src/types";

// EXPL: Phase 5 Task 1, decision (5) — diff gutter flips to OFF by default. Existing users
//       with a saved `diff_gutter: true` predating this change must be migrated to `false`
//       exactly once; re-enabling afterwards must stick across restarts. Mirrors the
//       backfillLegacyMetadataFlags pattern (tests/metadata_defaults.test.ts): exercises the
//       real pure function used by CommentatorPlugin.migrateSettings (src/main.ts) directly,
//       since the plugin class can't be instantiated under jest.
describe("diff gutter quiet-default migration (Phase 5)", () => {
	test("legacy saved settings with diff_gutter true are migrated to false once", () => {
		const legacy_saved = { diff_gutter: true } as Partial<PluginSettings>; // predates diff_gutter_migrated
		const merged = Object.assign({}, DEFAULT_SETTINGS, legacy_saved);
		disableDiffGutterOnce(merged, legacy_saved);

		expect(merged.diff_gutter).toBe(false);
		expect(merged.diff_gutter_migrated).toBe(true);
	});

	test("re-enabling after migration sticks across subsequent loads", () => {
		// EXPL: User already went through the one-time migration (diff_gutter_migrated
		//       persisted as true) and then re-enabled the gutter; a later load must not
		//       flip it back off.
		const saved = { diff_gutter: true, diff_gutter_migrated: true } as Partial<PluginSettings>;
		const merged = Object.assign({}, DEFAULT_SETTINGS, saved);
		disableDiffGutterOnce(merged, saved);

		expect(merged.diff_gutter).toBe(true);
	});

	test("fresh installs keep the default false untouched", () => {
		const merged = Object.assign({}, DEFAULT_SETTINGS);
		disableDiffGutterOnce(merged, null);

		expect(merged.diff_gutter).toBe(false);
	});

	test("legacy suggestion_gutter true (pre-rename) is flipped to false once", () => {
		// EXPL: Simulates the 0.2.x→0.2.3 rename that copies suggestion_gutter→diff_gutter,
		//       followed by disableDiffGutterOnce. The rename introduces diff_gutter:true,
		//       but the one-time flip must override it. This tests the ordering: first the
		//       rename migration runs (copying the value), then disableDiffGutterOnce runs
		//       (flipping it off if not yet migrated).
		const legacy_saved = { suggestion_gutter: true } as Partial<PluginSettings>; // pre-0.2.3 rename
		const merged = Object.assign({}, DEFAULT_SETTINGS, legacy_saved);

		// Simulate the 0.2.x rename migration that copies suggestion_gutter → diff_gutter
		if ("suggestion_gutter" in merged) {
			merged.diff_gutter = (merged as unknown as Record<string, unknown>).suggestion_gutter as boolean;
			delete merged.suggestion_gutter;
		}

		// Then the one-time migration runs
		disableDiffGutterOnce(merged, legacy_saved);

		// Result: diff_gutter must be false (one-time flip wins) and flag must be set
		expect(merged.diff_gutter).toBe(false);
		expect(merged.diff_gutter_migrated).toBe(true);
	});
});
