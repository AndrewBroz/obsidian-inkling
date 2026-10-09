import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
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
