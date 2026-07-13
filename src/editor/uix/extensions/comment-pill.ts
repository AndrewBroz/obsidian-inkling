import { EditorState, type Extension, StateField } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip, type TooltipView } from "@codemirror/view";

import { setIcon, setTooltip } from "obsidian";

import { addCommentToView, rangeParser } from "../../base";

// EXPL: CM6 places an `above: true` tooltip flush against the anchor line (0px gap by
//       default: `top = pos.top - height - offset.y`, offset.y unset == 0) — confirmed by
//       tracing @codemirror/view's writeMeasure() and by a Playwright repro against a real
//       EditorView. The pill (icon + padding, ~30px) is taller than a single text line, so a
//       flush touch reads visually as "sitting on the text". PILL_GAP gives it explicit
//       clearance instead of relying on incidental 0px contact; 8px matches both Google
//       Docs' comment-bubble convention and Obsidian's own tooltip gap constant (`bx = 8` in
//       the shipped app.js, extracted from obsidian.asar and confirmed empirically).
const PILL_GAP = 8;

// EXPL: GDocs-style floating "add comment" pill. Eligibility mirrors addCommentToView's
//       wrap path (edit-logic/add-comment.ts): a non-empty selection that touches no
//       existing CriticMarkup range. A selection landing inside/overlapping a range
//       (including a comment's own content) has nowhere clean to wrap, so the pill hides
//       rather than offering an action that would fall back to a plain at-cursor comment.
export function pill_eligible(state: EditorState): boolean {
	if (state.readOnly)
		return false;

	const selection = state.selection.main;
	if (selection.empty)
		return false;

	const ranges = state.field(rangeParser).ranges;
	return ranges.ranges_in_interval(selection.from, selection.to).length === 0;
}

function createPillDom(view: EditorView): TooltipView {
	const dom = document.createElement("div");
	dom.className = "cmtr-comment-pill";

	const button = document.createElement("button");
	button.type = "button";
	button.className = "cmtr-comment-pill-button";
	// EXPL: setTooltip is Obsidian's sanctioned tooltip API (over a raw aria-label) because
	//       it also gives placement control. Obsidian's tooltip defaults to
	//       data-tooltip-position="bottom" when no placement is given (confirmed against the
	//       real Ix()/Ox() tooltip functions extracted from app.js) — since the pill itself
	//       floats above the selection, a default-bottom tooltip renders *between* the pill
	//       and the selected text, covering exactly what the user is about to comment on.
	//       placement: "top" flips it clear, above the pill. setTooltip still sets
	//       aria-label under the hood, so the button keeps its accessible name.
	setTooltip(button, "Add comment", { placement: "top" });
	setIcon(button, "message-square-plus");

	// EXPL: A plain <button> click steals focus from the editor's contentEditable on
	//       mousedown, which blurs (and can collapse) the CM selection before the click
	//       handler ever runs. Preventing the mousedown's default focus-shift keeps the
	//       editor focused and the selection intact through to the click handler below,
	//       so addCommentToView sees the same selection the user made.
	dom.addEventListener("mousedown", (event) => event.preventDefault());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		addCommentToView(view, undefined);
	});

	dom.appendChild(button);
	// EXPL: `offset.y` is TooltipView's own clearance knob (see @codemirror/view's
	//       writeMeasure): for an `above` tooltip it's subtracted again after `height`, so it
	//       pushes the pill's bottom edge PILL_GAP px clear of the anchor line's top instead
	//       of flush against it. `x: 0` keeps the pill horizontally centered on the anchor
	//       (the current, correct behavior) — only the vertical clearance was missing.
	return { dom, offset: { x: 0, y: PILL_GAP } };
}

function getCommentPillTooltip(state: EditorState): Tooltip | null {
	if (!pill_eligible(state))
		return null;

	return {
		pos: state.selection.main.head,
		above: true,
		strictSide: false,
		create: createPillDom,
	};
}

// EXPL: Unconditionally registered in main.ts#loadEditorExtensions (no setting gates it
//       yet); pushing it behind a settings check later is a one-line change at the call
//       site, nothing here needs to move.
export const commentPill: Extension = StateField.define<Tooltip | null>({
	create: getCommentPillTooltip,
	update(tooltip, tr) {
		if (!tr.docChanged && !tr.selection)
			return tooltip;

		const next = getCommentPillTooltip(tr.state);
		// EXPL: Keep the same Tooltip object when the anchor position hasn't moved, so CM6
		//       doesn't tear down and recreate the pill's DOM on every keystroke/selection
		//       tweak that leaves eligibility and position unchanged.
		if (tooltip && next && tooltip.pos === next.pos)
			return tooltip;
		return next;
	},
	provide: field => showTooltip.from(field),
});
