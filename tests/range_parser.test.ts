import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { applyToText } from "../src/editor/base/edit-util/range-operations";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import { SubstitutionRange, SuggestionType } from "../src/editor/base/ranges";
import { createRangeState } from "./helpers";

function rangesOf(doc: string, enable_metadata = false) {
	return getRangesInText(doc, { ...DEFAULT_SETTINGS, enable_metadata });
}

function spans(doc: string, enable_metadata = false) {
	return rangesOf(doc, enable_metadata).map(range => [range.type, range.from, range.to]);
}

// EXPL: The grammar never rejects malformed markup: an unclosed opener runs to the end of the text and a
//       repeated separator (`~>`, `@@`) ends the node early. Both used to become ranges whose brackets were
//       real text, so unwrapping or rejecting them chopped characters off the note.
describe("unclosed openers", () => {
	test("are not ranges", () => {
		for (const doc of ["{++open", "{--open\n\nmore", "{~~a~>b", "{>>open", "{==open", "{++x--}", "{++", "{++}"])
			expect(rangesOf(doc), doc).toEqual([]);
	});

	test("do not swallow the ranges after them", () => {
		expect(spans("Keep {++this\n\nand the rest {--gone--}")).toEqual([[SuggestionType.DELETION, 27, 37]]);
		expect(spans("{++a {~~b~>c~~} d")).toEqual([[SuggestionType.SUBSTITUTION, 5, 15]]);
		expect(spans("{++a++} {--b {==c==}")).toEqual([
			[SuggestionType.ADDITION, 0, 7],
			[SuggestionType.HIGHLIGHT, 13, 20],
		]);
	});

	test("ranges found after one keep their reply threads", () => {
		const ranges = rangesOf("{++a {==b==}{>>c<<}");
		expect(ranges.map(range => range.type)).toEqual([SuggestionType.HIGHLIGHT, SuggestionType.COMMENT]);
		expect(ranges[0].replies).toEqual([ranges[1]]);
	});
});

describe("repeated separators", () => {
	test("a substitution with two `~>` splits at the first and ends at `~~}`", () => {
		const [range] = rangesOf("a {~~x~>y~>z~~} b") as SubstitutionRange[];
		expect([range.from, range.middle, range.to]).toEqual([2, 6, 15]);
		expect(range.reject()).toBe("x");
		expect(range.accept()).toBe("y~>z");
	});

	test("ranges after it are still found", () => {
		expect(spans("{~~a~>b~>c~~} {++d++}")).toEqual([
			[SuggestionType.SUBSTITUTION, 0, 13],
			[SuggestionType.ADDITION, 14, 21],
		]);
	});

	test("a repeated `@@` belongs to the content, not the metadata", () => {
		const [range] = rangesOf(`{++{"author":"A"}@@a@@b++}`, true);
		expect(range.to).toBe(26);
		expect(range.fields.author).toBe("A");
		expect(range.unwrap()).toBe("a@@b");
	});
});

describe("editing", () => {
	test("typing an opener does not turn the rest of the note into a range", () => {
		let state = createRangeState("one {--two--} three");
		state = state.update({ changes: { from: 0, insert: "{++" } }).state;
		const ranges = state.field(rangeParser).ranges.ranges;
		expect(ranges.map(range => [range.type, range.from, range.to])).toEqual([[SuggestionType.DELETION, 7, 16]]);
	});
});

