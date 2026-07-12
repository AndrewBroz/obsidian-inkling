import { EditorState, type Extension } from "@codemirror/state";

import { pill_eligible } from "../src/editor/uix/extensions/comment-pill";
import { createRangeState } from "./helpers";

// EXPL: add_metadata false keeps outputs deterministic (no timestamps in the markup)
const NO_META = { add_metadata: false };

function stateWithSelection(doc: string, anchor: number, head: number, extra: Extension[] = []): EditorState {
	const state = createRangeState(doc, NO_META, extra);
	return state.update({ selection: { anchor, head } }).state;
}

describe("pill_eligible", () => {
	test("empty selection is not eligible", () => {
		const state = stateWithSelection("hello world", 3, 3);
		expect(pill_eligible(state)).toBe(false);
	});

	test("a clean, non-empty selection is eligible", () => {
		const state = stateWithSelection("hello world", 0, 5);
		expect(pill_eligible(state)).toBe(true);
	});

	test("a selection overlapping an existing range is not eligible", () => {
		const doc = "he{++llo++} world";
		// EXPL: [0,7) overlaps the addition range at [2,11)
		const state = stateWithSelection(doc, 0, 7);
		expect(pill_eligible(state)).toBe(false);
	});

	test("a selection inside a comment is not eligible", () => {
		const doc = "hello {>>note<<} world";
		const inside_start = doc.indexOf("note");
		const inside_end = inside_start + "note".length;
		const state = stateWithSelection(doc, inside_start, inside_end);
		expect(pill_eligible(state)).toBe(false);
	});

	test("a non-empty selection in a read-only state is not eligible", () => {
		const state = stateWithSelection("hello world", 0, 5, [EditorState.readOnly.of(true)]);
		expect(pill_eligible(state)).toBe(false);
	});
});
