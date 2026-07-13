import { EditorState, type Extension, StateField } from "@codemirror/state";
import { EditorView, type Tooltip } from "@codemirror/view";

import { commentDraftField, setCommentDraft } from "../src/editor/uix/extensions/comment-draft";
import { commentPill, pill_eligible } from "../src/editor/uix/extensions/comment-pill";
import { createRangeState } from "./helpers";

// EXPL: add_metadata false keeps outputs deterministic (no timestamps in the markup)
const NO_META = { add_metadata: false };

function stateWithSelection(doc: string, anchor: number, head: number, extra: Extension[] = []): EditorState {
	const state = createRangeState(doc, NO_META, extra);
	return state.update({ selection: { anchor, head } }).state;
}

describe("pill_eligible", () => {
	test("empty selection is not eligible", () => {
		const state = stateWithSelection("hello world", 3, 3);
		expect(pill_eligible(state)).toBe(false);
	});

	test("a clean, non-empty selection is eligible", () => {
		const state = stateWithSelection("hello world", 0, 5);
		expect(pill_eligible(state)).toBe(true);
	});

	test("a selection overlapping an existing range is not eligible", () => {
		const doc = "he{++llo++} world";
		// EXPL: [0,7) overlaps the addition range at [2,11)
		const state = stateWithSelection(doc, 0, 7);
		expect(pill_eligible(state)).toBe(false);
	});

	test("a selection inside a comment is not eligible", () => {
		const doc = "hello {>>note<<} world";
		const inside_start = doc.indexOf("note");
		const inside_end = inside_start + "note".length;
		const state = stateWithSelection(doc, inside_start, inside_end);
		expect(pill_eligible(state)).toBe(false);
	});

	test("a non-empty selection in a read-only state is not eligible", () => {
		const state = stateWithSelection("hello world", 0, 5, [EditorState.readOnly.of(true)]);
		expect(pill_eligible(state)).toBe(false);
	});

	// EXPL: A draft already has a card and a focused input in the gutter; leaving the pill floating
	//       over the same selection would offer to start a second comment on it.
	test("no pill while a comment draft is open", () => {
		const state = stateWithSelection("hello world", 0, 5, [commentDraftField]);
		expect(pill_eligible(state)).toBe(true);

		const drafting = state.update({ effects: setCommentDraft.of({ from: 0, to: 5 }) }).state;
		expect(pill_eligible(drafting)).toBe(false);
	});

	// EXPL: `state.field(commentDraftField, false)` — the pill must keep working in states that
	//       never installed the draft field (every other test in this file builds exactly such a
	//       bare state; `state.field(f)` would throw on them).
	test("still eligible in a state where the draft field was never installed", () => {
		const state = stateWithSelection("hello world", 0, 5);
		expect(() => pill_eligible(state)).not.toThrow();
		expect(pill_eligible(state)).toBe(true);
	});
});

// EXPL: commentPill's StateField is typed `Extension` at the export boundary (main.ts only
//       ever needs to register it), but at runtime it *is* the StateField<Tooltip | null> —
//       casting to read it back with `state.field()` lets these tests exercise the real
//       production `getCommentPillTooltip`/`createPillDom` instead of reimplementing them.
const commentPillField = commentPill as unknown as StateField<Tooltip | null>;

function tooltipFor(doc: string, anchor: number, head: number): Tooltip | null {
	const state = stateWithSelection(doc, anchor, head, [commentPill]);
	return state.field(commentPillField);
}

describe("commentPill tooltip placement config", () => {
	// EXPL: Root cause (confirmed via a Playwright repro against a real EditorView, see
	//       task-pillhover-report.md): CM6's `above: true` places the tooltip's bottom edge
	//       flush (0px) against the anchor line's top — @codemirror/view's writeMeasure() does
	//       `top = pos.top - height - arrowHeight - offset.y`, and offset.y was never set, so
	//       it defaulted to 0. A pill taller than one text line then reads as "sitting on the
	//       text". These assertions pin the exact fields that fix it.
	test("eligible selection produces a Tooltip anchored at the selection head, above, non-strict", () => {
		const doc = "hello world";
		const tooltip = tooltipFor(doc, 0, 5);
		expect(tooltip).not.toBeNull();
		expect(tooltip!.pos).toBe(5);
		expect(tooltip!.above).toBe(true);
		// EXPL: strictSide: false lets CM6 flip the pill below the selection when there's no
		//       room above (e.g. selection on the first visible line) instead of clipping it.
		expect(tooltip!.strictSide).toBe(false);
	});

	test("ineligible selection (empty, or overlapping an existing range) yields no tooltip", () => {
		expect(tooltipFor("hello world", 3, 3)).toBeNull();
		const doc = "he{++llo++} world";
		expect(tooltipFor(doc, 0, 7)).toBeNull();
	});

	test("the pill's TooltipView requests an explicit 8px vertical gap from the anchor line", () => {
		const doc = "hello world";
		const tooltip = tooltipFor(doc, 0, 5)!;
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		const view = new EditorView({ state: stateWithSelection(doc, 0, 5), parent });

		const tooltipView = tooltip.create(view);
		// EXPL: For an `above` tooltip, @codemirror/view subtracts `offset.y` a second time
		//       (`pos.top - height - offset.y`), so this is genuine clearance from the anchor
		//       line's top, not a stylistic nudge — without it the pill was flush (0px) against
		//       the text. 8px matches both Google Docs' comment-bubble convention and
		//       Obsidian's own tooltip gap constant (`bx = 8`, extracted from the shipped
		//       app.js).
		expect(tooltipView.offset).toEqual({ x: 0, y: 8 });

		view.destroy();
	});
});

describe("comment-pill button tooltip (Obsidian setTooltip)", () => {
	// EXPL: Root cause (confirmed against Obsidian's real tooltip functions, extracted from
	//       app.js inside obsidian.asar): a bare aria-label with no data-tooltip-position
	//       defaults to placement "bottom" (Ix(): `var n = "bottom"`), which renders Obsidian's
	//       black tooltip *below* the button — i.e. between the pill and the selection it's
	//       floating above, covering the text the user is about to comment on.
	function buildPillButton(): HTMLButtonElement {
		const doc = "hello world";
		const tooltip = tooltipFor(doc, 0, 5)!;
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		const view = new EditorView({ state: stateWithSelection(doc, 0, 5), parent });
		const tooltipView = tooltip.create(view);
		const button = tooltipView.dom.querySelector<HTMLButtonElement>(".cmtr-comment-pill-button");
		expect(button).not.toBeNull();
		view.destroy();
		return button!;
	}

	test("button keeps an accessible name (aria-label) via setTooltip", () => {
		const button = buildPillButton();
		expect(button.getAttribute("aria-label")).toBe("Add comment");
	});

	test("button requests top placement so the tooltip renders above the pill, not over the selection", () => {
		const button = buildPillButton();
		expect(button.getAttribute("data-tooltip-position")).toBe("top");
	});
});
