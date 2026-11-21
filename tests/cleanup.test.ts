import { DEFAULT_SETTINGS } from "../src/constants";
import { cleanupChanges, findDebris } from "../src/editor/base/edit-logic";
import { findCodeRegions } from "../src/editor/base/edit-util/code-regions";
import * as rangeParserModule from "../src/editor/base/edit-util/range-parser";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";

function apply(text: string, changes: { from: number; to: number; insert: string }[]): string {
	let out = text;
	for (const change of [...changes].sort((a, b) => b.from - a.from))
		out = out.slice(0, change.from) + change.insert + out.slice(change.to);
	return out;
}

function clean(text: string) {
	const { changes, count } = cleanupChanges(text, DEFAULT_SETTINGS);
	return { text: apply(text, changes), count };
}

describe("cleanupChanges", () => {
	test.each([
		["a {++new text", "a new text"],
		["old--} b", "old b"],
		["{~~a~>b", "a~>b"],
		["x <<} y", "x  y"],
		["word{author=Bea time=1791820000} next", "word next"],
		["word{\"author\":\"Bea\"}@@ next", "word next"],
	])("removes debris from %j", (input, expected) => {
		expect(clean(input).text).toBe(expected);
	});

	test.each([
		["# H {color=red}"],
		["x{style=a}"],
	])("lone style/color block kept: %j", input => {
		expect(clean(input)).toEqual({ text: input, count: 0 });
	});

	test("valid ranges untouched", () => {
		const input = "{==a==}{>>c<<}{author=A time=1} {++b++}";
		expect(clean(input)).toEqual({ text: input, count: 0 });
	});

	test("valid ranges' metadata untouched even with metadata parsing off", () => {
		const input = "{++b++}{author=A time=1} {++{\"author\":\"B\"}@@c++}";
		expect(cleanupChanges(input, { ...DEFAULT_SETTINGS, enable_metadata: false })).toEqual({ changes: [], count: 0 });
	});

	test("fenced code untouched", () => {
		expect(clean("```\n{++a\n```")).toEqual({ text: "```\n{++a\n```", count: 0 });
	});

	test.each([
		["{++```\nx\n```++}"],
		["```\n{++a\n```\nb++}"],
	])("a range the code rule hides is not debris: %j", input => {
		expect(clean(input)).toEqual({ text: input, count: 0 });
	});

	test("debris inside unclosed fence is kept", () => {
		expect(clean("```\n{++a")).toEqual({ text: "```\n{++a", count: 0 });
	});

	test.each([
		["{{!-- note --}}"],
		["{{- x -}}"],
		["{{-- blade --}}"],
		["{---}"],
		["{===}"],
		["{>>>}"],
	])("template braces and overlapping delimiters are not debris: %j", input => {
		expect(clean(input)).toEqual({ text: input, count: 0 });
	});

	test("multiple fragments", () => {
		expect(clean("{++a {==b <<}")).toEqual({ text: "a b ", count: 3 });
	});

	test.each([
		["a ~> b"],
		["{x=1}"],
		["{author=A extra=1}"],
		["{not attributes}"],
		["{\"author\":\"A\"} no at-signs"],
		["{[1]}@@"],
		["{\"note\":\"my precious words\"}@@"],
		["{\"x\":1}@@ in prose"],
		["{}@@ in prose"],
		["{\"style\":\"a\"}@@"],
	])("ambiguous text is kept: %j", input => {
		expect(clean(input)).toEqual({ text: input, count: 0 });
	});

	test("an orphan attribute block with a quoted opener is removed whole", () => {
		expect(clean("w{author=\"{++x\"} z")).toEqual({ text: "w z", count: 1 });
	});

	test("an orphan legacy blob with a quoted opener is removed whole", () => {
		expect(clean("w{\"author\":\"{++x\"}@@ z")).toEqual({ text: "w z", count: 1 });
	});

	test.each([
		["{+{--+ x {==y++} z==}"],
		["{+{--+ x {>>y++} z<<}"],
	])("a removal that would re-pair a valid range is dropped: %j", input => {
		expect(clean(input)).toEqual({ text: input, count: 0 });
	});

	test("a removal that would move a fenced region is dropped", () => {
		const input = "--}```\nx\n```\nkeep {==this\n";
		expect(clean(input)).toEqual({ text: input, count: 0 });
	});

	test("one unsafe removal: nothing changes, not even the safe ones", () => {
		// EXPL: Removing `{--` would pair `{++ x {==y++}`; the stray `<<}` at the end is left too.
		const input = "{+{--+ x {==y++} z==} w <<}";
		expect(clean(input)).toEqual({ text: input, count: 0 });
	});

	test.each([
		["The loss is $\\sum_{t=1}^{T} \\ell_t$"],
		["$\\sum_{a=1}^{n}$"],
		["x {a=1} y"],
		["x {t=1} y"],
	])("shorthand keys are not Inkling metadata: %j is kept", input => {
		expect(clean(input)).toEqual({ text: input, count: 0 });
	});

	test("one pass: debris exposed by a removal waits for the next run", () => {
		// EXPL: Removing the inner `{++` joins `{+` and `+` into a new opener; the next run removes it.
		const input = "a {+{+++ b";
		expect(cleanupChanges(input, DEFAULT_SETTINGS)).toEqual({ changes: [{ from: 4, to: 7, insert: "" }], count: 1 });
		expect(clean(clean(input).text)).toEqual({ text: "a  b", count: 1 });
	});

	test("adjacent removals merge into one change", () => {
		expect(cleanupChanges("a {++{author=A} b", DEFAULT_SETTINGS))
			.toEqual({ changes: [{ from: 2, to: 15, insert: "" }], count: 2 });
	});

	test("idempotent", () => {
		for (const input of ["a {++new text", "{++a {==b <<}", "w{author=A}--} {==x"]) {
			const once = clean(input);
			expect(clean(once.text)).toEqual({ text: once.text, count: 0 });
		}
	});

	test.each([
		["see `{author=A}` here"],
		["see `{++` here"],
		["see `<<}` here"],
		["see ``a ` {++`` here"],
		["> quoted `--}` code"],
	])("inline code untouched: %j", input => {
		expect(clean(input)).toEqual({ text: input, count: 0 });
	});

	test.each([
		["`{++` and {++x", "`{++` and x"],
		["{++x `{--` y--}", "x `{--` y--}"],
		["`a {++b", "`a b"],
		["`a``{++b", "`a``b"],
	])("debris outside inline code on the same line is removed: %j", (input, expected) => {
		expect(clean(input).text).toBe(expected);
	});

	test("a block right after a closer is not debris, even when the range already has metadata", () => {
		const input = "{++{\"author\":\"A\"}@@x++}{author=B}";
		expect(clean(input)).toEqual({ text: input, count: 0 });
	});

	test("a note without any candidate token is not parsed", () => {
		const parse = jest.spyOn(rangeParserModule, "getRangesInText");
		try {
			expect(cleanupChanges("plain text, `code`, a {} and } and @@ here\n".repeat(100), DEFAULT_SETTINGS))
				.toEqual({ changes: [], count: 0 });
			expect(parse).not.toHaveBeenCalled();
			expect(cleanupChanges("a {++b", DEFAULT_SETTINGS).count).toBe(1);
			expect(parse).toHaveBeenCalled();
		} finally {
			parse.mockRestore();
		}
	});
});

