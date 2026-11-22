import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

import { code_block_outline, code_quote_decoration } from "./code-decorations";

/**
 * The document span a not-yet-written comment is anchored to. A comment on code (`code`) is anchored to the
 * selected code, or with `"block"` to the whole block (its fence lines included); it is written after the block.
 */
export interface CommentDraft {
	from: number;
	to: number;
	code?: "selection" | "block";
}

export const setCommentDraft = StateEffect.define<CommentDraft>();

// EXPL: The same classes the live-preview renderer gives a submitted anchor (markup-renderer.ts), so the theme's
//       highlight colour applies while the user is still typing the comment.
const draftAnchorDecoration = Decoration.mark({ class: "cmtr-inline cmtr-highlight" });
export const clearCommentDraft = StateEffect.define<null>();

/**
 * Holds the anchor of a comment the user is composing but has NOT submitted.
 *
 * EXPL: The document is this plugin's only storage, so the old flow wrote `{==sel==}{>>@@<<}` the
 *       instant the pill was clicked and then chased it with a setTimeout to focus the editor it
 *       had just created (the FIXME in add-comment.ts). Abandoning that comment left an empty range
 *       in the user's note and two junk entries in the undo stack. Keeping the pending anchor in a
 *       StateField instead means the note is written exactly once, on submit, with the text already
 *       in hand — and an abandoned comment is a no-op, not a cleanup.
 */
export const commentDraftField = StateField.define<CommentDraft | null>({
	create: () => null,

	update(draft, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setCommentDraft))
				return effect.value;
			if (effect.is(clearCommentDraft))
				return null;
		}

		if (!draft || !tr.docChanged)
			return draft;

		// EXPL: Map, do not discard. The note can change while the draft is open without the box
		//       losing focus (another pane on the same file, a sync, a plugin), and discarding on any
		//       docChanged would silently throw the user's half-typed comment away. The
		//       anchor only dies when the text it points AT is deleted, at which point the mapped
		//       span collapses to empty and there is genuinely nothing left to comment on.
		// EXPL: The opposite assoc biases give the anchor EXCLUSIVE boundaries: `from` associates
		//       rightward and `to` leftward, so text typed exactly AT either edge falls outside the
		//       anchor, while text typed strictly inside it grows the anchor. That is the behaviour
		//       you want — typing immediately before a commented phrase must not silently swallow
		//       the new words into what the comment claims to be about — but it is invisible in the
		//       code, so `tests/comment_draft.test.ts` pins both edges: inverting these two biases
		//       leaves every other test in the file green.
		const from = tr.changes.mapPos(draft.from, 1);
		const to = tr.changes.mapPos(draft.to, -1);
		return from < to ? { ...draft, from, to } : null;
	},

	// EXPL: A decoration, not markup: nothing is written to the note until the comment is committed, and the
	//       decoration goes with the draft (the committed range's own highlight takes over on commit). A draft on code
	//       shows what the comment will be about the way the written comment does when focused.
	provide: field =>
		EditorView.decorations.compute([field], state => {
			const draft = state.field(field);
			if (!draft) return Decoration.none;
			if (draft.code === "block") return Decoration.set(code_block_outline(state.doc, draft.from, draft.to));
			if (draft.code === "selection") return Decoration.set([code_quote_decoration(draft.from, draft.to)]);
			return Decoration.set([draftAnchorDecoration.range(draft.from, draft.to)]);
		}),
});
