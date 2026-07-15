import { Annotation, Transaction } from "@codemirror/state";

/**
 * Marks a transaction as originating from Inkling itself. The editing-mode transaction filters must
 * not re-process their own output, or they recurse.
 */
export const pluginEditAnnotation = Annotation.define<boolean>();

/**
 * Is this doc-changing transaction exempt from suggestion/edit/comment tracking?
 *
 * This is a DENYLIST on purpose. The three editing modes each used to carry their own ALLOWLIST of
 * userEvents, and an edit matching none of them passed through UNTRACKED -- silently. That is how a
 * dragged selection (`move.drop`, see @codemirror/view's dropText) and image paste (routed through
 * Obsidian's own file handling, so carrying no userEvent at all) escaped Suggest mode, whose entire
 * promise is that every edit is tracked.
 *
 * The three copies of that allowlist were not even in agreement: comment-mode.ts alone included
 * "move". Adding "move" to the other two would have fixed today's symptom and left the mechanism --
 * a fourth copy would be the next bug.
 *
 * So: anything we do not recognise is TRACKED, not exempted. Only these four things are exempt.
 */
export function is_exempt_from_tracking(tr: Transaction): boolean {
	return tr.isUserEvent("undo") ||
		tr.isUserEvent("redo") ||
		tr.annotation(Transaction.remote) === true ||
		tr.annotation(pluginEditAnnotation) === true;
}
