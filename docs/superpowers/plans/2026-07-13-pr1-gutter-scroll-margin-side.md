# PR1: Gutter scroll-margin side (comment pill dead zone) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each gutter declare a scroll margin on the side it actually renders on, so the right-hand annotations gutter stops hiding the add-comment pill near the left edge of the text.

**Architecture:** `createGutterViewPlugin` currently branches on *text direction* where it should branch on *gutter side*, so every gutter reports a `left` scroll margin in LTR — including the annotations gutter, which inserts its DOM *after* `contentDOM`. CodeMirror then treats the leftmost N pixels of text as covered by chrome and moves any tooltip anchored there to `-10000px`. The fix puts a `static side` on the `GutterView` class (co-located with the `insertGutters` override that *defines* the side, so the two cannot drift), extracts the margin math into a pure, testable function, and reads the side in the view plugin.

**Tech Stack:** TypeScript, CodeMirror 6 (`@codemirror/view`), Jest + jsdom.

## Global Constraints

- Source lives in `src/`, tests in `tests/`. Test runner: `bun test` → `jest --verbose`.
- Existing gutter code is a vendored fork of CM6's gutter (`src/editor/renderers/gutters/base.ts`); keep its `MODIFICATION:` / `EXPL:` comment conventions.
- Type-check must pass: `bun run tsc -noEmit -skipLibCheck`.
- Lint: `bun eslint src/`. Format: `bun dprint fmt` (tabs, per `dprint.json`).
- Comments explain *why*, never *what* — match the `// EXPL:` style already in these files.

## File Structure

