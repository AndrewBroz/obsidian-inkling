import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { findCodeRegions } from "../src/editor/base/edit-util/code-regions";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import { createRangeState } from "./helpers";

// EXPL: Adversarial plain-edit fuzz for range-state's incremental parse around fenced code: after every transaction
//       (1-3 plain changes, mostly on and next to region boundaries) the ranges and code regions must equal a full
//       parse. Edits change fence lengths, swap ``` and ~~~, edit info strings, quote and indent prefixes, and write
//       CriticMarkup into fence lines (`{--```--}`, `{++` in an info string). Seeded (mulberry32).

// Obsidian global, absent under jest -- test-env artifact only.
(Math as any).clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function mulberry32(seed: number) {
	return function() {
		seed |= 0;
		seed = (seed + 0x6D2B79F5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PARTS = [
	"prose {++a++} more",
	"{--gone--} {==h==}{>>c<<}",
	"```\ncode {++x++}\n```",
	"~~~\nx\n~~~",
	"```js\nlet a;\n```",
	"````\n```\n````",
	"> ```\n> q {==w==}\n> ```",
	"- item\n  ```\n  c\n  ```",
	"```markdown\n{--```--}\n```",
	"```\nx\n{--```--}",
	"```\nx\n```{++\nfoo++}",
	"```{++\n```\n{--++}}",
	"```\n{==```==}{>>c<<}\n```",
	"",
];

const INSERTS = ["`", "~", "```", "~~~", "\n", "> ", "  ", "js", "{--", "--}", "{++", "++}", "x", "\r\n", "{", "}"];

const SEQUENCES = 1500;
const EDITS_PER_SEQUENCE = 6;

function staleState(state: ReturnType<typeof createRangeState>): boolean {
	const text = state.doc.toString();
	const field = state.field(rangeParser);
	const spans = (ranges: { type: unknown; from: number; to: number }[]) =>
		JSON.stringify(ranges.map(r => [r.type, r.from, r.to]));
	return spans(field.ranges.ranges) !== spans(getRangesInText(text, { ...DEFAULT_SETTINGS })) ||
		JSON.stringify(field.code_regions) !== JSON.stringify(findCodeRegions(text));
}

describe("fuzz: range-state stays exact under plain edits around fences", () => {
	test("CriticMarkup in an info string: appending a closer below (N6)", () => {
		let state = createRangeState("```{++\n```\n{--++}}");
		state = state.update({ changes: { from: state.doc.length, insert: "--}" } }).state;
		expect(staleState(state)).toBe(false);
	});

	test(`${SEQUENCES} documents x ${EDITS_PER_SEQUENCE} transactions`, () => {
		const rng = mulberry32(0xF3_7CE5);
		const pick = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
		let stale = 0, throws = 0, transactions = 0;
		const examples: string[] = [];

		for (let seq = 0; seq < SEQUENCES; seq++) {
			const n = 2 + Math.floor(rng() * 5);
			let doc = Array.from({ length: n }, () => pick(PARTS)).join("\n") + "\ntail {++t++}";
			if (rng() < 0.15) doc = doc.replace(/\n/g, "\r\n");
			let state = createRangeState(doc);
			const log: { from: number; to: number; insert: string }[][] = [];
			try {
				for (let e = 0; e < EDITS_PER_SEQUENCE; e++) {
					const len = state.doc.length;
					const boundaries = state.field(rangeParser).code_regions
						.flatMap(r => [r.from, r.to, r.head_end, r.inner_from, r.inner_to])
						.flatMap(b => [b - 1, b, b + 1, b + 3]);
					const position = () =>
						Math.max(
							0,
							Math.min(len, boundaries.length && rng() < 0.75 ? pick(boundaries) : Math.floor(rng() * (len + 1))),
						);
					const count = 1 + Math.floor(rng() * 3);
					const changes = Array.from({ length: count }, () => {
						const from = position();
						const is_insert = rng() < 0.65;
						const to = is_insert ? from : Math.min(len, from + 1 + Math.floor(rng() * 3));
						return { from, to, insert: is_insert ? pick(INSERTS) : "" };
					}).sort((a, b) => a.from - b.from)
						.filter((c, i, all) => i === 0 || all[i - 1].to < c.from);
					log.push(changes);
					transactions++;
					state = state.update({ changes }).state;
					if (staleState(state)) {
						stale++;
						if (examples.length < 5) examples.push(`doc=${JSON.stringify(doc)} edits=${JSON.stringify(log)}`);
						break;
					}
				}
			} catch (error) {
				throws++;
				if (examples.length < 5)
					examples.push(`throw ${error} doc=${JSON.stringify(doc)} edits=${JSON.stringify(log)}`);
			}
		}

		console.log(`range-state fence fuzz: ${transactions} transactions, ${stale} stale, ${throws} throws`);
		for (const example of examples) console.log("  example: " + example);
		expect(stale).toBe(0);
		expect(throws).toBe(0);
	});
});
