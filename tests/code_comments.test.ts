import { rangeParser } from "../src/editor/base";
import {
	code_comment_region,
	code_quote,
	code_selection,
	codeCommentLinks,
	type CodeLink,
} from "../src/editor/base/edit-util/code-comments";
import { createRangeState } from "./helpers";

const NO_META = { add_metadata: false };

function stateOf(doc: string) {
	return createRangeState(doc, NO_META, [codeCommentLinks]);
}

/** The single code region in `doc`. */
function regionOf(doc: string) {
	const state = stateOf(doc);
	return { state, region: state.field(rangeParser).code_regions[0] };
}

/** What each linked thread (by its base comment's text) is linked to, with targets given as text. */
function links(doc: string) {
	const state = stateOf(doc);
	const out: Record<string, string> = {};
	for (const [base, link] of state.field(codeCommentLinks) as Map<{ text: string; from: number }, CodeLink>) {
		const target = typeof link.target === "string" ?
			link.target :
			`[${doc.slice(link.target.from, link.target.to)}]@${link.target.from}`;
		out[base.text] = `${doc.slice(link.region.from, link.region.to).split("\n")[0]} -> ${target}`;
	}
	return out;
}

describe("the fields a comment on code remembers", () => {
	const doc = "intro\n```js\nlet x = 1\nlet y = 2\n```\nafter";

	function fields(from: number, to: number) {
		const { state, region } = regionOf(doc);
		return code_quote(state.doc, region, code_selection(state.doc, region, from, to));
	}

	test("a selection within one line remembers the exact selection and its line", () => {
		const from = doc.indexOf("x = 1");
		expect(fields(from, from + 5)).toEqual({ quote: "x = 1", line: 1 });
	});

	test("a selection on the second line remembers line 2", () => {
		const from = doc.indexOf("let y");
		expect(fields(from, from + 9)).toEqual({ quote: "let y = 2", line: 2 });
	});

	test("a multi-line selection remembers the selected part of its first line, and how many lines", () => {
		const from = doc.indexOf("x = 1"), to = doc.indexOf("y =") + 1;
		expect(fields(from, to)).toEqual({ quote: "x = 1", line: 1, lines: 2 });
	});

	test("no selection means the whole block: nothing is remembered", () => {
		const at = doc.indexOf("x = 1");
		expect(fields(at, at)).toEqual({});
	});

	test("a selection reaching onto the fences is kept to the code lines", () => {
		// From the start of the opening fence to the end of the closing fence: both code lines.
		expect(fields(doc.indexOf("```js"), doc.lastIndexOf("```") + 3)).toEqual({
			quote: "let x = 1",
			line: 1,
			lines: 2,
		});
	});

	test("a selection from prose into the block keeps only its code part", () => {
		expect(fields(0, doc.indexOf(" = 1"))).toEqual({ quote: "let x", line: 1 });
	});

	test("line breaks at either end of a selection are not counted as lines", () => {
		// From the end of line 1 (just before its line break) to the start of the closing fence.
		const from = doc.indexOf("\nlet y"), to = doc.lastIndexOf("```");
		expect(fields(from, to)).toEqual({ quote: "let y = 2", line: 2 });
	});

	test("a selection of only fence text is about the whole block", () => {
		expect(fields(doc.indexOf("```js"), doc.indexOf("```js") + 5)).toEqual({});
	});

	test("an empty block is commented on as a whole", () => {
		const empty = "```\n```";
		const { state, region } = regionOf(empty);
		expect(code_quote(state.doc, region, code_selection(state.doc, region, 0, empty.length))).toEqual({});
	});
});

describe("which block a new comment is about", () => {
	const doc = "a\n```\nx\n```\nb\n~~~\ny\n~~~\nc";

	test.each([
		["a cursor in the first block", doc.indexOf("x"), doc.indexOf("x"), 0],
		["a cursor in the second block", doc.indexOf("y"), doc.indexOf("y"), 1],
		["a selection from prose into the second block", doc.indexOf("b"), doc.indexOf("y"), 1],
		["a selection from the first block into prose", doc.indexOf("x"), doc.indexOf("b"), 0],
		["a selection spanning both blocks takes the block it starts in", doc.indexOf("x"), doc.indexOf("y"), 0],
	])("%s", (_, from, to, index) => {
		const state = stateOf(doc);
		const regions = state.field(rangeParser).code_regions;
		expect(code_comment_region(regions, from, to)).toBe(regions[index]);
	});

	test("prose is not about any block", () => {
		const state = stateOf(doc);
		expect(code_comment_region(state.field(rangeParser).code_regions, 0, 1)).toBeUndefined();
	});
});