describe("trailing attribute blocks", () => {
	const meta = (doc: string) => rangesOf(doc, true);

	test("extend the range and become its fields", () => {
		const doc = `a {++new++}{author="Bea" time=5} b`;
		const [range] = meta(doc);
		expect([range.from, range.closer_to, range.to]).toEqual([2, 11, doc.indexOf(" b")]);
		expect(range.meta).toEqual({ syntax: "attributes", from: 11, to: doc.indexOf(" b") });
		expect(range.fields).toEqual({ author: "Bea", time: 5 });
		expect(range.unwrap()).toBe("new");
		expect(range.text).toBe("{++new++}");
	});

	test("are not read when metadata is disabled", () => {
		const [range] = rangesOf(`{++new++}{author=Bea}`, false);
		expect(range.to).toBe(9);
		expect(range.meta).toBeUndefined();
	});

	test("keep a highlight and its comment adjacent, so the comment is a reply", () => {
		const doc = `{==some==}{>>note<<}{author=Andrew time=1}`;
		const [highlight, comment] = meta(doc);
		expect(comment.base_range).toBe(highlight);
		expect(highlight.replies).toEqual([comment]);
	});

	test("chain through a thread", () => {
		const doc = `{==x==}{done=true}{>>c<<}{author=A}{>>r<<}{author=B}`;
		const ranges = meta(doc);
		expect(ranges.map(r => r.type)).toEqual([
			SuggestionType.HIGHLIGHT,
			SuggestionType.COMMENT,
			SuggestionType.COMMENT,
		]);
		expect(ranges[0].replies.length).toBe(2);
		expect(ranges[0].own_fields).toEqual({ done: true });
	});

	test("a substitution keeps its separator", () => {
		const [range] = meta(`{~~old~>new~~}{author=A}`) as SubstitutionRange[];
		expect(range.unwrap_parts()).toEqual(["old", "new"]);
		expect(range.closer_to).toBe(14);
	});

	test("a range with legacy metadata does not take a trailing block", () => {
		const doc = `{=={"author":"A"}@@t==}{author=B}`;
		const [range] = meta(doc);
		expect(range.meta!.syntax).toBe("legacy");
		expect(range.to).toBe(doc.indexOf("{author=B}"));
	});

	test("an invalid block is ordinary text", () => {
		for (const doc of ["{++a++}{}", "{++a++}{author}", "{++a++}{.c a=1}", "{++a++} {a=1}"]) {
			const [range] = meta(doc);
			expect(range.to).toBe(7);
			expect(range.meta).toBeUndefined();
		}
	});

	// EXPL: Spec pre-fork caveat. The grammar scans the block's text and can open a range inside a quoted value;
	//       the parser re-parses after the block instead of trusting that node.
	test("an opener inside a quoted value is not a range", () => {
		const doc = `{++a++}{author="{++x"} after {--gone--}`;
		const ranges = meta(doc);
		expect(ranges.map(r => [r.type, r.from])).toEqual([
			[SuggestionType.ADDITION, 0],
			[SuggestionType.DELETION, doc.indexOf("{--")],
		]);
		expect(ranges[0].fields).toEqual({ author: "{++x" });
	});

	// EXPL: Decision 5 in the plan. Literal `{k=v}` prose directly after a range reads as that range's metadata.
	//       Documented limitation, pinned so a change to it is deliberate.
	test("literal {k=v} right after a range is read as metadata", () => {
		const [range] = meta(`{++a++}{width=3} px`);
		expect(range.fields).toEqual({ width: 3 });
	});

	// EXPL: The block lies past the grammar node, so the incremental parser must reach it on its own.
	test("an edit inside a block re-creates the range that owns it", () => {
		let state = createRangeState(`x {++a++}{author=A} y`);
		const [before] = state.field(rangeParser).ranges.ranges;
		state = state.update({ changes: { from: 17, to: 18, insert: "Bea" } }).state;
		const ranges = state.field(rangeParser).ranges.ranges;
		expect(ranges.length).toBe(1);
		expect(ranges[0]).not.toBe(before);
		expect([ranges[0].from, ranges[0].to]).toEqual([2, 21]);
		expect(ranges[0].fields).toEqual({ author: "Bea" });
	});

	test("an edit that makes the text after a range a valid block grows the range", () => {
		let state = createRangeState(`{++a++}{k=1 x} y`);
		expect(state.field(rangeParser).ranges.ranges.map(r => r.to)).toEqual([7]);
		state = state.update({ changes: { from: 11, to: 13, insert: "" } }).state;
		const ranges = state.field(rangeParser).ranges.ranges;
		expect(ranges.map(r => [r.from, r.to])).toEqual([[0, 12]]);
		expect(ranges[0].fields).toEqual({ k: 1 });
	});

	// EXPL: Review fix round 1. Incremental regeneration started at the edit, so the grammar's misread node inside
	//       a quoted value was met without the block's owner before it, and became a range.
	test("typing after a block that quotes an opener does not create a range inside the block", () => {
		const doc = `{++a++}{author="{++x"} after {++b++} end`;
		let state = createRangeState(doc);
		state = state.update({ changes: { from: doc.indexOf("fter"), insert: "z" } }).state;
		const ranges = state.field(rangeParser).ranges.ranges;
		expect(ranges.map(r => [r.type, r.from, r.to])).toEqual([
			[SuggestionType.ADDITION, 0, 22],
			[SuggestionType.ADDITION, 30, 37],
		]);
	});

	test("a block that becomes valid swallows a range quoted inside it", () => {
		const doc = `{++a++}{k="{>>x<<}" y} tail`;
		let state = createRangeState(doc);
		state = state.update({ changes: { from: doc.indexOf(" y"), to: doc.indexOf("}", doc.indexOf(" y")) } })
			.state;
		const ranges = state.field(rangeParser).ranges.ranges;
		expect(ranges.map(r => [r.type, r.from, r.to])).toEqual([[SuggestionType.ADDITION, 0, 20]]);
		expect(ranges[0].fields).toEqual({ k: "{>>x<<}" });
	});

	test("accept and reject replace the whole span, block included", () => {
		const doc = `a{++b++}{author=A}c{--d--}{author=B}e{~~f~>g~~}{author=C}h`;
		const ranges = meta(doc);
		const apply = (fn: (r: typeof ranges[0]) => string) => applyToText(doc, fn, ranges);
		expect(apply(r => r.accept())).toBe("abceg" + "h");
		expect(apply(r => r.reject())).toBe("acdefh");
	});
});
