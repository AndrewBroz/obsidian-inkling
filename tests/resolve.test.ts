import { rangeParser } from "../src/editor/base";
import type { EditorChange } from "../src/editor/base/edit-handler";
import {
	anchor_inheritance_changes,
	cancel_empty_comment,
	range_source_with_fields,
	remove_comment,
	reopen_thread,
	resolve_thread,
	thread_resolved,
} from "../src/editor/base/edit-logic/resolve";
import { applyToText } from "../src/editor/base/edit-util/range-operations";
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
	test("plain comment thread: resolve via base adds done to the base only, reopen restores original", () => {
		const doc = "x{>>a<<}{>>b<<}y";
		const base = topRanges(doc)[0];
		expect(base.replies).toHaveLength(1);

		const resolved_doc = apply(doc, resolve_thread(base));
		expect(resolved_doc).toBe(`x{>>{"done":true}@@a<<}{>>b<<}y`);

		const resolved_base = topRanges(resolved_doc)[0];
		expect(thread_resolved(resolved_base)).toBe(true);

		const reopened_doc = apply(resolved_doc, reopen_thread(resolved_base));
		expect(reopened_doc).toBe(doc);

		const reopened_base = topRanges(reopened_doc)[0];
		expect(thread_resolved(reopened_base)).toBe(false);
	});

	test("anchored thread: resolve via the reply marks the base done", () => {
		const doc = "x{==sel==}{>>c<<}y";
		const highlight = topRanges(doc)[0];
		const reply = highlight.replies[0];

		const resolved_doc = apply(doc, resolve_thread(reply));
		expect(resolved_doc).toBe(`x{=={"done":true}@@sel==}{>>c<<}y`);

		const resolved_reply = topRanges(resolved_doc)[0].replies[0];
		expect(thread_resolved(resolved_reply)).toBe(true);
	});

	test("ranges with existing metadata: resolve merges done, reopen removes only done", () => {
		const doc = `x{=={"author":"A"}@@sel==}{>>{"author":"A"}@@c<<}y`;
		const highlight = topRanges(doc)[0];

		const resolved_doc = apply(doc, resolve_thread(highlight));
		expect(resolved_doc).toBe(`x{=={"author":"A","done":true}@@sel==}{>>{"author":"A"}@@c<<}y`);

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

describe("range_source_with_fields by syntax", () => {
	test("keeps an attributes range's syntax", () => {
		const [range] = topRanges(`{==x==}{author=A}`);
		expect(range_source_with_fields(range, { author: "A", done: true })).toBe(`{==x==}{author=A done=true}`);
	});

	test("writes the requested syntax", () => {
		const [range] = topRanges(`{=={"author":"A"}@@x==}`);
		expect(range_source_with_fields(range, { author: "A" }, "attributes")).toBe(`{==x==}{author=A}`);
		expect(range_source_with_fields(range, {}, "attributes")).toBe(`{==x==}`);
	});

	test("fields that cannot round-trip stay legacy", () => {
		const [range] = topRanges(`{==x==}`);
		expect(range_source_with_fields(range, { note: { x: 1 } }, "attributes")).toBe(`{=={"note":{"x":1}}@@x==}`);
	});
});

describe("thread rule 1: done is written on the base only", () => {
	test("resolve writes done on the anchor and nowhere else", () => {
		const doc = `{==x==}{>>c<<}{author=A}{>>r<<}{author=B}`;
		const out = apply(doc, resolve_thread(topRanges(doc)[0]));
		expect(out).toBe(`{==x==}{done=true}{>>c<<}{author=A}{>>r<<}{author=B}`);
	});

	test("legacy resolve also touches only the base", () => {
		const doc = `{=={"author":"A"}@@x==}{>>{"author":"A"}@@c<<}`;
		const out = apply(doc, resolve_thread(topRanges(doc)[0]));
		expect(out).toBe(`{=={"author":"A","done":true}@@x==}{>>{"author":"A"}@@c<<}`);
	});

	test("reopen removes done from the base and cleans legacy copies on replies", () => {
		const doc = `{=={"done":true}@@x==}{>>{"author":"A","done":true}@@c<<}`;
		const out = apply(doc, reopen_thread(topRanges(doc)[0]));
		expect(out).toBe(`{==x==}{>>{"author":"A"}@@c<<}`);
	});

	test("resolve with the attributes setting migrates the base it touches", () => {
		const doc = `{=={"author":"A"}@@x==}{>>{"author":"A"}@@c<<}`;
		const out = apply(doc, resolve_thread(topRanges(doc)[0], "attributes"));
		expect(out).toBe(`{==x==}{author=A done=true}{>>{"author":"A"}@@c<<}`);
	});

	test("the annotations-view resolve function leaves replies untouched when run over the whole thread", () => {
		const doc = `{=={"author":"A"}@@x==}{>>{"author":"A"}@@c<<}`;
		const [base] = topRanges(doc);
		const fn = (range: CriticMarkupRange, text: string) =>
			range === range.base_range ?
				range_source_with_fields(range, { ...range.own_fields, done: true }, "legacy") :
				text.slice(range.from, range.to);
		expect(applyToText(doc, fn, [base, ...base.replies]))
			.toBe(`{=={"author":"A","done":true}@@x==}{>>{"author":"A"}@@c<<}`);
	});
});

describe("thread rule 2 edits: inheritance is made explicit before it would change", () => {
	test("removing the first comment writes the anchor's inherited fields", () => {
		const doc = `{==x==}{>>c<<}{author=A time=1}{>>r<<}{author=B time=2}`;
		const [anchor] = topRanges(doc);
		const out = apply(doc, remove_comment(anchor.replies[0], "legacy"));
		expect(out).toBe(`{==x==}{author=A time=1}{>>r<<}{author=B time=2}`);
	});

	test("no write when the new first comment has the same values", () => {
		const doc = `{==x==}{>>c<<}{author=A time=1}{>>r<<}{author=A time=1}`;
		const [anchor] = topRanges(doc);
		expect(apply(doc, remove_comment(anchor.replies[0], "legacy"))).toBe(`{==x==}{>>r<<}{author=A time=1}`);
	});

	test("removing the only comment keeps the anchor's authorship", () => {
		const doc = `{==x==}{>>c<<}{author=A}`;
		const [anchor] = topRanges(doc);
		expect(apply(doc, remove_comment(anchor.replies[0], "legacy"))).toBe(`{==x==}{author=A}`);
	});

	test("removing a later reply never touches the anchor", () => {
		const doc = `{==x==}{>>c<<}{author=A}{>>r<<}{author=B}`;
		const [anchor] = topRanges(doc);
		expect(apply(doc, remove_comment(anchor.replies[1], "legacy"))).toBe(`{==x==}{>>c<<}{author=A}`);
	});

	test("an anchor that states its own fields is left alone", () => {
		const doc = `{==x==}{author=Z}{>>c<<}{author=A}{>>r<<}{author=B}`;
		const [anchor] = topRanges(doc);
		expect(apply(doc, anchor_inheritance_changes(anchor.replies[0], anchor.replies[1].own_fields, "legacy")))
			.toBe(doc);
	});

	test("rewriting the first comment (next_first unknown) writes the inherited fields", () => {
		const doc = `{==x==}{>>c<<}{author=A time=1}`;
		const [anchor] = topRanges(doc);
		expect(apply(doc, anchor_inheritance_changes(anchor.replies[0], undefined, "legacy")))
			.toBe(`{==x==}{author=A time=1}{>>c<<}{author=A time=1}`);
	});
});
