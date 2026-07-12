import { EditorState, type Extension, StateField } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip, type TooltipView } from "@codemirror/view";

import { setIcon } from "obsidian";

import { addCommentToView, rangeParser } from "../../base";

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
	button.setAttribute("aria-label", "Add comment");
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
	return { dom };
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
