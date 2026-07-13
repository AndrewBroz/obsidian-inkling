import { nextStateOf, stateIndexOf } from "../src/editor/view-header/header-button";
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
