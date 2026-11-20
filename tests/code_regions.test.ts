import { EditorState } from "@codemirror/state";

import { findCodeRegions, inCodeContent, inCodeRegion, regionsPreserved } from "../src/editor/base/edit-util/code-regions";

describe("findCodeRegions", () => {
	test("backtick fence", () => {
		expect(findCodeRegions("a\n```\nx\n```\nb")).toEqual([{
			from: 2,
			to: 11,
			head_end: 5,
			inner_from: 6,
			inner_to: 8,
		}]);
	});

	test("tilde fence and info string", () => {
		const t = "~~~js\nx\n~~~";
		expect(findCodeRegions(t)).toEqual([{ from: 0, to: t.length, head_end: 5, inner_from: 6, inner_to: 8 }]);
	});

	test("longer closer closes, shorter does not", () => {
		const t = "````\n```\n````";
		expect(findCodeRegions(t)).toEqual([{ from: 0, to: t.length, head_end: 4, inner_from: 5, inner_to: 9 }]);
	});

	test("different char does not close", () => {
		const t = "```\n~~~\n```";
		expect(findCodeRegions(t)).toEqual([{ from: 0, to: t.length, head_end: 3, inner_from: 4, inner_to: 8 }]);
	});

	test("4-space indent is not a fence", () => {
		expect(findCodeRegions("    ```\nx")).toEqual([]);
	});

	test("fence in blockquote/callout", () => {
		const t = "> [!note]\n> ```\n> {++x++}\n> ```";
		expect(findCodeRegions(t)).toEqual([{ from: 10, to: t.length, head_end: 15, inner_from: 16, inner_to: 26 }]);
	});

	test("unclosed fence runs to end", () => {
		const t = "a\n```\n{++x++}";
		expect(findCodeRegions(t)).toEqual([{ from: 2, to: t.length, head_end: 5, inner_from: 6, inner_to: t.length }]);
	});

	test.each(["++}", "--}", "==}", "~~}"])("closing fence may carry a CriticMarkup closer %s", (closer) => {
		const open = "{" + closer.slice(0, 2);
		const t = `${open}\`\`\`\nx\n\`\`\`${closer}\nafter`;
		const regions = findCodeRegions(t);
		expect(regions).toEqual([{ from: 3, to: t.indexOf("\nafter"), head_end: 6, inner_from: 7, inner_to: 9 }]);
		expect(inCodeRegion(regions, 0)).toBeUndefined();
	});

	test("text after a closing fence's CriticMarkup closer is outside the region", () => {
		const t = "{++```\nx\n```++} {--d--}";
		const regions = findCodeRegions(t);
		expect(regions).toEqual([{ from: 3, to: t.indexOf(" {--"), head_end: 6, inner_from: 7, inner_to: 9 }]);
		expect(inCodeRegion(regions, t.indexOf("{--"))).toBeUndefined();
	});

	test("range prefix after a quote marker stays outside the region", () => {
		const t = "> {++```\n> x\n> ```++}";
		const regions = findCodeRegions(t);
		expect(regions).toEqual([{ from: 5, to: t.length, head_end: 8, inner_from: 9, inner_to: 13 }]);
		expect(inCodeRegion(regions, 2)).toBeUndefined();
	});

	test.each([
		["{++", "++}"],
		["{--", "--}"],
		["{~~", "~~}"],
		["{==", "==}"],
		["{>>", "<<}"],
	])("closing fence may carry a trailing range opener %s closed later", (opener, closer) => {
		const t = `\`\`\`\nx\n\`\`\`${opener}\nmore${closer}`;
		const regions = findCodeRegions(t);
		expect(regions).toEqual([{ from: 0, to: 9, head_end: 3, inner_from: 4, inner_to: 6 }]);
		expect(inCodeRegion(regions, 9)).toBeUndefined();
	});

	test("a trailing opener with no closer before the next fence line does not close", () => {
		const t = "```\n```{==\nx\n```";
		expect(findCodeRegions(t)).toEqual([{ from: 0, to: t.length, head_end: 3, inner_from: 4, inner_to: 13 }]);
		const unclosed = "```\nx\n```{++\nmore";
		expect(findCodeRegions(unclosed)).toEqual([{
			from: 0,
			to: unclosed.length,
			head_end: 3,
			inner_from: 4,
			inner_to: unclosed.length,
		}]);
	});

	test("a trailing opener closed on the same line closes", () => {
		expect(findCodeRegions("```\nx\n```{>><<}")[0]).toMatchObject({ from: 0, to: 9 });
	});

	test("a closing fence without a range prefix may still carry a closer and a tail", () => {
		const t = "```\nx\n```++} tail";
		expect(findCodeRegions(t)).toEqual([{ from: 0, to: 12, head_end: 3, inner_from: 4, inner_to: 6 }]);
	});

	test.each([
		[">  ```\n>  {++x++}\n>  ```"],
		[">   ```\n>   {++x++}\n>   ```"],
		["> >  ~~~\n> >  x\n> >  ~~~"],
	])("a fence indented after a quote marker is recognised: %j", t => {
		expect(findCodeRegions(t)).toEqual([expect.objectContaining({ from: 0, to: t.length })]);
	});

	test("a quoted line indented four spaces past the marker's space is not a fence", () => {
		expect(findCodeRegions(">     ```\nx")).toEqual([]);
	});

	test("Enter at the end of a closing fence in suggest mode leaves the fence closed", () => {
		const t = "```\nx\n```{++\n++}\nafter {++y++}";
		expect(findCodeRegions(t)).toEqual([{ from: 0, to: 9, head_end: 3, inner_from: 4, inner_to: 6 }]);
	});

	test("head_end excludes a carriage return", () => {
		expect(findCodeRegions("```js\r\nx\r\n```")[0]).toMatchObject({ head_end: 5, inner_from: 7, inner_to: 10 });
	});

	test("unclosed fence on the last line has empty content at the end", () => {
		const t = "a\n```";
		expect(findCodeRegions(t)).toEqual([{ from: 2, to: 5, head_end: 5, inner_from: 5, inner_to: 5 }]);
	});

	test("inline code is not a region", () => {
		expect(findCodeRegions("`{++x++}`")).toEqual([]);
	});

	test("backtick fence info string may not contain a backtick", () => {
		expect(findCodeRegions("``` a`b\nx")).toEqual([]);
	});
});

