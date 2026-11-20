import { DEFAULT_SETTINGS } from "../src/constants";
import { cleanupChanges, findDebris } from "../src/editor/base/edit-logic";
import { findCodeRegions } from "../src/editor/base/edit-util/code-regions";
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
	])("template braces are not debris: %j", input => {
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
	])("ambiguous text is kept: %j", input => {
		expect(clean(input)).toEqual({ text: input, count: 0 });
	});

	test("an orphan attribute block with a quoted opener is removed whole", () => {
		expect(clean("w{author=\"{++x\"} z")).toEqual({ text: "w z", count: 1 });
	});

	test("an orphan legacy blob with a quoted opener is removed whole", () => {
		expect(clean("w{\"author\":\"{++x\"}@@ z")).toEqual({ text: "w z", count: 1 });
	});

	test("changes are expressed against the original text across passes", () => {
		// EXPL: Removing the inner `{++` (4..7) joins `{+` (2..4) and `+` (7..8) into a new opener, found on the
		//       second pass at 2..5 of the intermediate text. Mapped back, the two passes cover 2..8.
		const input = "a {+{+++ b";
		expect(cleanupChanges(input, DEFAULT_SETTINGS)).toEqual({ changes: [{ from: 2, to: 8, insert: "" }], count: 2 });
		expect(clean(input).text).toBe("a  b");
	});

	test("idempotent", () => {
		for (const input of ["a {++new text", "{++a {==b <<}", "a {+{+++ b", "w{author=A}--} {==x"]) {
			const once = clean(input);
			expect(clean(once.text)).toEqual({ text: once.text, count: 0 });
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
];

const SHAPES = {
	opener: /^\{(\+\+|--|~~|==|>>)$/,
	closer: /^(\+\+|--|~~|==|<<)\}$/,
	attributes: /^\{.*\}$/,
	legacy: /^\{.*\}@@$/,
};

describe("findDebris (property)", () => {
	test("reports only delimiters outside code and ranges; cleanup leaves nothing behind", () => {
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

			// EXPL: Output equals the input with exactly the reported spans removed (first pass), and no run
			//       after cleanup finds anything more.
			const { changes, count } = cleanupChanges(text, DEFAULT_SETTINGS);
			const once = apply(text, changes);
			const expected = apply(text, debris.map(span => ({ ...span, insert: "" })));
			if (count === debris.length) expect([context, once]).toEqual([context, expected]);
			expect([context, cleanupChanges(once, DEFAULT_SETTINGS).count]).toEqual([context, 0]);
		}
	});
});