function mulberry32(seed: number) {
	return function() {
		seed |= 0;
		seed = (seed + 0x6D2B79F5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// EXPL: The range_state_fuzz SEGMENTS, plus truncated fragments of the kind sync leaves behind.
const SEGMENTS = [
	"{==highlight==}",
	"{====}",
	"{==meta==}{>>{\"color\":\"red\"}<<}",
	"{>>comment<<}",
	"{>><<}",
	"{++added++}",
	"{--removed--}",
	"{~~old~>new~~}",
	"{~~~>ins~~}",
	" plain text ",
	" one ",
	" two words ",
	"{++added++}{author=A time=1}",
	"{==x==}{>>c<<}{author=\"B b\" time=2}",
	"{~~o~>n~~}{done=true}",
	"{++a++}{author=\"{++x\"}",
	"{==q==}{k=\"{>>x<<}\" time=3}",
	"{++a++}{author=\"{>>x\"} after\nmore {++b++} text <<} ",
	"{++a@@b++}{author=A}",
	"{~~a@@b~>c~~}",
	"\n```\n",
	"\n~~~\n",
	"```",
	"\n> ```\n",
	"{++x",
	"y--}",
	"{author=A}",
	"{t=5 s=x}",
	"{\"author\":\"A\"}@@",
	"{~~p~>",
	"q<<}",
	"{{-- t --}}",
	"{color=red}",
	"{+{--+",
	"--}```\n",
	"{---}",
	"{\"note\":\"n\"}@@",
];

const SHAPES = {
	opener: /^\{(\+\+|--|~~|==|>>)$/,
	closer: /^(\+\+|--|~~|==|<<)\}$/,
	attributes: /^\{.*\}$/,
	legacy: /^\{.*\}@@$/,
};

describe("findDebris (property)", () => {
	test("reports only delimiters outside code and ranges; cleanup preserves every range and fenced region", () => {
		const random = mulberry32(0x13C1EA);
		for (let doc = 0; doc < 500; doc++) {
			let text = "";
			const length = 1 + Math.floor(random() * 8);
			for (let i = 0; i < length; i++) text += SEGMENTS[Math.floor(random() * SEGMENTS.length)];
			const context = `doc ${doc}: ${JSON.stringify(text)}`;

			const debris = findDebris(text, DEFAULT_SETTINGS);
			const areas = [
				...getRangesInText(text, { ...DEFAULT_SETTINGS, enable_metadata: true }, false),
				...findCodeRegions(text),
			];

			let last = 0;
			for (const span of debris) {
				const removed = text.slice(span.from, span.to);
				const ok = span.from >= last && span.to > span.from && SHAPES[span.kind].test(removed) &&
					areas.every(area => span.to <= area.from || span.from >= area.to);
				expect([context, span, ok]).toEqual([context, span, true]);
				last = span.to;
			}

			// EXPL: Every change removes reported debris only, never touches an original range or fenced region, and
			//       leaves all of them exactly as they were (so a later run cannot be fighting this one).
			const { changes, count } = cleanupChanges(text, DEFAULT_SETTINGS);
			const output = apply(text, changes);
			let removed = "";
			let kept = "";
			let last_change = 0;
			for (const change of changes) {
				const ok = change.from >= last_change && change.to > change.from && change.insert === "" &&
					areas.every(area => change.to <= area.from || change.from >= area.to) &&
					debris.some(span => span.from === change.from) && debris.some(span => span.to === change.to);
				expect([context, change, ok]).toEqual([context, change, true]);
				kept += text.slice(last_change, change.from);
				removed += text.slice(change.from, change.to);
				last_change = change.to;
			}
			kept += text.slice(last_change);
			expect([context, output]).toEqual([context, kept]);
			expect(output.length + removed.length).toBe(text.length);
			expect(count).toBeLessThanOrEqual(debris.length);

			const shapes = (doc: string) => [
				...getRangesInText(doc, { ...DEFAULT_SETTINGS, enable_metadata: true }, false)
					.map(r => `${r.type}:${doc.slice(r.from, r.to)}`),
				...findCodeRegions(doc).map(r => `code:${doc.slice(r.from, r.to)}`),
			];
			expect([context, shapes(output)]).toEqual([context, shapes(text)]);
			const again = cleanupChanges(output, DEFAULT_SETTINGS);
			if (again.count) expect([context, shapes(apply(output, again.changes))]).toEqual([context, shapes(text)]);
		}
	});
});

describe("cleanup leaves code in list and quote blocks alone (review C1)", () => {
	test.each([
		["a tab-nested list", "- list\n\t- nested\n\t  ```c\n\t  i++}\n\t  ```\n"],
		["a 4-space nested list", "- list\n  - nested\n    ```c\n    i++}\n    ```\n"],
		["a fence on the list-marker line", "- ```c\n  i++}\n  ```\n"],
		["an ordered list item", "10. a\n\n    ```c\n    i++}\n    ```\n"],
		["a block after an empty list item (re-review N2)", "-\n\n  ```c\n  int i;\ni++}\n```\n"],
		[
			"a block after a paragraph an ordered item can't interrupt (re-review N2)",
			"para\n2. ```\n   code\n   ```\nfor(;;i++}\n```\n",
		],
	])("%s", (_, text) => {
		expect(findDebris(text, DEFAULT_SETTINGS)).toEqual([]);
		expect(clean(text)).toEqual({ text, count: 0 });
	});

	test("a closer after a quoted block that ended with its quote is cleaned", () => {
		expect(clean("> ```\n> x\n\nstray ++} here").text).toBe("> ```\n> x\n\nstray  here");
	});
});
