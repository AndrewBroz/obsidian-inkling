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
	//       (comment_range.ts:35-43). Appending at the reply's own `to` would be identical here by
	//       luck; using base_range.full_range_back is what keeps it correct for a mid-thread reply.
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
});
