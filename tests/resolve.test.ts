import { rangeParser } from "../src/editor/base";
import type { EditorChange } from "../src/editor/base/edit-handler";
import {
	cancel_empty_comment,
	range_source_with_fields,
	reopen_thread,
	resolve_thread,
	thread_resolved,
} from "../src/editor/base/edit-logic/resolve";
import type { CommentRange, CriticMarkupRange } from "../src/editor/base/ranges";
import { createRangeState } from "./helpers";

// EXPL: Same apply-changes-descending shape as tests/mark_ranges.test.ts's `mark()` helper —
// changes must be non-overlapping (each range edits its own metadata blob/span), sort
// ascending for the overlap assertion, then splice in descending order so earlier offsets
// stay valid.
function apply(doc: string, changes: EditorChange[]): string {
	const ordered = [...changes].sort((a, b) => a.from - b.from);
	for (let i = 1; i < ordered.length; i++)
		expect(ordered[i].from).toBeGreaterThanOrEqual(ordered[i - 1].to);

	let output = doc;
	for (const change of [...ordered].reverse())
		output = output.slice(0, change.from) + change.insert + output.slice(change.to);
	return output;
}

function topRanges(doc: string): CriticMarkupRange[] {
	const state = createRangeState(doc, { enable_metadata: true });
	return state.field(rangeParser).ranges.ranges;
}

describe("resolve_thread / reopen_thread / thread_resolved", () => {
	test("plain comment thread: resolve via base adds done to every member, reopen restores original", () => {
		const doc = "x{>>a<<}{>>b<<}y";
		const base = topRanges(doc)[0];
		expect(base.replies).toHaveLength(1);

		const resolved_doc = apply(doc, resolve_thread(base));
		expect(resolved_doc).toBe(`x{>>{"done":true}@@a<<}{>>{"done":true}@@b<<}y`);

		const resolved_base = topRanges(resolved_doc)[0];
		expect(thread_resolved(resolved_base)).toBe(true);

		const reopened_doc = apply(resolved_doc, reopen_thread(resolved_base));
		expect(reopened_doc).toBe(doc);

		const reopened_base = topRanges(reopened_doc)[0];
		expect(thread_resolved(reopened_base)).toBe(false);
	});

	test("anchored thread: resolve via the reply marks the whole thread done", () => {
		const doc = "x{==sel==}{>>c<<}y";
		const highlight = topRanges(doc)[0];
		const reply = highlight.replies[0];

		const resolved_doc = apply(doc, resolve_thread(reply));
		expect(resolved_doc).toBe(`x{=={"done":true}@@sel==}{>>{"done":true}@@c<<}y`);

		const resolved_reply = topRanges(resolved_doc)[0].replies[0];
		expect(thread_resolved(resolved_reply)).toBe(true);
	});

	test("ranges with existing metadata: resolve merges done, reopen removes only done", () => {
		const doc = `x{=={"author":"A"}@@sel==}{>>{"author":"A"}@@c<<}y`;
		const highlight = topRanges(doc)[0];

		const resolved_doc = apply(doc, resolve_thread(highlight));
		expect(resolved_doc).toBe(`x{=={"author":"A","done":true}@@sel==}{>>{"author":"A","done":true}@@c<<}y`);

		const resolved_highlight = topRanges(resolved_doc)[0];
		expect(thread_resolved(resolved_highlight)).toBe(true);
		expect(resolved_highlight.fields.author).toBe("A");
		expect(resolved_highlight.replies[0].fields.author).toBe("A");

		const reopened_doc = apply(resolved_doc, reopen_thread(resolved_highlight));
		expect(reopened_doc).toBe(doc);

		const reopened_highlight = topRanges(reopened_doc)[0];
		expect(thread_resolved(reopened_highlight)).toBe(false);
		expect(reopened_highlight.fields.author).toBe("A");
		expect(reopened_highlight.replies[0].fields.author).toBe("A");
	});
});

describe("range_source_with_fields", () => {
	test("highlight with fields rebuilds the metadata blob", () => {
		const highlight = topRanges("x{==sel==}y")[0];
		expect(range_source_with_fields(highlight, { author: "A", done: true }))
			.toBe(`{=={"author":"A","done":true}@@sel==}`);
	});

	test("empty fields produce no metadata blob", () => {
		const highlight = topRanges("x{==sel==}y")[0];
		expect(range_source_with_fields(highlight, {})).toBe("{==sel==}");
	});

	test("substitution keeps its ~> separator", () => {
		const substitution = topRanges("x{~~a~>b~~}y")[0];
		expect(range_source_with_fields(substitution, { author: "A" }))
			.toBe(`{~~{"author":"A"}@@a~>b~~}`);
	});
});

describe("cancel_empty_comment", () => {
	test("fresh empty comment: removal leaves surrounding text intact", () => {
		const doc = "x{>><<}y";
		const comment = topRanges(doc)[0] as CommentRange;
		expect(apply(doc, cancel_empty_comment(comment))).toBe("xy");
	});

	test("empty reply that is the only reply on an anchored thread unwraps the highlight too", () => {
		const doc = "x{==sel==}{>><<}y";
		const highlight = topRanges(doc)[0];
		const reply = highlight.replies[0] as CommentRange;
		expect(apply(doc, cancel_empty_comment(reply))).toBe("xsely");
	});

	test("empty reply alongside another comment keeps the anchor and the other comment", () => {
		const doc = "x{==sel==}{>>keep<<}{>><<}y";
		const highlight = topRanges(doc)[0];
		const empty_reply = highlight.replies[1] as CommentRange;
		expect(apply(doc, cancel_empty_comment(empty_reply))).toBe("x{==sel==}{>>keep<<}y");
	});
});
