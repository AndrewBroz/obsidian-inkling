import { EditorView } from "@codemirror/view";

import { addCommentToView } from "../src/editor/base/edit-logic/add-comment";
import { commentDraftField } from "../src/editor/uix/extensions/comment-draft";
import { createRangeState } from "./helpers";

// EXPL: add_metadata false keeps outputs deterministic (no timestamps in the markup)
const NO_META = { add_metadata: false };

function viewWith(doc: string, anchor: number, head: number) {
	const state = createRangeState(doc, NO_META, [commentDraftField]);
	const view = new EditorView({ state });
	view.dispatch({ selection: { anchor, head } });
	return view;
}

describe("addCommentToView with a selection", () => {
	// EXPL: This used to assert the doc immediately became "{==hello==}{>><<}". That flow is gone:
	//       a clean selection now opens a DRAFT and writes nothing until the user submits, so an
	//       abandoned comment leaves no empty range in the note and no junk in the undo stack.
	//       The write itself is covered by tests/comment_draft.test.ts (commitCommentDraft).
	test("a clean selection opens a draft and writes nothing to the document", () => {
		const view = viewWith("hello world", 0, 5);
		addCommentToView(view, undefined);
		expect(view.state.doc.toString()).toBe("hello world");
		expect(view.state.field(commentDraftField)).toEqual({ from: 0, to: 5 });
	});

	test("selection overlapping existing markup falls back to cursor behavior", () => {
		const doc = "he{++llo++} world";
		// EXPL: anchor=7, head=0 — a backward drag. The selection [0,7) still overlaps
		//       the addition range at [2,11), but `selection.main.head` (0) lands outside
		//       it, so the at-cursor fallback (bullet 2: "comment inserted at
		//       selection.main.head") can't land mid-range and corrupt its markup. A
		//       forward drag (anchor=0, head=7) would put head at index 7, inside
		//       "{++llo++}", and splicing raw text there breaks the range apart — that's
		//       a genuine hazard of "insert at raw head" but is orthogonal to what this
		//       test is verifying (that overlap detection correctly skips the wrap path).
		const view = viewWith(doc, 7, 0); // overlaps the addition range
		addCommentToView(view, undefined);
		const result = view.state.doc.toString();
		// EXPL: no wrapping happened — no highlight bracket anywhere
		expect(result).not.toContain("{==");
		// a bare comment was inserted at the selection head
		expect(result).toContain("{>><<}");
		// the addition range is intact
		expect(result).toContain("{++llo++}");
	});

	test("empty selection keeps existing at-cursor behavior", () => {
		const view = viewWith("hello", 3, 3);
		addCommentToView(view, undefined);
		expect(view.state.doc.toString()).toBe("hel{>><<}lo");
	});
});
