import { AnnotationGutterView } from "../src/editor/renderers/gutters/annotations-gutter/annotation-gutter";
import { gutterScrollMargin, GutterView } from "../src/editor/renderers/gutters/base";
import { DiffGutterView } from "../src/editor/renderers/gutters/diffs-gutter/diff-gutter";

// EXPL: Root cause of the "add-comment pill vanishes near the left margin" bug: the gutter
//       view plugin branched on TEXT DIRECTION where it should have branched on GUTTER SIDE,
//       so the annotations gutter — which inserts its DOM *after* contentDOM, i.e. on the
//       right — declared its width as a LEFT scroll margin. CM6 derives
//       `visible.left = scrollDOM.left + margins.left` and banishes any tooltip anchored left
//       of that to -10000px (writeMeasure), producing a dead zone exactly as wide as the
//       annotations gutter. These assertions pin the side/direction matrix.
describe("gutterScrollMargin", () => {
	test("a `before` gutter margins left in LTR and right in RTL", () => {
		expect(gutterScrollMargin("before", true, 40)).toEqual({ left: 40 });
		expect(gutterScrollMargin("before", false, 40)).toEqual({ right: 40 });
	});

	test("an `after` gutter margins right in LTR and left in RTL", () => {
		expect(gutterScrollMargin("after", true, 250)).toEqual({ right: 250 });
		expect(gutterScrollMargin("after", false, 250)).toEqual({ left: 250 });
	});
});

describe("declared gutter sides", () => {
	// EXPL: `side` must agree with the class's `insertGutters` override, which is what actually
	//       decides where the DOM lands. These two assertions are the guard against that drift.
	test("the base gutter defaults to `before` (inserted before contentDOM)", () => {
		expect(GutterView.side).toBe("before");
	});

	test("the diff gutter inherits `before`", () => {
		expect(DiffGutterView.side).toBe("before");
	});

	test("the annotations gutter declares `after` (inserted after contentDOM)", () => {
		expect(AnnotationGutterView.side).toBe("after");
	});
});
