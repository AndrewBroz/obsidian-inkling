import type { MetadataSyntax } from "../../../types";
import type { EditorChange } from "../edit-handler";
import { serializeAttrBlock, unconvertibleContent, unconvertibleReason } from "../edit-util/attributes";
import { write_syntax } from "../edit-util/metadata";
import {
	type CommentRange,
	CriticMarkupRange,
	INHERITED_KEYS,
	type MetadataFields,
	SuggestionType,
} from "../ranges";

/**
 * A thread is resolved iff its base range (the HIGHLIGHT for anchored threads, the first
 * COMMENT otherwise) carries `done: true` in its metadata. Replies never count: `done` on a reply is ignored.
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
 * Marks the thread resolved. Thread rule 1: `done` is written on the base only, which is the only place
 * `thread_resolved` (and every older version) reads it. Reversible: only metadata changes.
 */
export function resolve_thread(range: CriticMarkupRange, setting: MetadataSyntax = "legacy"): EditorChange[] {
	const base = range.base_range;
	// EXPL: An attributes-era anchor usually has no block of its own (it inherits), so its first comment's syntax
	//       says which form the thread is in.
	return base.add_metadata("done", true, write_syntax(setting, base, base.replies[0]));
}

/**
 * Reopens the thread: removes `done` from the base, and from any reply still carrying a copy written by an older
 * version, so legacy threads are cleaned up when reopened. Each member edits its own metadata, so the changes never
 * overlap.
 */
export function reopen_thread(range: CriticMarkupRange, setting: MetadataSyntax = "legacy"): EditorChange[] {
	return range.base_range.full_thread.flatMap(member =>
		Object.hasOwn(member.own_fields, "done") ? member.delete_metadata("done", write_syntax(setting, member)) : []
	);
}

/**
 * Per-range source for the vault-wide "resolve" edit (`applyToFile` runs it on replies too): only the base is
 * rewritten, replies come back byte-identical (thread rule 1).
 */
export function resolve_source(range: CriticMarkupRange, text: string, setting: MetadataSyntax): string {
	if (range !== range.base_range) return text.slice(range.from, range.to);
	return range_source_with_fields(
		range,
		{ ...range.own_fields, done: true },
		write_syntax(setting, range, range.replies[0]),
	);
}

/**
 * Per-range source for the vault-wide "reopen" edit (`applyToFile` runs it on replies too, to clean legacy `done`
 * copies). A range without its own `done` comes back byte-identical, so reopening never migrates or normalises
 * members it has no reason to touch.
 */
export function reopen_source(range: CriticMarkupRange, text: string, setting: MetadataSyntax): string {
	if (!Object.hasOwn(range.own_fields, "done")) return text.slice(range.from, range.to);
	const fields = { ...range.own_fields };
	delete fields.done;
	return range_source_with_fields(range, fields, write_syntax(setting, range));
}

/**
 * Changes that write a HIGHLIGHT anchor's inherited author/time into its own metadata, needed when `comment`
 * (its first comment) is about to be removed or rewritten. `next_first` is the fields of whatever will be the first
 * comment afterwards (undefined if unknown or none). A key is written only if the anchor does not state it and
 * the new first comment would give it a different value. Otherwise the anchor would silently change author.
 */
export function anchor_inheritance_changes(
	comment: CriticMarkupRange,
	next_first: MetadataFields | undefined,
	setting: MetadataSyntax,
): EditorChange[] {
	const base = comment.base_range;
	if (base.type !== SuggestionType.HIGHLIGHT || base.replies[0] !== comment) return [];
	const missing: MetadataFields = {};
	for (const key of INHERITED_KEYS) {
		if (key in base.own_fields) continue;
		const inherited = comment.own_fields[key];
		if (inherited === undefined || next_first?.[key] === inherited) continue;
		(missing as Record<string, unknown>)[key] = inherited;
	}
	if (!Object.keys(missing).length) return [];
	return base.set_metadata({ ...missing, ...base.own_fields }, write_syntax(setting, base, comment));
}

/** Removes one comment, keeping its anchor's authorship if the comment was the one it inherited from. */
export function remove_comment(comment: CriticMarkupRange, setting: MetadataSyntax): EditorChange[] {
	const next = comment.base_range.replies[1];
	return [
		...anchor_inheritance_changes(comment, next?.own_fields, setting),
		{ from: comment.from, to: comment.to, insert: "" },
	];
}

/**
 * Rebuilds a range's full markup source (brackets included) with the given metadata fields.
 * `range.text` is already metadata-stripped but keeps its brackets, so the first/last 3
 * characters are the opening/closing bracket and everything in between is the range's content
 * (for substitutions, that includes the `~>` separator). Empty fields produce no metadata. The source covers the
 * full range, an attribute block included, which matches the `from..to` it replaces.
 */
export function range_source_with_fields(
	range: CriticMarkupRange,
	fields: MetadataFields,
	syntax: MetadataSyntax = range.meta?.syntax ?? "legacy",
): string {
	if (!Object.values(fields).some(value => value !== undefined))
		return range.text;
	// EXPL: Lossless or untouched: fields or content that would not read back from an attribute block stay legacy.
	if (syntax === "attributes" && !unconvertibleReason(fields) && !unconvertibleContent(range.text))
		return range.text + serializeAttrBlock(fields);
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

	return remove_comment(range, "legacy");
}