describe("inCodeRegion", () => {
	const regions = [{ from: 2, to: 11, head_end: 5, inner_from: 6, inner_to: 8 }, {
		from: 20,
		to: 30,
		head_end: 23,
		inner_from: 24,
		inner_to: 27,
	}];
	test("boundaries", () => {
		expect(inCodeRegion(regions, 2)).toBe(regions[0]);
		expect(inCodeRegion(regions, 10)).toBe(regions[0]);
		expect(inCodeRegion(regions, 11)).toBeUndefined();
		expect(inCodeRegion(regions, 1)).toBeUndefined();
		expect(inCodeRegion(regions, 25)).toBe(regions[1]);
		expect(inCodeRegion([], 0)).toBeUndefined();
	});
});

describe("inCodeContent", () => {
	// "a\n```\nxy\n```\nb": region 2..12; content runs from 6 (after the opening line) to 9 (the closing line)
	const regions = findCodeRegions("a\n```\nxy\n```\nb");
	test("inside content", () => {
		expect(inCodeContent(regions, 6, 6)).toBe(true);
		expect(inCodeContent(regions, 6, 9)).toBe(true);
		expect(inCodeContent(regions, 9, 9)).toBe(true);
	});
	test("an insertion at the end of the opening fence line is content; a deletion there is not", () => {
		expect(inCodeContent(regions, 5, 5)).toBe(true);
		expect(inCodeContent(regions, 4, 4)).toBe(false);
		expect(inCodeContent(regions, 5, 6)).toBe(false);
		expect(inCodeContent(regions, 4, 5)).toBe(false);
	});
	test("touching a fence line is not content", () => {
		expect(inCodeContent(regions, 2, 2)).toBe(false);
		expect(inCodeContent(regions, 5, 6)).toBe(false);
		expect(inCodeContent(regions, 8, 10)).toBe(false);
		expect(inCodeContent(regions, 12, 12)).toBe(false);
		expect(inCodeContent(regions, 2, 12)).toBe(false);
		expect(inCodeContent([], 0, 0)).toBe(false);
	});
});

