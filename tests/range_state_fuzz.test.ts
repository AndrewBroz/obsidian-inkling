import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import { type CriticMarkupRange, SubstitutionRange } from "../src/editor/base/ranges";
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
	"{++a++}{author=\"{>>x\"} after\nmore {++b++} text <<} ", // quoted opener closed on the next line
	"{++a@@b++}{author=A}", // @@ in the content
	"{~~a@@b~>c~~}", // @@ in a substitution's content
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

type Edit = { from: number; to: number; insert: string };

/**
 * Every range's span, thread (its base and its replies, by position) and effective fields. Threads and fields are
 * compared too: a block edit can make a comment the reply of a range it never touched, so the comment, and the
 * author a highlight inherits from it, change without its span changing.
 */
function snapshot(ranges: CriticMarkupRange[]): string {
	const at = (range: CriticMarkupRange) => [range.from, range.to];
	return JSON.stringify(ranges.map(range => ({
		span: [range.type, range.from, range.to],
		base: at(range.base_range),
		replies: range.replies.map(at),
		fields: range.fields,
	})));
}

/** The incremental ranges of `state` diverge from a full parse of its text. */
function diverges(state: ReturnType<typeof createRangeState>): { incremental: string; full: string } | undefined {
	const incremental = snapshot(state.field(rangeParser).ranges.ranges);
	const full = snapshot(getRangesInText(state.doc.toString(), { ...DEFAULT_SETTINGS }));
	return incremental === full ? undefined : { incremental, full };
}

/**
 * Random edit sequences over documents with attribute blocks; after each transaction the incremental ranges must
 * equal a full parse, threads and fields included. Each transaction makes 1 to `max_edits` non-overlapping edits, none touching a bracket token.
 * @returns the first failures found (at most 3), with their reproduction.
 */
function incrementalVsFull(seed: number, max_edits: number): string[] {
	const rng = mulberry32(seed);
	const pick = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
	const failures: string[] = [];
	for (let seq = 0; seq < 500 && failures.length < 3; seq++) {
		const initial = Array.from({ length: 6 + Math.floor(rng() * 6) }, () => pick(SEGMENTS)).join("");
		let state = createRangeState(initial);
		const transactions: Edit[][] = [];
		for (let i = 0; i < EDITS_PER_SEQUENCE; i++) {
			const tokens = bracketTokens(state.doc.toString());
			const count = max_edits === 1 ? 1 : 1 + Math.floor(rng() * max_edits);
			const edits: Edit[] = [];
			for (let roll = 0; roll < MAX_REROLLS && edits.length < count; roll++) {
				const from = Math.floor(rng() * (state.doc.length + 1));
				const is_insert = rng() < 0.7;
				const to = is_insert ? from : Math.min(state.doc.length, from + 1 + Math.floor(rng() * 4));
				const insert = is_insert ? pick(INSERTS) : "";
				if (touchesBracket(tokens, from, to)) continue;
				if (edits.some(edit => from <= edit.to && edit.from <= to)) continue;
				edits.push({ from, to, insert });
			}
			if (!edits.length) break;
			transactions.push(edits);
			state = state.update({ changes: edits }).state;
			const divergence = diverges(state);
			if (divergence) {
				failures.push(
					`initial=${JSON.stringify(initial)} transactions=${JSON.stringify(transactions)}\n` +
						`doc=${JSON.stringify(state.doc.toString())}\nincremental=${divergence.incremental}\n` +
						`full=${divergence.full}`,
				);
				break;
			}
		}
	}
	return failures;
}

describe("fuzz: incremental parse equals a full parse", () => {
	test("for random edits over documents with attribute blocks", () => {
		expect(incrementalVsFull(0xB10C, 1)).toEqual([]);
	});

	// EXPL: Several changes in one transaction (multi-cursor typing, a command editing several places) are
	//       regenerated together; a range one change removed must still be seen by the others.
	test("for transactions of up to three edits", () => {
		expect(incrementalVsFull(0x4242, 3)).toEqual([]);
	});
});

// EXPL: A block typed into place can end its owner exactly where an untouched comment starts. The comment then
//       becomes the owner's reply (and a highlight owner inherits its author), though no edit touched it.
describe("a block edit that makes a range adjacent to the next comment", () => {
	test.each([
		["typing a valid block into `{}`", "{==x==}{}{>>c<<}{author=B time=2}", { from: 8, to: 8, insert: "k=1" }],
		["deleting the space that kept a block invalid", "{==x==}{k=1 }{>>c<<}{author=B time=2}", {
			from: 11,
			to: 12,
			insert: "",
		}],
	])("%s threads the comment onto the range", (_name, doc, change) => {
		const state = createRangeState(doc).update({ changes: change }).state;
		expect(diverges(state)).toBeUndefined();
		const [highlight, comment] = state.field(rangeParser).ranges.ranges;
		expect(comment.base_range).toBe(highlight);
		expect(highlight.fields.author).toBe("B");
	});

	test("making the block invalid again detaches the comment", () => {
		const state = createRangeState("{==x==}{k=1}{>>c<<}{author=B time=2}")
			.update({ changes: { from: 11, to: 11, insert: " " } }).state;
		expect(diverges(state)).toBeUndefined();
		const [highlight, comment] = state.field(rangeParser).ranges.ranges;
		expect(comment.base_range).toBe(comment);
		expect(highlight.fields.author).toBeUndefined();
	});
});
