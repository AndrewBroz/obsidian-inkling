import { StateEffect, StateField } from "@codemirror/state";

/** The document span a not-yet-written comment is anchored to. */
export interface CommentDraft {
	from: number;
	to: number;
}

export const setCommentDraft = StateEffect.define<CommentDraft>();
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

		// EXPL: Map, do not discard. Discarding on any docChanged would contradict the reply box's
		//       "blur with text leaves the box open" rule — a user who types a draft, clicks into
		//       the note to fix a word, and comes back would find their draft silently gone. The
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
		return from < to ? { from, to } : null;
	},
});
