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

	// EXPL: CriticMarkup ranges cannot nest, so a selection that SHARES characters with an existing
	//       range has nowhere clean to wrap — but one that merely TOUCHES a range's edge, sharing no
	//       character with it, wraps perfectly well; the abutted range itself is left untouched
	//       either way. `ranges_in_interval` (the closed-interval predicate this guard used to call)
	//       cannot tell "touches the edge" apart from "shares a character" — the interval tree it
	//       wraps reports both as hits — so it wrongly refused this selection and fell through to an
	//       unanchored at-cursor comment. `ranges_overlapping_interval` applies the honest overlap
	//       test on top of that same tree search, so only genuine character-sharing disqualifies a
	//       selection. [0,2) ends exactly at the addition range's left edge ([2,11)); asserting the
	//       doc gains a `{==...==}` highlight (not just a bare `{>><<}`) pins that the wrap path,
	//       not the unanchored fallback, ran.
	test("a selection abutting the left edge of an existing range is wrapped, not left unanchored", () => {
		const doc = "he{++llo++} world";
		const view = viewWith(doc, 0, 2, [commentDraftField]);
		addCommentToView(view, undefined);

		const result = view.state.doc.toString();
		expect(result).toContain("{==he==}");
		expect(result).toBe("{==he==}{>><<}{++llo++} world");
	});

	// EXPL: Mirror image on the other edge: [11,16) begins exactly at the range's right edge, and —
	//       per `mark.ts`'s asymmetric ignore-loop guard — goes through different code than the
	//       left-edge case above, so it needs its own pin rather than being assumed symmetric.
	test("a selection abutting the right edge of an existing range is wrapped, not left unanchored", () => {
		const doc = "he{++llo++} world";
		const view = viewWith(doc, 11, 16, [commentDraftField]);
		addCommentToView(view, undefined);

		const result = view.state.doc.toString();
		expect(result).toContain("{== worl==}");
		expect(result).toBe("he{++llo++}{== worl==}{>><<}d");
	});

	// EXPL: The legacy no-gutter path wraps the selection in `{==…==}`, and CriticMarkup has no
	//       escapes: a `==}` in the selected text closes that highlight the instant it is written,
	//       stranding `text==}` as plain text and leaving a DANGLING `==}` in the user's note (with
	//       metadata on, an `@@` truncates the highlight's own metadata the same way). The selection
	//       carries no markup, so the overlap guard above waves it through — only a check of the
	//       anchor TEXT catches it. Degrade to the unanchored comment, exactly as the draft path's
	//       commit-time re-validation does.
	test("a no-gutter selection containing a closing delimiter is never wrapped", () => {
		const view = viewWith("weird ==} text", 0, 14, [commentDraftField]);
		addCommentToView(view, undefined);

		expect(view.state.doc.toString()).toBe("weird ==} text{>><<}");
		expect(view.state.doc.toString()).not.toContain("{==");
	});

	test("selection overlapping existing markup falls back to cursor behavior", () => {
		const doc = "he{++llo++} world";
		// EXPL: anchor=7, head=0 — a backward drag. The selection [0,7) still overlaps the addition
		//       range at [2,11), so the wrap path is correctly skipped and a bare comment is written
		//       at the head (0), outside the range.
		const view = viewWith(doc, 7, 0); // overlaps the addition range
		addCommentToView(view, undefined);
		const result = view.state.doc.toString();
		// EXPL: no wrapping happened — no highlight bracket anywhere
		expect(result).not.toContain("{==");
		expect(result).toBe("{>><<}he{++llo++} world");
	});

	// EXPL: The mirror image of the test above, and the hazard its comment used to merely DOCUMENT: a
	//       FORWARD drag (anchor=0, head=7) leaves the head at index 7 — strictly inside `{++llo++}` —
	//       and the at-cursor fallback splices there, giving `he{++ll{>><<}o++}`: the addition is
	//       demoted to inert text and the comment is buried inside it. A raw head is never a safe
	//       insertion point; snap to the covering range's thread end, the one position inside a
	//       range's span that is always a boundary.
	test("a forward drag whose head lands inside a range never splices the comment into it", () => {
		const view = viewWith("he{++llo++} world", 0, 7);
		addCommentToView(view, undefined);

		expect(view.state.doc.toString()).toBe("he{++llo++}{>><<} world");
		expect(view.state.doc.toString()).not.toContain("{++ll{>>");
	});

	test("empty selection keeps existing at-cursor behavior", () => {
		const view = viewWith("hello", 3, 3);
		addCommentToView(view, undefined);
		expect(view.state.doc.toString()).toBe("hel{>><<}lo");
	});

	// EXPL: "Add comment" with the cursor parked inside an existing comment body used to write
	//       `{>>he{>><<}llo<<}` — the inner `<<}` closes the outer comment early, `llo<<}` is orphaned
	//       as plain text and a bare `<<}` is left behind. The same snap-to-boundary rule turns it
	//       into a reply on that comment's thread, which is what the user asked for anyway.
	test("a cursor parked inside an existing comment appends to its thread instead of splitting it", () => {
		const view = viewWith("{>>hello<<}", 5, 5);
		addCommentToView(view, undefined);

		expect(view.state.doc.toString()).toBe("{>>hello<<}{>><<}");
	});
});
