import type { EditorChange } from "../edit-handler";
import { type CommentRange, CriticMarkupRange, type MetadataFields, SuggestionType } from "../ranges";

/**
 * A thread is resolved iff its base range (the HIGHLIGHT for anchored threads, the first
 * COMMENT otherwise) carries `done: true` in its metadata.
 */
export function thread_resolved(range: CriticMarkupRange): boolean {
	return range.base_range.fields.done === true;
}

/**
 * Resolve/reopen is a comment-thread concept: it only applies to threads whose base is a
 * HIGHLIGHT anchor or a standalone COMMENT. Suggestion bases (addition/deletion/substitution)
 * have their own lifecycle (accept/reject) — a `done` flag on them (legacy "Set completed"
 * data) must not make the thread disappear or render as if the suggestion were applied.
 */
export function thread_resolvable(range: CriticMarkupRange): boolean {
	const base_type = range.base_range.type;
	return base_type === SuggestionType.COMMENT || base_type === SuggestionType.HIGHLIGHT;
}

/**
 * Marks every member of the thread (base + replies) as done. Reversible — only metadata
 * changes, markup is never deleted. Each member edits its own metadata blob, so the returned
 * changes never overlap and are safe to dispatch together.
 */
export function resolve_thread(range: CriticMarkupRange): EditorChange[] {
	return range.base_range.full_thread.flatMap(member => member.add_metadata("done", true));
}

/**
 * Removes `done` from every member of the thread (base + replies).
 */
export function reopen_thread(range: CriticMarkupRange): EditorChange[] {
	return range.base_range.full_thread.flatMap(member => member.delete_metadata("done"));
}

/**
 * Rebuilds a range's full markup source (brackets included) with the given metadata fields.
 * `range.text` is already metadata-stripped but keeps its brackets, so the first/last 3
 * characters are the opening/closing bracket and everything in between is the range's content
 * (for substitutions, that includes the `~>` separator). Empty fields produce no metadata blob.
 */
export function range_source_with_fields(range: CriticMarkupRange, fields: MetadataFields): string {
	if (Object.keys(fields).length === 0)
		return range.text;
	return range.text.slice(0, 3) + JSON.stringify(fields) + "@@" + range.text.slice(3);
}

/**
 * Removes an empty comment. If it is the only reply on an anchored (HIGHLIGHT) thread, the
 * highlight is unwrapped to plain text as well — an anchor with no comments left is just
 * selected text, not a thread. Otherwise only the comment's own markup span is removed,
 * leaving the anchor and any sibling replies intact.
 */
export function cancel_empty_comment(range: CommentRange): EditorChange[] {
	const base = range.base_range;
	const is_only_reply = base.type === SuggestionType.HIGHLIGHT &&
		base.replies.length === 1 &&
		base.replies[0] === range;

	if (is_only_reply)
		return [{ from: base.from, to: range.to, insert: base.unwrap() }];

	return [{ from: range.from, to: range.to, insert: "" }];
}
