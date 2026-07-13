import { EditorView } from "@codemirror/view";

import { rangeParser, SuggestionType } from "../src/editor/base";
import { commitCommentDraft } from "../src/editor/base/edit-logic/add-comment";
import { clearCommentDraft, commentDraftField, setCommentDraft } from "../src/editor/uix/extensions/comment-draft";
import { createRangeState } from "./helpers";

const NO_META = { add_metadata: false };

function viewWith(doc: string) {
	return new EditorView({ state: createRangeState(doc, NO_META, [commentDraftField]) });
}

describe("commentDraftField", () => {
	test("starts empty and holds a draft anchor when set", () => {
		const view = viewWith("hello world");
		expect(view.state.field(commentDraftField)).toBeNull();

		view.dispatch({ effects: setCommentDraft.of({ from: 0, to: 5 }) });
		expect(view.state.field(commentDraftField)).toEqual({ from: 0, to: 5 });
	});

	test("clears on the clear effect", () => {
		const view = viewWith("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 0, to: 5 }) });
		view.dispatch({ effects: clearCommentDraft.of(null) });
		expect(view.state.field(commentDraftField)).toBeNull();
	});

	// EXPL: The draft must SURVIVE an unrelated edit, not be discarded by it. Discarding on any
	//       docChanged would contradict the "blur with text leaves the box open" rule: a user who
	//       types a draft, then clicks into the note to fix a word, would silently lose it. The
	//       anchor is a position pair, and mapping position pairs through a ChangeSet is exactly
	//       what CM6's `tr.changes.mapPos` is for.
	test("maps the anchor through an unrelated edit elsewhere in the note", () => {
		const view = viewWith("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 6, to: 11 }) }); // "world"
		view.dispatch({ changes: { from: 0, to: 0, insert: "XX" } });
		expect(view.state.field(commentDraftField)).toEqual({ from: 8, to: 13 });
	});

	// EXPL: The one case that DOES kill a draft — the text it was anchored to is gone, so there is
	//       nothing left to comment on and the mapped range collapses to empty.
	test("clears when its anchored text is deleted outright", () => {
		const view = viewWith("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 6, to: 11 }) }); // "world"
		view.dispatch({ changes: { from: 6, to: 11, insert: "" } });
		expect(view.state.field(commentDraftField)).toBeNull();
	});
});

describe("commitCommentDraft", () => {
	test("writes highlight + comment in ONE transaction and clears the draft", () => {
		const view = viewWith("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 0, to: 5 }) });

		const before = view.state.doc.length;
		let transactions = 0;
		// EXPL: A second transaction here would put junk in the undo stack — "one Ctrl+Z undoes the
		//       comment" is the property being pinned, not merely the resulting text.
		const counted = new EditorView({
			state: view.state,
			dispatch: (tr, v) => {
				transactions += 1;
				v.update([tr]);
			},
		});

		expect(commitCommentDraft(counted, "nice")).toBe(true);
		expect(transactions).toBe(1);
		expect(counted.state.doc.toString()).toBe("{==hello==}{>>nice<<} world");
		expect(counted.state.field(commentDraftField)).toBeNull();
		expect(before).toBe(11);

		const ranges = counted.state.field(rangeParser).ranges.ranges;
		expect(ranges[0].type).toBe(SuggestionType.HIGHLIGHT);
		expect(ranges[0].replies).toHaveLength(1);
		expect(ranges[0].replies[0].unwrap()).toBe("nice");
	});

	test("blank text writes nothing, and leaves the draft open", () => {
		const view = viewWith("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 0, to: 5 }) });
		expect(commitCommentDraft(view, "  ")).toBe(false);
		expect(view.state.doc.toString()).toBe("hello world");
		expect(view.state.field(commentDraftField)).toEqual({ from: 0, to: 5 });
	});

	test("with no draft open, writes nothing", () => {
		const view = viewWith("hello world");
		expect(commitCommentDraft(view, "nice")).toBe(false);
		expect(view.state.doc.toString()).toBe("hello world");
	});
});
