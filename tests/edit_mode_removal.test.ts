import { clampEditMode, DEFAULT_SETTINGS } from "../src/constants";
import { resolveFocusSettings } from "../src/editor/renderers/live-preview/markup-renderer";
import { EditMode, type PluginSettings, RETIRED_EDIT_MODE } from "../src/types";

// EXPL: `EditMode.OFF = 0` installed zero editor extensions, i.e. no protection at all against
//       corrupting CriticMarkup syntax. It was removed; its value is retired (not reused) because
//       edit modes are persisted in data.json. Its one useful trait — revealing the syntax and
//       metadata of the range under the cursor — became the `reveal_syntax_on_focus` setting.
describe("retired edit mode (former EditMode.OFF)", () => {
	const LIVE_MODES = [EditMode.CORRECTED, EditMode.SUGGEST, EditMode.COMMENT];

	test("value 0 is no longer a live mode", () => {
		expect(Object.values(EditMode)).not.toContain(RETIRED_EDIT_MODE);
		expect(LIVE_MODES).not.toContain(RETIRED_EDIT_MODE as unknown as EditMode);
	});

	test("a persisted default_edit_mode of 0 is clamped to CORRECTED", () => {
		const saved = { default_edit_mode: RETIRED_EDIT_MODE } as unknown as Partial<PluginSettings>;
		const merged: PluginSettings = Object.assign({}, DEFAULT_SETTINGS, saved);
		clampEditMode(merged);

		expect(merged.default_edit_mode).toBe(EditMode.CORRECTED);
	});

	// EXPL: clampEditMode clamps ANY value outside the live set, not just the literal retired 0 —
	//       a hand-edited data.json, a schema written by another plugin version, or a future mode
	//       retirement (like OFF's) are all equally dangerous inputs to getEditMode, whose
	//       fallthrough now fails closed into CORRECTED for the same reason.
	test("clamping rewrites any out-of-range or garbage value to CORRECTED", () => {
		const garbageValues: unknown[] = [RETIRED_EDIT_MODE, 4, -1, undefined, null, NaN, "corrected"];
		for (const value of garbageValues) {
			const merged: PluginSettings = Object.assign({}, DEFAULT_SETTINGS, { default_edit_mode: value });
			clampEditMode(merged);

			expect(merged.default_edit_mode).toBe(EditMode.CORRECTED);
		}
	});

	test("clamping leaves live modes untouched and is idempotent", () => {
		for (const mode of LIVE_MODES) {
			const merged: PluginSettings = Object.assign({}, DEFAULT_SETTINGS, { default_edit_mode: mode });
			clampEditMode(merged);
			clampEditMode(merged);

			expect(merged.default_edit_mode).toBe(mode);
		}
	});

	test("every live mode has a markup_focus profile, and the retired value has none", () => {
		for (const mode of LIVE_MODES)
			expect(DEFAULT_SETTINGS.markup_focus[mode]).toBeDefined();
		expect(
			(DEFAULT_SETTINGS.markup_focus as unknown as Record<number, unknown>)[RETIRED_EDIT_MODE],
		).toBeUndefined();
	});
});

describe("resolveFocusSettings (reveal_syntax_on_focus)", () => {
	const settings = (overrides: Partial<PluginSettings> = {}): PluginSettings =>
		Object.assign({}, DEFAULT_SETTINGS, overrides);

	test("off: each mode keeps its own focus profile", () => {
		const off = settings({ reveal_syntax_on_focus: false });
		for (const mode of [EditMode.CORRECTED, EditMode.SUGGEST, EditMode.COMMENT]) {
			expect(resolveFocusSettings(off, mode)).toEqual(DEFAULT_SETTINGS.markup_focus[mode]);
			expect(resolveFocusSettings(off, mode).show_syntax).toBe(false);
			expect(resolveFocusSettings(off, mode).show_metadata).toBe(false);
		}
	});

	test("on: syntax and metadata are revealed in every mode", () => {
		const on = settings({ reveal_syntax_on_focus: true });
		for (const mode of [EditMode.CORRECTED, EditMode.SUGGEST, EditMode.COMMENT]) {
			const resolved = resolveFocusSettings(on, mode);
			expect(resolved.show_syntax).toBe(true);
			expect(resolved.show_metadata).toBe(true);
		}
	});

	test("on: show_comment and show_styling stay owned by the mode's own profile", () => {
		const on = settings({ reveal_syntax_on_focus: true });
		for (const mode of [EditMode.CORRECTED, EditMode.SUGGEST, EditMode.COMMENT]) {
			const profile = DEFAULT_SETTINGS.markup_focus[mode];
			const resolved = resolveFocusSettings(on, mode);
			expect(resolved.show_comment).toBe(profile.show_comment);
			expect(resolved.show_styling).toBe(profile.show_styling);
			expect(resolved.focus_annotation).toBe(profile.focus_annotation);
		}
		// EXPL: sanity — COMMENT is the only default profile that shows comments on focus
		expect(resolveFocusSettings(on, EditMode.COMMENT).show_comment).toBe(true);
		expect(resolveFocusSettings(on, EditMode.CORRECTED).show_comment).toBe(false);
	});

	test("the stored profiles are never mutated", () => {
		const on = settings({ reveal_syntax_on_focus: true });
		resolveFocusSettings(on, EditMode.CORRECTED);

		expect(on.markup_focus[EditMode.CORRECTED].show_syntax).toBe(false);
		expect(DEFAULT_SETTINGS.markup_focus[EditMode.CORRECTED].show_syntax).toBe(false);
	});
});