describe("regionsPreserved", () => {
	const DOC = "```\nab\n```\nafter";
	const preserved = (doc: string, change: { from: number; to?: number; insert?: string }) => {
		const state = EditorState.create({ doc });
		const tr = state.update({ changes: change });
		return regionsPreserved(findCodeRegions(doc), tr.changes, findCodeRegions(tr.state.doc.toString()));
	};

	test.each([
		["typing in content", { from: 5, insert: "X" }],
		["typing an info string", { from: 3, insert: "js" }],
		["Enter at the end of the opening line", { from: 3, insert: "\n" }],
		["a line above the block", { from: 0, insert: "X\n" }],
		["Enter at the end of the closing line", { from: 10, insert: "\n" }],
		["prose after the block", { from: 12, insert: "X" }],
	])("%s keeps the structure", (_, change) => {
		expect(preserved(DOC, change)).toBe(true);
	});

	test.each([
		["joining the first code line onto the opening line", { from: 3, to: 4 }],
		["joining the closing fence onto the last code line", { from: 6, to: 7 }],
		["text before the opening fence on its line", { from: 0, insert: "X" }],
		["text before the closing fence on its line", { from: 7, insert: "X" }],
		["breaking the closing fence", { from: 9, to: 10 }],
	])("%s changes the structure", (_, change) => {
		expect(preserved(DOC, change)).toBe(false);
	});

	test("deleting the closing fence of the last block unmakes it", () => {
		expect(preserved("```\nab\n```", { from: 7, to: 10 })).toBe(false);
	});

	test("removing an empty first code line keeps the structure", () => {
		expect(preserved("```\n\nab\n```", { from: 3, to: 4 })).toBe(true);
	});

	test("text appended to an unclosed block keeps it", () => {
		expect(preserved("```\nx", { from: 5, insert: "\nmore" })).toBe(true);
		expect(preserved("a\n```", { from: 5, insert: "\n" })).toBe(true);
	});
});

describe("a trailing opener on a closing fence line skips nested blocks (B1)", () => {
	test("a complete nested block between the opener and its closer", () => {
		const t = "```\nx\n```{++\nfoo\n```js\ncode\n```\nbar++}\nafter";
		expect(findCodeRegions(t).map(r => [r.from, r.to])).toEqual([[0, 9], [17, 31]]);
	});

	test("a nested fence line carrying the closer", () => {
		const t = "```\nx\n```{++\nfoo\n```++}\nafter";
		expect(findCodeRegions(t).map(r => [r.from, r.to])).toEqual([[0, 9], [17, t.length]]);
	});

	test("an unclosed nested block containing the closer", () => {
		const t = "```\nx\n```{++\nfoo\n```js\n++}\nafter";
		expect(findCodeRegions(t).map(r => [r.from, r.to])).toEqual([[0, 9], [17, t.length]]);
	});

	test("a bare fence line before the closer is the block's own closer", () => {
		const t = "```\n```{==\nx\n```\nprose {==h==}";
		expect(findCodeRegions(t).map(r => [r.from, r.to])).toEqual([[0, 16]]);
	});

	test("a range opener before a closing fence closes the block outside the range", () => {
		const t = "```\nx\n{--```--}\nafter";
		expect(findCodeRegions(t)).toEqual([{ from: 0, to: 6, head_end: 3, inner_from: 4, inner_to: 6 }]);
	});

	test("a code line starting with an opener and fence but no closer does not close", () => {
		const t = "```\n{==```\nx\n```";
		expect(findCodeRegions(t).map(r => [r.from, r.to])).toEqual([[0, t.length]]);
	});
});
