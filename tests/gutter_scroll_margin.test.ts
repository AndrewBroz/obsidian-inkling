import { AnnotationGutterView } from "../src/editor/renderers/gutters/annotations-gutter/annotation-gutter";
import { gutterScrollMargin, type GutterSide, GutterView } from "../src/editor/renderers/gutters/base";
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

// EXPL: `side` is a claim; `insertGutters` is the behaviour that actually places the DOM. The
//       bug this whole file guards against was precisely those two disagreeing — the
//       annotations gutter inserts itself *after* contentDOM but had declared `side: "before"`,
//       so the scroll margin above got computed for the wrong edge. Asserting `static side`
//       against a literal (as this block used to) can never catch that: it doesn't touch
//       `insertGutters` at all. So instead we run the real `insertGutters` against a stub DOM
//       tree and derive the OBSERVED side from where the node actually lands, then compare
//       that to the DECLARED `static side`.
function observedSide(insertGutters: GutterView["insertGutters"], dom: HTMLElement): GutterSide {
	const parent = document.createElement("div");
	const contentDOM = document.createElement("div");
	parent.appendChild(contentDOM);
	insertGutters.call(
		{ dom } as unknown as GutterView,
		{ contentDOM } as unknown as Parameters<GutterView["insertGutters"]>[0],
	);
	// EXPL: DOCUMENT_POSITION_FOLLOWING means contentDOM comes *after* dom in the parent's
	//       child order, i.e. dom landed before contentDOM.
	return dom.compareDocumentPosition(contentDOM) & Node.DOCUMENT_POSITION_FOLLOWING ? "before" : "after";
}

describe("declared gutter sides", () => {
	test("the base gutter's declared side matches where insertGutters places its DOM", () => {
		const dom = document.createElement("div");
		expect(observedSide(GutterView.prototype.insertGutters, dom)).toBe(GutterView.side);
	});

	test("the diff gutter (inherits insertGutters) declared side matches placement", () => {
		const dom = document.createElement("div");
		expect(observedSide(DiffGutterView.prototype.insertGutters, dom)).toBe(DiffGutterView.side);
	});

	test("the annotations gutter's declared side matches where its insertGutters places its DOM", () => {
		const dom = document.createElement("div");
		expect(observedSide(AnnotationGutterView.prototype.insertGutters, dom)).toBe(AnnotationGutterView.side);
	});
});
