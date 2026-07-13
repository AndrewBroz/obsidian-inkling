import { currentStateOf, nextStateOf, stateIndexOf } from "../src/editor/view-header/header-button";
import { EDIT_MODE_HEADER_STATES, PREVIEW_MODE_HEADER_STATES } from "../src/editor/view-header/index";
import { EditMode, PreviewMode } from "../src/types";

// EXPL: HeaderButton (and StatusBarButton) key their state arrays by `value` rather than by array
// position, so the cycle click handler walks `states` in ARRAY order (see nextStateOf). That order
// is what determines the actual click-to-cycle behavior (Editing -> Suggesting -> Commenting -> ...),
// so it's pinned here directly: a future reordering of EDIT_MODE_HEADER_STATES /
// PREVIEW_MODE_HEADER_STATES that reintroduces index/value coupling (or simply changes the cycle
// order) is caught by these tests, without needing an Obsidian workspace.
describe("edit-mode header button state array", () => {
	test("values and order match the EditMode cycle: Editing -> Suggesting -> Commenting", () => {
		expect(EDIT_MODE_HEADER_STATES.map(state => state.value)).toEqual([
			EditMode.CORRECTED,
			EditMode.SUGGEST,
			EditMode.COMMENT,
		]);
	});
});

describe("preview-mode header button state array", () => {
	test("values and order match the PreviewMode cycle: All -> Accept -> Reject", () => {
		expect(PREVIEW_MODE_HEADER_STATES.map(state => state.value)).toEqual([
			PreviewMode.ALL,
			PreviewMode.ACCEPT,
			PreviewMode.REJECT,
		]);
	});
});

describe("nextStateOf / stateIndexOf (pure cycle helpers)", () => {
	test("edit mode cycles Editing -> Suggesting -> Commenting -> Editing", () => {
		expect(nextStateOf(EDIT_MODE_HEADER_STATES, EditMode.CORRECTED).value).toBe(EditMode.SUGGEST);
		expect(nextStateOf(EDIT_MODE_HEADER_STATES, EditMode.SUGGEST).value).toBe(EditMode.COMMENT);
		expect(nextStateOf(EDIT_MODE_HEADER_STATES, EditMode.COMMENT).value).toBe(EditMode.CORRECTED);
	});

	test("preview mode cycles All -> Accept -> Reject -> All", () => {
		expect(nextStateOf(PREVIEW_MODE_HEADER_STATES, PreviewMode.ALL).value).toBe(PreviewMode.ACCEPT);
		expect(nextStateOf(PREVIEW_MODE_HEADER_STATES, PreviewMode.ACCEPT).value).toBe(PreviewMode.REJECT);
		expect(nextStateOf(PREVIEW_MODE_HEADER_STATES, PreviewMode.REJECT).value).toBe(PreviewMode.ALL);
	});

	test("an unknown value has no index and cycles to the first state (fail-safe, not a dead slot)", () => {
		expect(stateIndexOf(EDIT_MODE_HEADER_STATES, 99)).toBe(-1);
		expect(nextStateOf(EDIT_MODE_HEADER_STATES, 99).value).toBe(EditMode.CORRECTED);

		expect(stateIndexOf(PREVIEW_MODE_HEADER_STATES, 99)).toBe(-1);
		expect(nextStateOf(PREVIEW_MODE_HEADER_STATES, 99).value).toBe(PreviewMode.ALL);
	});

	test("a live value has a matching index", () => {
		expect(stateIndexOf(EDIT_MODE_HEADER_STATES, EditMode.SUGGEST)).toBe(1);
	});
});

// EXPL: Pins the fix for the icon off-by-one (icon was rendered from `nextStateOf`, one step ahead
// of the adjacent `text` label, e.g. label "Editing" paired with the Suggesting icon). The button's
// icon/label must both come from the SAME state — `currentStateOf` — while `nextStateOf` stays
// reserved for "what a click does next" (used only in the tooltip and the click handler itself).
describe("currentStateOf (pure current-state helper)", () => {
	test("edit mode: a value maps to its OWN state, not the next one in the cycle", () => {
		expect(currentStateOf(EDIT_MODE_HEADER_STATES, EditMode.CORRECTED).value).toBe(EditMode.CORRECTED);
		expect(currentStateOf(EDIT_MODE_HEADER_STATES, EditMode.SUGGEST).value).toBe(EditMode.SUGGEST);
		expect(currentStateOf(EDIT_MODE_HEADER_STATES, EditMode.COMMENT).value).toBe(EditMode.COMMENT);
	});

	test("preview mode: a value maps to its OWN state, not the next one in the cycle", () => {
		expect(currentStateOf(PREVIEW_MODE_HEADER_STATES, PreviewMode.ALL).value).toBe(PreviewMode.ALL);
		expect(currentStateOf(PREVIEW_MODE_HEADER_STATES, PreviewMode.ACCEPT).value).toBe(PreviewMode.ACCEPT);
		expect(currentStateOf(PREVIEW_MODE_HEADER_STATES, PreviewMode.REJECT).value).toBe(PreviewMode.REJECT);
	});

	test("an unknown value falls back to the first state, same fail-safe as nextStateOf", () => {
		expect(currentStateOf(EDIT_MODE_HEADER_STATES, 99).value).toBe(EditMode.CORRECTED);
		expect(currentStateOf(PREVIEW_MODE_HEADER_STATES, 99).value).toBe(PreviewMode.ALL);
	});

	test("current-state icon never equals the next-state icon (the off-by-one, pinned)", () => {
		for (const state of EDIT_MODE_HEADER_STATES) {
			const current = currentStateOf(EDIT_MODE_HEADER_STATES, state.value).icon;
			const next = nextStateOf(EDIT_MODE_HEADER_STATES, state.value).icon;
			expect(current).toBe(state.icon);
			expect(current).not.toBe(next);
		}
		for (const state of PREVIEW_MODE_HEADER_STATES) {
			const current = currentStateOf(PREVIEW_MODE_HEADER_STATES, state.value).icon;
			const next = nextStateOf(PREVIEW_MODE_HEADER_STATES, state.value).icon;
			expect(current).toBe(state.icon);
			expect(current).not.toBe(next);
		}
	});
});

// EXPL: Pins the actual icon-per-state mapping (the "icon reads as the CURRENT mode" contract) so a
// future edit to these arrays has to consciously change this table, not just relocate the bug.
describe("header button state icons depict the CURRENT mode", () => {
	test("preview mode: icon-per-state mapping", () => {
		expect(PREVIEW_MODE_HEADER_STATES.map(s => [s.text, s.icon])).toEqual([
			["Showing all suggestions", "message-square"],
			["Previewing \"accept all\"", "check"],
			["Previewing \"reject all\"", "cross"],
		]);
	});

	test("edit mode: icon-per-state mapping", () => {
		expect(EDIT_MODE_HEADER_STATES.map(s => [s.text, s.icon])).toEqual([
			["Editing", "edit"],
			["Suggesting", "file-edit"],
			["Commenting", "message-square"],
		]);
	});
});
