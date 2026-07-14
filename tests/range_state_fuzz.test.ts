import { rangeParser } from "../src/editor/base";
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
];

const INSERTS = ["z", "x", "ab", " ", "qq"];

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
