import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import { CriticMarkupRanges } from "../src/editor/base/ranges";
import { DEFAULT_SETTINGS } from "../src/constants";

// EXPL: These pin the ONE distinction the codebase never had: "beside a range" vs "inside a range".
//       Every predicate used to be closed on both ends, so a cursor touching a range's edge was
//       reported as being INSIDE it. That single lie produced the teleporting keystroke (mark.ts),
//       the comment-draft eligibility flip (add-comment.ts), and thread duplication (range-state.ts).
function rangesOf(doc: string) {
	return new CriticMarkupRanges(getRangesInText(doc, { ...DEFAULT_SETTINGS, enable_metadata: false }));
}

describe("interior vs. the edges", () => {
	//  {  =  =  h  =  =  }
	//  0  1  2  3  4  5  6  7   <- `to` is 7
	const doc = "{==h==}rest";
	const range = () => rangesOf(doc).ranges[0]!;

	test("a position at the range's own `from` is NOT interior — it is beside it", () => {
		expect(range().interior(0)).toBe(false);
		expect(range().touches(0)).toBe(true);
	});

	test("a position at the range's own `to` is NOT interior — it is beside it", () => {
		expect(range().interior(7)).toBe(false);
		expect(range().touches(7)).toBe(true);
	});

	test("a position strictly between the brackets IS interior", () => {
		expect(range().interior(3)).toBe(true); // on the content char 'h'
		expect(range().interior(1)).toBe(true); // inside the opening bracket
	});
});

describe("overlaps: sharing a character, not merely abutting", () => {
	const doc = "{==h==}rest";
	const range = () => rangesOf(doc).ranges[0]!;

	test("an interval that merely abuts the range's start does NOT overlap it", () => {
		expect(range().overlaps(0, 0)).toBe(false);
	});

	test("an interval that merely abuts the range's end does NOT overlap it", () => {
		expect(range().overlaps(7, 9)).toBe(false);
	});

	test("an interval sharing at least one character DOES overlap", () => {
		expect(range().overlaps(0, 1)).toBe(true);
		expect(range().overlaps(6, 9)).toBe(true);
	});

	test("a zero-width interval degenerates to `interior`", () => {
		// This equivalence is load-bearing: a keystroke is a zero-width insertion, and
		// `ranges_overlapping_interval(p, p)` is how mark_ranges asks "am I inside anything?"
		for (const p of [0, 1, 3, 6, 7, 8]) {
			expect(range().overlaps(p, p)).toBe(range().interior(p));
		}
	});
});

describe("ranges_overlapping_interval excludes merely-touching ranges", () => {
	test("a keystroke at position 0, before a highlight that starts at 0, is inside nothing", () => {
		const ranges = rangesOf("{==h==}rest");
		expect(ranges.ranges_in_interval(0, 0)).toHaveLength(1); // the OLD, closed query still sees it
		expect(ranges.ranges_overlapping_interval(0, 0)).toHaveLength(0); // the honest one does not
	});

	test("a keystroke strictly inside the highlight IS inside it", () => {
		const ranges = rangesOf("{==here==}");
		expect(ranges.ranges_overlapping_interval(4, 4)).toHaveLength(1);
	});

	test("an anchor ending exactly where a comment begins does not overlap it", () => {
		//  {==x==}{>>note<<}   — the comment begins exactly where the highlight ends (position 7)
		const ranges = rangesOf("{==x==}{>>note<<}");
		const comment = ranges.ranges[1]!;
		expect(ranges.ranges_overlapping_interval(comment.from, comment.from)).toHaveLength(0);
	});
});
