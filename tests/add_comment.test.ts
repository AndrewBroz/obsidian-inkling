import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorEditorField } from "obsidian";

import { addCommentToView } from "../src/editor/base/edit-logic/add-comment";
import { pendingAnnotationMarkers } from "../src/editor/renderers/gutters/annotations-gutter/pending-marker";
import { commentDraftField } from "../src/editor/uix/extensions/comment-draft";
import { createRangeState } from "./helpers";

// EXPL: add_metadata false keeps outputs deterministic (no timestamps in the markup)
const NO_META = { add_metadata: false };

// EXPL: `pendingAnnotationMarkers` is what actually RENDERS a draft (it ships inside the annotation
//       gutter extension), and addCommentToView probes for it before taking the draft path — so a
//       state that wants the draft behaviour has to carry it, exactly like the real editor does when
//       the `annotation_gutter` setting is on.
const WITH_GUTTER: Extension[] = [commentDraftField, pendingAnnotationMarkers, editorEditorField];

function viewWith(doc: string, anchor: number, head: number, extra: Extension[] = WITH_GUTTER) {
	const state = createRangeState(doc, NO_META, extra);
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

	// EXPL: The annotation gutter is a user-facing toggle (and is reconfigured away entirely in
	//       embeds/hover popovers), so `pendingAnnotationMarkers` — the provisional card — is NOT
	//       always in the state. Opening a draft there would render nothing, and nothing could then
	//       clear it (Escape/blur live in the card that does not exist), which makes `pill_eligible`
	//       false for every later selection: the pill, the "Add comment" command and the context menu
	//       item would all be dead for the rest of the session. Without a gutter the legacy
	//       immediate-write is the ONLY thing that can work, so it must survive.
	test("a clean selection writes markup immediately when the gutter (and its card) is absent", () => {
		const view = viewWith("hello world", 0, 5, [commentDraftField]);
		addCommentToView(view, undefined);

		expect(view.state.doc.toString()).toBe("{==hello==}{>><<} world");
		// ...and no draft was left behind that nothing could ever clear
		expect(view.state.field(commentDraftField)).toBeNull();
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
