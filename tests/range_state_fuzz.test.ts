import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import { SubstitutionRange } from "../src/editor/base/ranges";
import { createRangeState } from "./helpers";

// EXPL: Fuzz guard for the interval tree's `max` augmentation (see range_state_tree.test.ts and
//       .superpowers/sdd/task-4b-report.md). Random CriticMarkup documents x random edit sequences; after
//       every edit we assert the invariant this task restored: NO two DISTINCT range objects occupy the
//       same [from, to). That is exactly the signature of a stale-`max` search dropping a range that then
//       gets regenerated, and it is what Accept All composes into overlapping, document-corrupting changes.
//
//       Deterministic (seeded PRNG) so a failure is reproducible. On the broken `visitNode` this reported
//       37/1000 duplicate-range sequences; the fix takes it to 0. (A separate, pre-existing "stale range
//       at a NON-coincident position" class -- Task 3b's KNOWN RESIDUAL -- is unaffected by `max` and out
//       of scope here; it is measured and characterised in the task report, not asserted on.)

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

const SEGMENTS = [
	"{==highlight==}",
	"{====}", // empty highlight
	"{==meta==}{>>{\"color\":\"red\"}<<}", // metadata highlight
	"{>>comment<<}",
	"{>><<}", // empty comment
	"{++added++}",
	"{--removed--}",
	"{~~old~>new~~}",
	"{~~~>ins~~}", // empty-deletion substitution
	" plain text ",
	" one ",
	" two words ",
	"{++added++}{author=A time=1}",
	"{==x==}{>>c<<}{author=\"B b\" time=2}",
	"{~~o~>n~~}{done=true}",
	"{++a++}{author=\"{++x\"}", // quoted opener
	"{==q==}{k=\"{>>x<<}\" time=3}", // quoted range
];

const INSERTS = ["z", "x", "ab", " ", "qq", "}", "{a=1}", "="];

const SEQUENCES = 1000;
const EDITS_PER_SEQUENCE = 6;

/** True if two DISTINCT range objects share one [from, to). */
function hasDuplicatePosition(state: ReturnType<typeof createRangeState>): boolean {
	const seen = new Map<string, unknown>();
	for (const range of state.field(rangeParser).ranges.ranges) {
		const key = `${range.from},${range.to}`;
		const previous = seen.get(key);
		if (previous !== undefined && previous !== range) return true;
		seen.set(key, range);
	}
	return false;
}

describe("fuzz: interval tree never leaves two range objects at one position", () => {
	test(`${SEQUENCES} random documents x ${EDITS_PER_SEQUENCE}-edit sequences`, () => {
		const rng = mulberry32(0xC0FFEE);
		const pick = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)];

		let duplicate_failures = 0;
		let throws = 0;
		const examples: string[] = [];

		for (let seq = 0; seq < SEQUENCES; seq++) {
			// 8-16 segments: a tree deep enough that a stale `max` actually prunes a live subtree.
			const n = 8 + Math.floor(rng() * 9);
			let doc = "";
			for (let i = 0; i < n; i++) doc += pick(SEGMENTS);

			const edits: { from: number; to: number; insert: string }[] = [];
			let failed = false;
			try {
				let state = createRangeState(doc);
				for (let e = 0; e < EDITS_PER_SEQUENCE; e++) {
					const len = state.doc.length;
					const from = Math.floor(rng() * (len + 1));
					const is_insert = rng() < 0.7;
					const to = is_insert ? from : Math.min(len, from + 1 + Math.floor(rng() * 4));
					const insert = is_insert ? pick(INSERTS) : "";
					edits.push({ from, to, insert });
					state = state.update({ changes: { from, to, insert } }).state;
					if (hasDuplicatePosition(state)) {
						failed = true;
						break;
					}
				}
			} catch (error) {
				throws++;
				failed = true;
			}

			if (failed) {
				duplicate_failures++;
				if (examples.length < 3) examples.push(`doc=${JSON.stringify(doc)} edits=${JSON.stringify(edits)}`);
			}
		}

		if (duplicate_failures) {
			console.log(`duplicate-range failures ${duplicate_failures}/${SEQUENCES} (throws: ${throws})`);
			for (const example of examples) console.log("  example: " + example);
		}

		expect(duplicate_failures).toBe(0);
		expect(throws).toBe(0);
	});
});

// EXPL: Review focus 1. The incremental parser must agree with a fresh parse after every edit, including edits
//       inside, at the edge of, and right after an attribute block, which lies past the grammar node.
//       Edits never touch a CriticMarkup bracket token (opener, closer, `~>`): breaking one produces malformed
//       markup, where the incremental parse diverges from a full one for a pre-existing reason unrelated to
//       attribute blocks (a malformed node stretched to the next closer keeps stale ranges nested inside it;
//       see .superpowers/sdd/2026-10-16-inklingmarkup-metadata-attributes/task-3-report.md). Edits inside and
//       around blocks are unrestricted, which is what this oracle is for.
const MAX_REROLLS = 50;

/** The bracket tokens of every range in `doc`, as [from, to) spans. */
function bracketTokens(doc: string): [number, number][] {
	const tokens: [number, number][] = [];
	for (const range of getRangesInText(doc, { ...DEFAULT_SETTINGS })) {
		tokens.push([range.from, range.from + 3], [range.closer_to - 3, range.closer_to]);
		if (range instanceof SubstitutionRange) tokens.push([range.middle, range.middle + 2]);
	}
	return tokens;
}

/** True if the edit inserts strictly inside a bracket token, or deletes any part of one. */
function touchesBracket(tokens: [number, number][], from: number, to: number): boolean {
	return tokens.some(([start, end]) => from === to ? start < from && from < end : from < end && start < to);
}

describe("fuzz: incremental parse equals a full parse", () => {
	test("for random edits over documents with attribute blocks", () => {
		const rng = mulberry32(0xB10C);
		const pick = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
		const spans = (ranges: { from: number; to: number; type: unknown }[]) =>
			JSON.stringify(ranges.map(r => [r.type, r.from, r.to]));
		const failures: string[] = [];
		for (let seq = 0; seq < 500 && failures.length < 3; seq++) {
			const initial = Array.from({ length: 6 + Math.floor(rng() * 6) }, () => pick(SEGMENTS)).join("");
			let state = createRangeState(initial);
			const edits: { from: number; to: number; insert: string }[] = [];
			for (let i = 0; i < EDITS_PER_SEQUENCE; i++) {
				const tokens = bracketTokens(state.doc.toString());
				let edit: { from: number; to: number; insert: string } | undefined;
				for (let roll = 0; roll < MAX_REROLLS && !edit; roll++) {
					const from = Math.floor(rng() * (state.doc.length + 1));
					const is_insert = rng() < 0.7;
					const to = is_insert ? from : Math.min(state.doc.length, from + 1 + Math.floor(rng() * 4));
					const insert = is_insert ? pick(INSERTS) : "";
					if (!touchesBracket(tokens, from, to)) edit = { from, to, insert };
				}
				if (!edit) break;
				edits.push(edit);
				state = state.update({ changes: edit }).state;
				const doc = state.doc.toString();
				const incremental = spans(state.field(rangeParser).ranges.ranges);
				const full = spans(getRangesInText(doc, { ...DEFAULT_SETTINGS }));
				if (incremental !== full) {
					failures.push(
						`initial=${JSON.stringify(initial)} edits=${JSON.stringify(edits)}\n`
							+ `doc=${JSON.stringify(doc)}\nincremental=${incremental}\nfull=${full}`,
					);
					break;
				}
			}
		}
		expect(failures).toEqual([]);
	});
});