describe("which comments belong to a block", () => {
	test("a comment on the line directly after the closing fence belongs to the block", () => {
		expect(links("```js\nlet x = 1\n```\n{>>why?<<}{quote=\"x = 1\" line=1}")).toEqual({
			"{>>why?<<}": "```js -> [x = 1]@10",
		});
	});

	test("a comment with no quote is about the whole block", () => {
		expect(links("```\nx\n```\n{>>all<<}")).toEqual({ "{>>all<<}": "``` -> block" });
	});

	test("replies attach as usual: the thread belongs to the block once, by its first comment", () => {
		expect(links("```\nx\n```\n{>>a<<}{>>reply<<}")).toEqual({ "{>>a<<}": "``` -> block" });
	});

	test("several threads on that line, separated by spaces, all belong to the block", () => {
		expect(links("```\nx\ny\n```\n{>>a<<}{quote=x line=1} {>>b<<}{quote=y line=2}")).toEqual({
			"{>>a<<}": "``` -> [x]@4",
			"{>>b<<}": "``` -> [y]@6",
		});
	});

	test("a blank line between the fence and the comment breaks the link", () => {
		expect(links("```\nx\n```\n\n{>>a<<}")).toEqual({});
	});

	test("other text between the fence and the comment breaks the link", () => {
		expect(links("```\nx\n```\nsee {>>a<<}")).toEqual({});
		expect(links("```\nx\n```\nsee\n{>>a<<}")).toEqual({});
	});

	test("a comment after an opening fence, or inside the block, belongs to nothing", () => {
		expect(links("```\n{>>a<<}\n```")).toEqual({});
	});

	test("a highlight's comment is not a comment on the block", () => {
		expect(links("```\nx\n```\n{==text==}{>>a<<}")).toEqual({});
	});

	test("a block in a quote takes the comment on its next quoted line", () => {
		expect(links("> ```\n> x\n> ```\n> {>>a<<}{quote=x line=1}")).toEqual({ "{>>a<<}": "> ``` -> [x]@8" });
	});

	test("an unclosed block has no comments", () => {
		expect(links("```\nx\n{>>a<<}")).toEqual({});
	});
});

describe("finding the quoted code", () => {
	test("the quote is found wherever it now is", () => {
		expect(links("```\nnew line\nlet x = 1\n```\n{>>c<<}{quote=\"x = 1\" line=1}")).toEqual({
			"{>>c<<}": "``` -> [x = 1]@17",
		});
	});

	test("with several occurrences, the one whose line is closest to the remembered line wins", () => {
		const doc = "```\nx\na\nb\nx\nc\nx\n```\n";
		const line = (n: number) => `{>>c<<}{quote=x line=${n}}`;
		// Lines: 1 x, 2 a, 3 b, 4 x, 5 c, 6 x.
		expect(links(doc + line(1))["{>>c<<}"]).toBe("``` -> [x]@4");
		expect(links(doc + line(3))["{>>c<<}"]).toBe("``` -> [x]@10");
		expect(links(doc + line(6))["{>>c<<}"]).toBe("``` -> [x]@14");
		expect(links(doc + line(9))["{>>c<<}"]).toBe("``` -> [x]@14");
	});

	test("a tie between occurrences goes to the earlier one", () => {
		expect(links("```\nx\na\nx\n```\n{>>c<<}{quote=x line=2}")["{>>c<<}"]).toBe("``` -> [x]@4");
	});

	test("several occurrences on one line: the first", () => {
		expect(links("```\nx + x\n```\n{>>c<<}{quote=x line=1}")["{>>c<<}"]).toBe("``` -> [x]@4");
	});

	test("without a remembered line, the first occurrence", () => {
		expect(links("```\na\nx\nx\n```\n{>>c<<}{quote=x}")["{>>c<<}"]).toBe("``` -> [x]@6");
	});

	test("lines > 1 highlights from the match to the end of that many lines", () => {
		expect(links("```\nlet x = 1\nlet y = 2\nz\n```\n{>>c<<}{quote=\"x = 1\" line=1 lines=2}")["{>>c<<}"])
			.toBe("``` -> [x = 1\nlet y = 2]@8");
	});

	test("lines > 1 stops at the end of the block", () => {
		expect(links("```\na\nlet x = 1\n```\n{>>c<<}{quote=\"x = 1\" line=2 lines=5}")["{>>c<<}"])
			.toBe("``` -> [x = 1]@10");
	});

	test("a quote that is no longer in the block is reported as changed", () => {
		expect(links("```\nlet x = 2\n```\n{>>c<<}{quote=\"x = 1\" line=1}")["{>>c<<}"]).toBe("``` -> changed");
	});

	test("the fence lines are not searched", () => {
		expect(links("```js\nx\n```\n{>>c<<}{quote=js}")["{>>c<<}"]).toBe("```js -> changed");
	});

	test("a quote with quotes and braces is found", () => {
		const doc = "```\nf({a: \"b\"})\n```\n" + "{>>c<<}{quote=\"\\{a: \\\"b\\\"\\}\" line=1}";
		expect(links(doc)["{>>c<<}"]).toBe("``` -> [{a: \"b\"}]@6");
	});
});

describe("the links follow the note", () => {
	test("they are recomputed when the code changes", () => {
		const doc = "```\nlet x = 1\n```\n{>>c<<}{quote=\"x = 1\" line=1}";
		const state = stateOf(doc);
		const at = doc.indexOf("1");
		const next = state.update({ changes: { from: at, to: at + 1, insert: "2" } }).state;
		const [link] = [...next.field(codeCommentLinks).values()];
		expect(link.target).toBe("changed");
	});

	test("deleting the block leaves an ordinary comment", () => {
		const doc = "```\nx\n```\n{>>c<<}{quote=x line=1}";
		const state = stateOf(doc);
		const next = state.update({ changes: { from: 0, to: doc.indexOf("{>>"), insert: "" } }).state;
		expect(next.field(codeCommentLinks).size).toBe(0);
		expect(next.field(rangeParser).ranges.ranges[0].fields).toMatchObject({ quote: "x", line: 1 });
	});

	test("inserting a blank line between the fence and the comment breaks the link", () => {
		const doc = "```\nx\n```\n{>>c<<}{quote=x line=1}";
		const state = stateOf(doc);
		expect(state.field(codeCommentLinks).size).toBe(1);
		const at = doc.indexOf("{>>");
		const next = state.update({ changes: { from: at, to: at, insert: "\n" } }).state;
		expect(next.field(codeCommentLinks).size).toBe(0);
	});
});
