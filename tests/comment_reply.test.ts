import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { rangeParser, SuggestionType } from "../src/editor/base";
import { commitReply } from "../src/editor/base/edit-logic/add-comment";
import { createRangeState } from "./helpers";

// EXPL: add_metadata false keeps outputs deterministic (no timestamps in the markup)
const NO_META = { add_metadata: false };

function viewWith(doc: string) {
	return new EditorView({ state: createRangeState(doc, NO_META) });
}

function baseRange(view: EditorView) {
	return view.state.field(rangeParser).ranges.ranges[0];
}

describe("commitReply", () => {
	test("appends a comment to the end of an existing comment thread", () => {
		const view = viewWith("{==hello==}{>>first<<} world");
		expect(commitReply(view, baseRange(view), "second")).toBe(true);
		expect(view.state.doc.toString()).toBe("{==hello==}{>>first<<}{>>second<<} world");

		const base = baseRange(view);
		expect(base.type).toBe(SuggestionType.HIGHLIGHT);
		expect(base.replies).toHaveLength(2);
		expect(base.replies[1].unwrap()).toBe("second");
	});

	// EXPL: The whole point of "comments on suggestions". The parser's grouping rule is already
	//       type-agnostic on the base (range-parser.ts:49-54), so an addition takes a thread the
	//       same way a highlight does — this test pins that the write path does not special-case
	//       comment/highlight bases and quietly refuse suggestions.
	test("starts a thread on an addition (comments on suggestions)", () => {
		const view = viewWith("a {++new++} b");
		expect(commitReply(view, baseRange(view), "why?")).toBe(true);
		expect(view.state.doc.toString()).toBe("a {++new++}{>>why?<<} b");
		expect(baseRange(view).replies).toHaveLength(1);
	});

	test("starts a thread on a deletion", () => {
		const view = viewWith("a {--old--} b");
		expect(commitReply(view, baseRange(view), "why?")).toBe(true);
		expect(view.state.doc.toString()).toBe("a {--old--}{>>why?<<} b");
	});

	// EXPL: Replying to a REPLY must retarget the thread's base, not nest — threads are flat
	//       (comment_range.ts:35-43). This pins that a reply to a MID-thread reply still lands at
	//       the END of the thread: using the passed range's own `to` instead of
	//       base_range.full_range_back would insert "three" between "one" and "two"
	//       ({==hi==}{>>one<<}{>>three<<}{>>two<<}), misordering the thread. Verified by mutation.
	test("replying to a reply appends to the thread's base, not to the reply", () => {
		const view = viewWith("{==hi==}{>>one<<}{>>two<<}");
		const reply = view.state.field(rangeParser).ranges.ranges[1];
		expect(commitReply(view, reply, "three")).toBe(true);
		expect(view.state.doc.toString()).toBe("{==hi==}{>>one<<}{>>two<<}{>>three<<}");
		expect(baseRange(view).replies).toHaveLength(3);
	});

	test("blank text writes nothing and reports failure", () => {
		const view = viewWith("{==hello==}{>>first<<}");
		const before = view.state.doc.toString();
		expect(commitReply(view, baseRange(view), "   \n ")).toBe(false);
		expect(view.state.doc.toString()).toBe(before);
	});

	// EXPL: CriticMarkup has no escape syntax, so a closing delimiter typed into a reply body ends
	//       the reply where the user's text merely mentions it — `{>>see a<<}b<<}` — leaving junk in
	//       the note. Refuse the write (the box stays open, the text intact) rather than mangling
	//       either the user's words or the document.
	test.each([
		["<<}", "see a<<}b"],
		["==}", "ends ==} here"],
		["++}", "an ++} addition"],
		["--}", "a --} deletion"],
		["~~}", "a ~~} substitution"],
		["@@", "ping @@ me"],
	])("refuses a reply body containing %s, writing nothing", (_seq, text) => {
		const view = viewWith("{==hello==}{>>first<<}");
		expect(commitReply(view, baseRange(view), text)).toBe(false);
		expect(view.state.doc.toString()).toBe("{==hello==}{>>first<<}");
	});

	// EXPL: `readOnly` is a facet over USER input; it does not block the programmatic dispatch
	//       commitReply makes, and the reply box is reachable in a read-only editor (a click on any
	//       thread card opens one).
	test("writes nothing in a read-only editor", () => {
		const view = new EditorView({
			state: createRangeState("{==hello==}{>>first<<}", NO_META, [EditorState.readOnly.of(true)]),
		});
		expect(commitReply(view, baseRange(view), "second")).toBe(false);
		expect(view.state.doc.toString()).toBe("{==hello==}{>>first<<}");
	});
});
