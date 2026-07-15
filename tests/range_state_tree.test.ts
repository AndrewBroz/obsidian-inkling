import type { EditorState } from "@codemirror/state";

import { rangeParser } from "../src/editor/base";
import { acceptSuggestions } from "../src/editor/base/edit-logic/alter-suggestion";
import { type CriticMarkupRange, SuggestionType } from "../src/editor/base/ranges";
import { createRangeState } from "./helpers";

// EXPL: The interval tree's `max` augmentation is what makes `tree.search()` correct: a subtree is
//       pruned when `left.max.high < search.low`. `range-state.ts` shifts range keys IN PLACE (a
//       deliberate optimisation -- it avoids rebuilding the tree on every keystroke), so `max` has to
//       be recomputed afterwards, BOTTOM-UP, because a node's max is defined over its own key AND both
//       of its children's maxes. When it isn't, `search()` prunes subtrees that DO contain matches and
//       silently returns incomplete results: a range that should have been removed is never found, but
//       it IS regenerated, and the document ends up with two distinct range objects at one position.
//
//       These three tests pin that, at the tree, at the range, and (the one that matters) at the text.

const DOC =
	"{++alpha++}{>>c1<<} one {++bravo++}{>>c2<<} two {++delta++}{>>c3<<} three {++echo++}{>>c4<<} four";

const PADDING = "PPPPPPPP";

/** The document after edit 1, used to locate edit 2. */
const PADDED_DOC = PADDING + DOC;

/** Edit 2 lands exactly on the `{++bravo++}` / `{>>c2<<}` boundary. */
const BOUNDARY = PADDED_DOC.indexOf("{>>c2<<}");

function padded(): EditorState {
	// EXPL: edit 1 -- eight characters at position 0. Every range in the document shifts by +8, which is
	//       what forces the in-place key shift (and the `max` recomputation) to run over the whole tree.
	return createRangeState(DOC).update({ changes: { from: 0, to: 0, insert: PADDING } }).state;
}

describe("interval tree stays searchable after in-place key shifts", () => {
	test("tree.search() returns COMPLETE results at every position", () => {
		const tree = padded().field(rangeParser).ranges.tree;
		const values = tree.values as CriticMarkupRange[];

		expect(values.length).toBe(8);

		// A search spanning the whole document must return every range.
		expect(tree.search([0, PADDED_DOC.length])).toHaveLength(values.length);

		// EXPL: This is the search `range-state.ts` itself runs on the NEXT edit, to find the ranges the
		//       edit invalidates (`search([changed_range.fromA, changed_range.toA])`). The tree's answer
		//       must agree with a brute-force scan of the very values it holds -- interval-tree intervals
		//       are CLOSED, so a range whose boundary merely touches the searched point is a match. Where
		//       it disagrees, `max` is stale and a subtree containing a match has been pruned away.
		const incomplete: string[] = [];
		for (let point = 0; point <= PADDED_DOC.length; point++) {
			const found = tree.search([point, point]) as CriticMarkupRange[];
			const expected = values.filter(range => range.from <= point && point <= range.to);
			const missed = expected.filter(range => !found.includes(range));
			if (missed.length)
				incomplete.push(`at ${point}: missed ${missed.map(range => `[${range.from},${range.to}]`).join(" ")}`);
		}

		expect(incomplete, "tree.search() pruned a subtree that contains a match").toEqual([]);
	});

	test("no two distinct range objects occupy the same position", () => {
		const state = padded().update({ changes: { from: BOUNDARY, to: BOUNDARY, insert: "z" } }).state;
		const ranges = state.field(rangeParser).ranges.ranges;

		const seen = new Map<string, CriticMarkupRange>();
		const duplicates: string[] = [];
		for (const range of ranges) {
			const key = `${range.from},${range.to}`;
			const previous = seen.get(key);
			if (previous !== undefined && previous !== range) duplicates.push(key);
			else seen.set(key, range);
		}

		expect(duplicates, "two DISTINCT range objects at the same [from, to)").toEqual([]);
	});

	test("Accept All does not duplicate text or lose the typed character", () => {
		const state = padded().update({ changes: { from: BOUNDARY, to: BOUNDARY, insert: "z" } }).state;

		// The `z` separates the addition from its comment, so the comment is no longer attached to it and
		// survives Accept All; the addition resolves to its inserted text. (Identical to what a fresh parse
		// of the same document accepts to -- verified against `createRangeState(state.doc.toString())`.)
		const accepted = state.update({ changes: acceptSuggestions(state) }).state.doc.toString();

		expect(accepted).toBe("PPPPPPPPalpha one bravoz{>>c2<<} two delta three echo four");
	});
});

describe("acceptSuggestions dedupe is independently defensive", () => {
	// EXPL: This proves the belt-and-braces claim: even if the range set upstream were STILL broken, the
	//       changes acceptSuggestions emits can never compose into overlapping (corrupting) edits. We can't
	//       revert `visitNode` from a test, so we corrupt the range set the same way a stale-`max` search
	//       would -- by hand -- and show the emitted ChangeSpecs stay disjoint and in bounds anyway.
	function poison(): { state: EditorState; addition: CriticMarkupRange } {
		const state = createRangeState("{++added++} tail");
		const addition = state.field(rangeParser).ranges.ranges
			.find(range => range.type === SuggestionType.ADDITION)!;
		return { state, addition };
	}

	function clone(range: CriticMarkupRange, from: number, to: number): CriticMarkupRange {
		const copy = Object.create(
			Object.getPrototypeOf(range),
			Object.getOwnPropertyDescriptors(range),
		) as CriticMarkupRange;
		copy.from = from;
		copy.to = to;
		return copy;
	}

	function assertDisjointInBounds(changes: { from: number; to: number }[], doc_length: number) {
		const ordered = changes.slice().sort((a, b) => a.from - b.from);
		let previous_to = 0;
		for (const change of ordered) {
			expect(change.from).toBeGreaterThanOrEqual(previous_to); // no overlap == ChangeSet.of won't compose
			expect(change.to).toBeLessThanOrEqual(doc_length); // in bounds == no RangeError
			previous_to = change.to;
		}
	}

	test("an exact-position duplicate range yields a single change", () => {
		const { state, addition } = poison();
		const list = state.field(rangeParser).ranges.ranges;
		list.push(clone(addition, addition.from, addition.to)); // the stale-`max` failure: a twin at one spot

		const changes = acceptSuggestions(state) as { from: number; to: number }[];
		expect(changes).toHaveLength(1);
		assertDisjointInBounds(changes, state.doc.length);
	});

	test("an overlapping stale range and an out-of-bounds range are dropped", () => {
		const { state, addition } = poison();
		const list = state.field(rangeParser).ranges.ranges;
		// A stale range overlaps its replacement without being equal to it...
		list.push(clone(addition, addition.from, addition.to - 2));
		// ...and a stale range can even run past the end of the document.
		list.push(clone(addition, addition.from, state.doc.length + 50));

		const changes = acceptSuggestions(state) as { from: number; to: number }[];
		expect(changes).toHaveLength(1);
		assertDisjointInBounds(changes, state.doc.length);
	});
});
