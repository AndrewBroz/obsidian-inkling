import type { MetadataSyntax, PluginSettings } from "../../../types";
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
 * The changes that delete an entire thread.
 * - COMMENT base: the whole thread span (base + replies) is removed.
 * - HIGHLIGHT base: the highlight is unwrapped to plain text and its replies are removed.
 * - Suggestion bases (addition/deletion/substitution): only the attached comments are removed,
 *   the suggestion markup itself is kept.
 */
export function remove_thread(range: CriticMarkupRange): EditorChange[] {
	const base = range.base_range;
	if (base.type === SuggestionType.COMMENT)
		return [{ from: base.full_range_front, to: base.full_range_back, insert: "" }];
	if (base.type === SuggestionType.HIGHLIGHT)
		return [{ from: base.from, to: base.full_range_back, insert: base.unwrap() }];
	if (base.replies.length) {
		return [{
			from: base.replies[0].from,
			to: base.replies[base.replies.length - 1].to,
			insert: "",
		}];
	}
	return [];
}

/**
 * Removes every resolved comment thread in a note. `ranges` is the note's flat range list, replies
 * included, so each thread is taken once from its base: threads never overlap, so neither do the changes.
 * Suggestions with a legacy `done` flag are not resolvable (see `thread_resolvable`) and are kept.
 */
export function remove_resolved_threads(ranges: CriticMarkupRange[]): { changes: EditorChange[]; count: number } {
	const bases = [...new Set(ranges.map(range => range.base_range))]
		.filter(base => thread_resolvable(base) && thread_resolved(base));
	return { changes: bases.flatMap(remove_thread), count: bases.length };
}

export type ResolveSettings = Pick<PluginSettings, "metadata_syntax" | "remove_on_resolve">;

/** What an editor Resolve action does: mark the thread done or, with `remove_on_resolve`, remove it. */
export function resolve_action(range: CriticMarkupRange, settings: ResolveSettings): EditorChange[] {
	return settings.remove_on_resolve ? remove_thread(range) : resolve_thread(range, settings.metadata_syntax);
}

/**
 * Per-range source for the vault-wide "resolve" edit (`applyToFile` runs it on replies too, and the text is the
 * file's contents). Marking done rewrites the base only, replies come back byte-identical (thread rule 1).
 * With `remove_on_resolve` the base returns the highlight's text for a HIGHLIGHT base and nothing otherwise, and
 * every reply returns nothing. Replies sit directly after their base, so the whole thread disappears.
 */
export function resolve_source(range: CriticMarkupRange, text: string, settings: ResolveSettings): string {
	const base = range.base_range;
	if (settings.remove_on_resolve)
		return range === base && base.type === SuggestionType.HIGHLIGHT ? base.unwrap() : "";
	if (range !== base) return text.slice(range.from, range.to);
	return range_source_with_fields(
		range,
		{ ...range.own_fields, done: true },
		write_syntax(settings.metadata_syntax, range, range.replies[0]),
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
