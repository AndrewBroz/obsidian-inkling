import { EditorState } from "@codemirror/state";
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

	// EXPL: These three pin the assoc biases in `commentDraftField`'s mapPos pair, which give the
	//       anchor EXCLUSIVE boundaries. Without them the biases can be inverted (to the
	//       boundary-INCLUSIVE pair) and every other test in this file still passes — the rest only
	//       exercise edits far away from the anchor, or deletion of the whole span. The behaviour
	//       matters: typing immediately before a commented phrase must not silently swallow the new
	//       words into what the comment claims to be about.
	test("text typed exactly AT the anchor's start stays outside the anchor", () => {
		const view = viewWith("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 6, to: 11 }) }); // "world"
		view.dispatch({ changes: { from: 6, to: 6, insert: "XX" } });
		// "hello XXworld" — the anchor still covers "world", not "XXworld"
		expect(view.state.field(commentDraftField)).toEqual({ from: 8, to: 13 });
	});

	test("text typed exactly AT the anchor's end stays outside the anchor", () => {
		const view = viewWith("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 6, to: 11 }) }); // "world"
		view.dispatch({ changes: { from: 11, to: 11, insert: "XX" } });
		// "hello worldXX" — the anchor still covers "world", not "worldXX"
		expect(view.state.field(commentDraftField)).toEqual({ from: 6, to: 11 });
	});

	test("text typed strictly INSIDE the anchor grows it", () => {
		const view = viewWith("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 6, to: 11 }) }); // "world"
		view.dispatch({ changes: { from: 8, to: 8, insert: "XX" } });
		// "hello woXXrld" — still commenting on that word, so the anchor absorbs the insertion
		expect(view.state.field(commentDraftField)).toEqual({ from: 6, to: 13 });
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

// EXPL: The write path is the one place this plugin can destroy a note, so these tests are about
//       the note, not the feature: every one of them asserts the resulting document still parses
//       into exactly the ranges it looks like it has, and that no unbalanced/dangling CriticMarkup
//       delimiter is ever left behind in the user's text.
describe("commitCommentDraft cannot corrupt the note", () => {
	/** Every delimiter the parser knows, and how many of each the doc contains. */
	function delimiter_counts(doc: string) {
		return ["{==", "==}", "{>>", "<<}", "{++", "++}", "{--", "--}"]
			.map(d => doc.split(d).length - 1);
	}

	function assertBalanced(view: EditorView) {
		const doc = view.state.doc.toString();
		const [open_h, close_h, open_c, close_c, open_a, close_a, open_d, close_d] = delimiter_counts(doc);
		expect([open_h, open_c, open_a, open_d]).toEqual([close_h, close_c, close_a, close_d]);

		// EXPL: Balance alone is not enough — `{==a{==X==}b==}` is "balanced" and still garbage. Every
		//       delimiter in the doc must belong to a range the parser actually recognises, so the
		//       total markup the parser accounts for must cover every delimiter present.
		const ranges = view.state.field(rangeParser).ranges.ranges;
		const accounted = ranges.reduce((sum, range) => {
			const text = doc.slice(range.from, range.to);
			return sum + delimiter_counts(text).reduce((a, b) => a + b, 0);
		}, 0);
		expect(accounted).toBe(delimiter_counts(doc).reduce((a, b) => a + b, 0));
	}

	// EXPL: The open-time guard in addCommentToView ("selection contains no CriticMarkup") CANNOT
	//       stand in for a commit-time one: the anchor is LIVE and deliberately absorbs insertions
	//       made strictly inside it, and the reply box deliberately stays open on blur so the user
	//       can go and edit the note. In Suggest mode that edit writes `{++…++}` straight into the
	//       anchored span. Wrapping it then yields `{==quick{++very++} brown==}{>>hmm<<}` — which the
	//       parser reads as a highlight whose body happens to contain plus signs, silently demoting a
	//       tracked change to inert text.
	test("an addition made INSIDE the live anchor is never swallowed by the highlight", () => {
		const view = viewWith("the quick brown fox");
		view.dispatch({ effects: setCommentDraft.of({ from: 4, to: 15 }) }); // "quick brown"
		view.dispatch({ changes: { from: 9, to: 9, insert: "{++very++}" } });

		expect(commitCommentDraft(view, "hmm")).toBe(true);
		expect(view.state.doc.toString()).toBe("the quick{++very++} brown{>>hmm<<} fox");
		assertBalanced(view);

		const ranges = view.state.field(rangeParser).ranges.ranges;
		expect(ranges.map(range => range.type)).toEqual([SuggestionType.ADDITION, SuggestionType.COMMENT]);
		// EXPL: The suggestion is still a REAL tracked change, not text that looks like one.
		expect(ranges[0].unwrap()).toBe("very");
		expect(ranges[1].unwrap()).toBe("hmm");
		expect(view.state.field(commentDraftField)).toBeNull();
	});

	// EXPL: Reachable with no typing at all: open a draft, then hit "Add reply" on a card whose
	//       thread lies inside the anchor. Wrapping would give
	//       `{==aaa b{==X==}{>>c<<}bb ccc==}{>>outer<<}` — the inner `==}` closes the outer highlight
	//       early, `bb ccc==}` is orphaned as plain text, and a bare `==}` is left in the note.
	test("a thread that lands inside the live anchor is never swallowed by the highlight", () => {
		const view = viewWith("aaa bbb ccc");
		view.dispatch({ effects: setCommentDraft.of({ from: 0, to: 11 }) });
		view.dispatch({ changes: { from: 5, to: 5, insert: "{==X==}{>>c<<}" } });

		expect(commitCommentDraft(view, "outer")).toBe(true);
		expect(view.state.doc.toString()).toBe("aaa b{==X==}{>>c<<}bb ccc{>>outer<<}");
		assertBalanced(view);
		expect(view.state.doc.toString()).not.toContain("{==aaa");

		const ranges = view.state.field(rangeParser).ranges.ranges;
		expect(ranges.map(range => range.type)).toEqual([
			SuggestionType.HIGHLIGHT,
			SuggestionType.COMMENT,
			SuggestionType.COMMENT,
		]);
		// EXPL: The pre-existing thread survives intact — same base, same reply.
		expect(ranges[0].replies).toHaveLength(1);
		expect(ranges[0].replies[0].unwrap()).toBe("c");
		// EXPL: ...and the degraded comment is a real, parseable comment, not junk.
		expect(ranges[2].unwrap()).toBe("outer");
	});

	// EXPL: CriticMarkup has no escapes. A `==}` inside the text being wrapped closes the highlight
	//       the instant it is written, so this selection can never be an anchor — same graceful
	//       degradation, for the same reason.
	test("an anchor whose text contains a closing delimiter degrades to an unanchored comment", () => {
		const view = viewWith("weird ==} text");
		view.dispatch({ effects: setCommentDraft.of({ from: 0, to: 14 }) });

		expect(commitCommentDraft(view, "huh")).toBe(true);
		expect(view.state.doc.toString()).toBe("weird ==} text{>>huh<<}");

		const ranges = view.state.field(rangeParser).ranges.ranges;
		expect(ranges).toHaveLength(1);
		expect(ranges[0].type).toBe(SuggestionType.COMMENT);
		expect(ranges[0].unwrap()).toBe("huh");
	});

	// EXPL: `@@` terminates a range's metadata prefix, so with `add_metadata` ON (the DEFAULT) an
	//       anchor containing `@@` makes the highlight's own metadata unparseable.
	test("an anchor whose text contains the metadata terminator degrades to an unanchored comment", () => {
		const view = viewWith("mail me @@ home");
		view.dispatch({ effects: setCommentDraft.of({ from: 0, to: 15 }) });

		expect(commitCommentDraft(view, "ok")).toBe(true);
		expect(view.state.doc.toString()).toBe("mail me @@ home{>>ok<<}");
		expect(view.state.field(commentDraftField)).toBeNull();
	});

	// EXPL: The user TYPED this text, so unlike the anchor there is something for them to fix —
	//       refuse the write and leave the box open rather than mangling their words or the note.
	test.each([
		["<<}", "see {>>a<<} here"],
		["==}", "ends with ==} oops"],
		["++}", "an ++} addition"],
		["--}", "a --} deletion"],
		["~~}", "a ~~} substitution"],
		["@@", "ping @@ me"],
	])("refuses a comment body containing %s, writing nothing and keeping the draft", (_seq, text) => {
		const view = viewWith("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 0, to: 5 }) });

		expect(commitCommentDraft(view, text)).toBe(false);
		expect(view.state.doc.toString()).toBe("hello world");
		expect(view.state.field(commentDraftField)).toEqual({ from: 0, to: 5 });
	});

	// EXPL: `readOnly` is a CodeMirror facet over USER input; it does not block a programmatic
	//       dispatch, and every write in add-comment.ts is one.
	test("writes nothing in a read-only editor", () => {
		const view = new EditorView({
			state: createRangeState("hello world", NO_META, [commentDraftField, EditorState.readOnly.of(true)]),
		});
		view.dispatch({ effects: setCommentDraft.of({ from: 0, to: 5 }) });

		expect(commitCommentDraft(view, "nice")).toBe(false);
		expect(view.state.doc.toString()).toBe("hello world");
	});
});
