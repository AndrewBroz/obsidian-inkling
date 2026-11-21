import { findCodeRegions } from "../src/editor/base/edit-util/code-regions";

// EXPL: Differential test of the fence scanner against commonmark.js (the CommonMark reference implementation): random
//       documents of lines built from container prefixes (quotes, list markers, indents, tabs) and bodies (fences, text,
//       setext and thematic lines, headings, empty list items, ordered items, HTML block starts and ends), joined by
//       single line breaks, so paragraphs are interrupted and continued lazily. Both must find the same fenced code
//       blocks (as line spans). Seeded, so a failure is reproducible.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Parser } = require("commonmark") as { Parser: new() => { parse(text: string): any } };

/** Fenced code blocks as [first line, last line] (1-based), by commonmark.js. */
function reference(text: string): [number, number][] {
	const walker = new Parser().parse(text).walker();
	const blocks: [number, number][] = [];
	for (let event; (event = walker.next());) {
		if (event.entering && event.node.type === "code_block" && event.node._isFenced)
			blocks.push([event.node.sourcepos[0][0], event.node.sourcepos[1][0]]);
	}
	return blocks;
}

/** Fenced code blocks as [first line, last line] (1-based), by `findCodeRegions`. */
function scanned(text: string): [number, number][] {
	const line = (pos: number) => text.slice(0, pos).split("\n").length;
	return findCodeRegions(text).map(r => {
		// commonmark.js ends a block open at the end of the text on its last line, not the empty one after it.
		const to = r.to === text.length && text.endsWith("\n") && r.to > r.from ? r.to - 1 : r.to;
		return [line(r.from), line(Math.max(r.from, to))];
	});
}

function mulberry32(seed: number) {
	return function() {
		seed |= 0;
		seed = (seed + 0x6D2B79F5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PREFIXES = [
	"",
	"",
	"",
	"",
	"- ",
	"* ",
	"1. ",
	"2. ",
	"10. ",
	"> ",
	"  ",
	"   ",
	"    ",
	"\t",
	"- - ",
	"> - ",
	"-\t",
	"  - ",
	"\t- ",
	">\t",
	"> > ",
	" \t",
	">  ",
	"1.\t",
	"-",
	"2.",
	"1)",
];
const BODIES = [
	"```",
	"```js",
	"~~~",
	"````",
	"text",
	"text {++x++}",
	"",
	"",
	"---",
	"===",
	"# h",
	"x```",
	"  ```",
	" text",
	"    text",
	"<!--",
	"-->",
	"<!-- x -->",
	"<pre>",
	"</pre>",
	"<div>",
	"</div>",
	"<span>",
	"<a href=\"x\">",
	"<?php",
	"?>",
	"<!DOCTYPE html>",
	"<![CDATA[",
	"]]>",
	"<script>",
	"</script>",
];

describe("findCodeRegions agrees with commonmark.js", () => {
	test("hand-picked container and HTML cases", () => {
		for (
			const text of [
				"-\n\n  ```c\n  int i;\ni++}\n```\n",
				"text\n-\t\n   ```\n* ~~~\n",
				"para\n2. ```\n   code\n   ```\nfor(;;i++}\n```\n",
				"Steps:\n2. ```\n   x {++y++}\n   ```\nafter {++z++}\n",
				"<!--\n```\n-->\nafter {++y++}\n",
				"<pre>\n```\n</pre>\nafter {++y++}\n",
				"<details>\n```c\ni++}\n```\n</details>\n",
				"para\n1. ```\n   x\n   ```\n",
				"- a\n2. ```\n   x {++y++}\n   ```\nz\n",
				"*\n  ```\n  x\n  ```\n",
				"para\n*\n  ```\n  x\n  ```\n",
			]
		) {
			expect([text, scanned(text)]).toEqual([text, reference(text)]);
		}
	});

	test("20000 random documents", () => {
		const rng = mulberry32(Number(process.env.FUZZ_SEED ?? 0xC0FFEE));
		const pick = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
		const disagreements: string[] = [];
		for (let i = 0; i < 20000; i++) {
			const lines = Array.from({ length: 2 + Math.floor(rng() * 8) }, () => pick(PREFIXES) + pick(BODIES));
			const text = lines.join("\n") + (rng() < 0.5 ? "\n" : "");
			const expected = JSON.stringify(reference(text)), found = JSON.stringify(scanned(text));
			if (expected !== found) disagreements.push(`${JSON.stringify(text)} commonmark ${expected} scanner ${found}`);
		}
		if (disagreements.length) console.log(disagreements.length + "\n" + disagreements.slice(0, 10).join("\n"));
		expect(disagreements).toEqual([]);
	});
});