- `src/editor/renderers/gutters/base.ts` — add `GutterSide` type, `gutterScrollMargin()` pure helper, `GutterView.side` static; make `createGutterViewPlugin` read it. *(Owns the margin math and the default side.)*
- `src/editor/renderers/gutters/annotations-gutter/annotation-gutter.ts` — declare `static side = "after"` on `AnnotationGutterView`. *(Owns the one gutter that is not on the default side.)*
- `tests/gutter_scroll_margin.test.ts` — new. *(Owns verification of the margin math and of each gutter's declared side.)*
- `tests/comment_pill.test.ts` — no change needed; the pill's own config is already correct.

- `src/editor/renderers/gutters/diffs-gutter/diff-gutter.ts` — export `DiffGutterView` (no behaviour change). *(It inherits `side = "before"`, which is already correct for it; the export exists only so a test can pin that inheritance.)*

---

### Task 1: Side-aware gutter scroll margins

**Files:**
- Modify: `src/editor/renderers/gutters/base.ts:334` (class `GutterView`), `:514-523` (`createGutterViewPlugin`)
- Modify: `src/editor/renderers/gutters/annotations-gutter/annotation-gutter.ts` (class `AnnotationGutterView`, near its `insertGutters` override at `:89-91`)
- Modify: `src/editor/renderers/gutters/diffs-gutter/diff-gutter.ts:25` (export `DiffGutterView` so the test can assert its inherited side)
- Test: `tests/gutter_scroll_margin.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export type GutterSide = "before" | "after"`
  - `export function gutterScrollMargin(side: GutterSide, ltr: boolean, width: number): { left: number } | { right: number }`
  - `GutterView.side: GutterSide` (static, default `"before"`)
  - `AnnotationGutterView.side === "after"`

- [ ] **Step 1: Write the failing test**

Create `tests/gutter_scroll_margin.test.ts`:

```ts
import { GutterView, type GutterSide, gutterScrollMargin } from "../src/editor/renderers/gutters/base";
import { AnnotationGutterView } from "../src/editor/renderers/gutters/annotations-gutter/annotation-gutter";
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
		expect(GutterView.side).toBe<GutterSide>("before");
	});

	test("the diff gutter inherits `before`", () => {
		expect(DiffGutterView.side).toBe<GutterSide>("before");
	});

	test("the annotations gutter declares `after` (inserted after contentDOM)", () => {
		expect(AnnotationGutterView.side).toBe<GutterSide>("after");
	});
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test tests/gutter_scroll_margin.test.ts`
Expected: FAIL — `gutterScrollMargin` is not exported from `base.ts` (TS/module resolution error), and `GutterView.side` is undefined.

- [ ] **Step 3: Add the type, the pure helper, and the static side to `base.ts`**

In `src/editor/renderers/gutters/base.ts`, add near the top of the file (above `class GutterView`):

```ts
/** Which side of the content a gutter renders on. `before` = left in LTR, `after` = right in LTR. */
export type GutterSide = "before" | "after";

/**
 * EXPL: A gutter's scroll margin must be declared on the side the gutter actually renders on.
 *       This used to branch on `textDirection` alone, which silently assumed every gutter was a
 *       `before` gutter — so the right-hand annotations gutter declared a LEFT margin. CM6 then
 *       computed `visible.left = scrollDOM.left + margins.left` and hid (top = -10000px) any
 *       tooltip anchored inside that phantom strip, which is what made the add-comment pill
 *       disappear for selections near the left edge of the text.
 */
export function gutterScrollMargin(side: GutterSide, ltr: boolean, width: number) {
	const on_left = ltr === (side === "before");
	return on_left ? { left: width } : { right: width };
}
```

Then inside `export class GutterView {` (at `:334`), add as the first member:

```ts
	// EXPL: Must agree with `insertGutters` below, which is what actually decides which side of
	//       contentDOM this gutter's DOM lands on. Subclasses that override `insertGutters` MUST
	//       override this too (see AnnotationGutterView).
	static readonly side: GutterSide = "before";
```

- [ ] **Step 4: Make `createGutterViewPlugin` read the side**

Replace `createGutterViewPlugin` (`base.ts:514-523`) in full:

```ts
export function createGutterViewPlugin<T extends GutterView>(
	cls: { new(view: EditorView): T; side: GutterSide },
) {
	return ViewPlugin.fromClass(cls, {
		provide: plugin =>
			EditorView.scrollMargins.of(view => {
				const value = view.plugin(plugin);
				if (!value || value.gutters.length == 0 || !value.fixed) return null;
				return gutterScrollMargin(cls.side, view.textDirection == Direction.LTR, value.dom.offsetWidth);
			}),
	});
}
```

- [ ] **Step 5: Declare the annotations gutter's side**

In `src/editor/renderers/gutters/annotations-gutter/annotation-gutter.ts`, add `GutterSide` to the existing import from `../base` (which already imports `createGutterViewPlugin` at `:16`), then add this static to `class AnnotationGutterView`, immediately above its `insertGutters` override (`:89`):

```ts
	// EXPL: This gutter is a Google-Docs-style comment column on the RIGHT — `insertGutters`
	//       below places it *after* contentDOM, unlike the base class which places it before.
	static readonly side: GutterSide = "after";
```

- [ ] **Step 6: Export `DiffGutterView` so its inherited side can be asserted**

In `src/editor/renderers/gutters/diffs-gutter/diff-gutter.ts:25`, change:

```ts
class DiffGutterView extends GutterView {
```

to:

```ts
export class DiffGutterView extends GutterView {
```

It declares no `side` of its own — it inherits `"before"` from `GutterView`, which is correct
for it (it uses the base `insertGutters`, placing its DOM before `contentDOM`). The test asserts
exactly that, so the inheritance can't silently break.

- [ ] **Step 7: Run the tests and verify they pass**

Run: `bun test tests/gutter_scroll_margin.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 8: Run the full suite, type-check, and lint**

Run: `bun test && bun run tsc -noEmit -skipLibCheck && bun eslint src/ && bun dprint fmt`
Expected: all existing tests still pass (the diff gutter's margin is unchanged: `before` + LTR still yields `{left}`); no type errors; no lint errors.

- [ ] **Step 9: Manually verify the bug is fixed**

Run: `bun run build:dev:hr` (builds and reloads the plugin in Obsidian).
In a vault note with the annotations gutter visible:
1. Select the **first word of a line**. Expected: the add-comment pill appears above the selection. (Before this fix: nothing appeared.)
2. Widen the annotations gutter via its resize handle, then repeat. Expected: the pill still appears. (Before this fix: a wider gutter made the dead zone wider.)
3. Select a word in the middle of a line. Expected: unchanged — pill still appears.

- [ ] **Step 10: Commit**

```bash
git add src/editor/renderers/gutters/base.ts \
        src/editor/renderers/gutters/annotations-gutter/annotation-gutter.ts \
        src/editor/renderers/gutters/diffs-gutter/diff-gutter.ts \
        tests/gutter_scroll_margin.test.ts
git commit -m "fix: gutters declare scroll margins on the side they render on

The annotations gutter renders to the RIGHT of the content (it overrides
insertGutters to insert after contentDOM), but createGutterViewPlugin
branched on text direction rather than gutter side, so it declared its
width as a LEFT scroll margin. CodeMirror derives
visible.left = scrollDOM.left + margins.left and moves any tooltip
anchored left of that offscreen (-10000px), so the add-comment pill
silently vanished for any selection within the leftmost
annotation-gutter-width pixels of the text.

Gutter side is now a static on GutterView, co-located with the
insertGutters override that defines it, and the margin math is a pure
function covering the full side/direction matrix.
"
```
