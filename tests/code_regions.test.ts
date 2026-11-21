import { EditorState } from "@codemirror/state";

import { DEFAULT_SETTINGS } from "../src/constants";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";

import { findCodeRegions, maskCode, regionsPreserved } from "../src/editor/base/edit-util/code-regions";

const bounds = (t: string) => findCodeRegions(t).map(r => [r.from, r.to]);

describe("findCodeRegions (plain CommonMark)", () => {
	test("backtick fence", () => {
		expect(findCodeRegions("a\n```\nx\n```\nb")).toEqual([{ from: 2, to: 11, open_to: 5, close_from: 8 }]);
	});

	test("tilde fence and info string", () => {
		const t = "~~~js\nx\n~~~";
		expect(findCodeRegions(t)).toEqual([{ from: 0, to: t.length, open_to: 5, close_from: 8 }]);
	});

	test("longer closer closes, shorter does not", () => {
		const t = "````\n```\n````";
		expect(findCodeRegions(t)).toEqual([{ from: 0, to: t.length, open_to: 4, close_from: 9 }]);
	});

	test("different char does not close", () => {
		const t = "```\n~~~\n```";
		expect(findCodeRegions(t)).toEqual([{ from: 0, to: t.length, open_to: 3, close_from: 8 }]);
	});

	test("a closing fence may be followed by spaces, nothing else", () => {
		expect(bounds("```\nx\n```  \nafter")).toEqual([[0, 11]]);
		expect(bounds("```\nx\n``` y\nafter")).toEqual([[0, 17]]);
	});

	test("4-space indent is not a fence", () => {
		expect(findCodeRegions("    ```\nx")).toEqual([]);
	});

	test("fence in blockquote/callout", () => {
		const t = "> [!note]\n> ```\n> {++x++}\n> ```";
		expect(findCodeRegions(t)).toEqual([{ from: 10, to: t.length, open_to: 15, close_from: 26 }]);
	});

	test.each([
		[">  ```\n>  {++x++}\n>  ```"],
		[">   ```\n>   {++x++}\n>   ```"],
		["> >  ~~~\n> >  x\n> >  ~~~"],
		["- item\n  ```\n  c\n  ```"],
	])("a fence indented after a quote marker or in a list is recognised: %j", t => {
		expect(findCodeRegions(t)).toEqual([expect.objectContaining({ to: t.length })]);
	});

	test("a quoted line indented four spaces past the marker's space is not a fence", () => {
		expect(findCodeRegions(">     ```\nx")).toEqual([]);
	});

	test("unclosed fence runs to end", () => {
		const t = "a\n```\n{++x++}";
		expect(findCodeRegions(t)).toEqual([{ from: 2, to: t.length, open_to: 5, close_from: t.length }]);
	});

	test("unclosed fence on the last line", () => {
		expect(findCodeRegions("a\n```")).toEqual([{ from: 2, to: 5, open_to: 5, close_from: 5 }]);
	});

	test("bounds exclude a carriage return", () => {
		expect(findCodeRegions("```js\r\nx\r\n```\r\nb")).toEqual([{ from: 0, to: 13, open_to: 5, close_from: 10 }]);
	});

	test("inline code is not a region", () => {
		expect(findCodeRegions("`{++x++}`")).toEqual([]);
	});

	test("backtick fence info string may not contain a backtick", () => {
		expect(findCodeRegions("``` a`b\nx")).toEqual([]);
	});

	test("bare fences follow CommonMark", () => {
		expect(bounds("```\nx\n```\n```\ny")).toEqual([[0, 9], [10, 15]]);
	});

	test("CriticMarkup before a fence makes the line prose", () => {
		// "{++```" is prose, so the later "```++}" opens a block (its info string is "++}") that runs to the end.
		const t = "{++```\nx\n```++}\nafter";
		expect(bounds(t)).toEqual([[9, t.length]]);
		expect(findCodeRegions("> {++```\n> x")).toEqual([]);
	});

	test.each([
		["a closer after a closing fence", "```\nx\n```++}\nafter", [[0, 18]]],
		["an opener after a closing fence", "```\nx\n```{++\nmore++}", [[0, 20]]],
		["a fence wrapped in a deletion", "```\nx\n{--```--}\nafter", [[0, 21]]],
	])("%s does not close the block", (_, t, expected) => {
		expect(bounds(t)).toEqual(expected);
	});
});

describe("maskCode", () => {
	test("blanks every character in a region but line breaks", () => {
		const t = "a {++x++}\n```\n{--y--}\n```\nb";
		const masked = maskCode(t, findCodeRegions(t));
		expect(masked).toBe("a {++x++}\n   \n       \n   \nb");
		expect(masked.length).toBe(t.length);
	});

	test("markup inside code is not a range, and a closer in code does not close one outside", () => {
		const t = "{++a\n```\nb++}\n```\nc++} {==h==}";
		expect(getRangesInText(t, DEFAULT_SETTINGS).map(r => t.slice(r.from, r.to))).toEqual([
			"{++a\n```\nb++}\n```\nc++}",
			"{==h==}",
		]);
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
		["text after the closing fence on its line", { from: 10, insert: "X" }],
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

describe("findCodeRegions follows CommonMark containers (review C1)", () => {
	const texts = (t: string) => findCodeRegions(t).map(r => t.slice(r.from, r.to));
	test.each([
		["a tab-nested list", "- a\n\t- b\n\t  ```js\n\t  {++x++}\n\t  ```\n", ["\t  ```js\n\t  {++x++}\n\t  ```"]],
		["a 4-space nested list", "- a\n  - b\n    ```js\n    {++x++}\n    ```\n", ["    ```js\n    {++x++}\n    ```"]],
		["an ordered list item", "10. a\n\n    ```\n    x\n    ```\n", ["    ```\n    x\n    ```"]],
		["a fence on the list-marker line", "- ```js\n  {++x++}\n  ```\n", ["- ```js\n  {++x++}\n  ```"]],
		["a block left open in a quote ends with it", "> ```\n> x\n\nafter {++y++}", ["> ```\n> x"]],
		["a bare fence after a quoted block opens a new block", "> ```\n> x\n```\nafter {++y++}", [
			"> ```\n> x",
			"```\nafter {++y++}",
		]],
		["a block left open in a list item ends with it", "- ```\n  x\nafter", ["- ```\n  x"]],
		["a list item's blank line stays in its block", "- ```\n  x\n\n  y\n  ```", ["- ```\n  x\n\n  y\n  ```"]],
		["an indented fence in a list's paragraph is not indented code", "- a\n\n  ```\n  x\n  ```", ["  ```\n  x\n  ```"]],
		["four spaces past a list item's content is indented code", "- a\n\n      ```\n      x", []],
		["a thematic break is not a list item", "* * *\n```\nx\n```", ["```\nx\n```"]],
	])("%s", (_, t, expected) => {
		expect(texts(t)).toEqual(expected);
	});

	test("an unclosed block ending with its container", () => {
		expect(findCodeRegions("> ```\n> x\n\nafter")).toEqual([{ from: 0, to: 9, open_to: 5, close_from: 9 }]);
	});
});
