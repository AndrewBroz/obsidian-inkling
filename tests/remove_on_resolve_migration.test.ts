import { DEFAULT_SETTINGS, enableRemoveOnResolveOnce } from "../src/constants";
import type { PluginSettings } from "../src/types";

// EXPL: 0.13.0 flips remove_on_resolve to ON for everyone. Existing saves holding the old `false`
//       default are switched on exactly once; turning it off afterwards must stick. Mirrors
//       tests/diff_gutter_migration.test.ts (the plugin class can't be instantiated under jest).
describe("remove_on_resolve default-on migration (0.13.0)", () => {
	test("existing save with false and no flag is switched on once", () => {
		const saved = { remove_on_resolve: false } as Partial<PluginSettings>;
		const merged = Object.assign({}, DEFAULT_SETTINGS, saved);
		enableRemoveOnResolveOnce(merged, saved);
		expect(merged.remove_on_resolve).toBe(true);
		expect(merged.remove_on_resolve_migrated).toBe(true);
	});

	test("turning it off after migration sticks", () => {
		const saved = { remove_on_resolve: false, remove_on_resolve_migrated: true } as Partial<PluginSettings>;
		const merged = Object.assign({}, DEFAULT_SETTINGS, saved);
		enableRemoveOnResolveOnce(merged, saved);
		expect(merged.remove_on_resolve).toBe(false);
	});

	test("fresh install defaults on with flag", () => {
		expect(DEFAULT_SETTINGS.remove_on_resolve).toBe(true);
		expect(DEFAULT_SETTINGS.remove_on_resolve_migrated).toBe(true);
	});
});
