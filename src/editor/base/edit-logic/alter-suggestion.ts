import { type ChangeSpec, EditorState } from "@codemirror/state";

import type { App, TFile } from "obsidian";

import { applyToText, rangeParser } from "../edit-util";
import { CriticMarkupRange, SuggestionType } from "../ranges";

/**
 * The changes that resolving every suggestion range in `[from, to)` amounts to, in document order.
 *
 * EXPL: The dedupe here is DEFENSIVE. Ranges in a well-formed document never overlap, so on the happy path
 *       nothing is ever dropped and this is a plain sort. It exists because when the range set does go
 *       wrong -- as it did while the interval tree's `max` augmentation was stale, which left two range
 *       objects at a single document position -- the damage does not stop at a doubled gutter icon. Every
 *       range here becomes a ChangeSpec, and `ChangeSet.of` COMPOSES overlapping specs rather than
 *       rejecting them: the user's text gets duplicated, a delimiter is stranded in the note, and the
 *       character they just typed is eaten. Nothing throws, nothing warns, and the result is written back
 *       to the vault. Silence is exactly what let that bug survive as long as it did.
 *
 *       It is an OVERLAP check, not an equal-positions check, and that is deliberate: the duplicate the
 *       tree bug produced was a STALE range object, and stale ranges carry stale bounds -- they overlap
 *       their replacement without being equal to it, and can even reach past the end of the document
 *       (which `ChangeSet.of` throws a RangeError on). Whichever way the range set is wrong upstream, the
 *       changes emitted from here are disjoint, in document order, and in bounds.
 */
function suggestionChanges(
	state: EditorState,
	resolve: (range: CriticMarkupRange) => string,
	from?: number,
	to?: number,
	remove_attached_comments: boolean = true,
): ChangeSpec[] {
	const range_field = state.field(rangeParser).ranges;
	const doc_length = state.doc.length;

	const suggestions = ((from !== undefined || to !== undefined) ?
		range_field.ranges_in_interval(from ?? 0, to ?? Infinity) :
		range_field.ranges)
		.filter(range =>
			range.type === SuggestionType.ADDITION || range.type === SuggestionType.DELETION ||
			range.type === SuggestionType.SUBSTITUTION
		);

	const changes: ChangeSpec[] = [];
	let resolved_to = 0;
	for (const range of suggestions.slice().sort((a, b) => a.from - b.from)) {
		const range_to = remove_attached_comments ? range.full_range_back : range.to;
		if (range.from < resolved_to || range.from < 0 || range_to > doc_length)
			continue;
		changes.push({ from: range.from, to: range_to, insert: resolve(range) });
		resolved_to = range_to;
	}
	return changes;
}

// TODO: More sophisticated removal handling
export function acceptSuggestions(
	state: EditorState,
	from?: number,
	to?: number,
	remove_attached_comments: boolean = true,
): ChangeSpec[] {
	return suggestionChanges(state, range => range.accept(), from, to, remove_attached_comments);
}

export function rejectSuggestions(
	state: EditorState,
	from?: number,
	to?: number,
	remove_attached_comments: boolean = true,
): ChangeSpec[] {
	return suggestionChanges(state, range => range.reject(), from, to, remove_attached_comments);
}

export async function applyToFile(
	applyFn: (range: CriticMarkupRange, text: string) => string,
	app: App,
	file: TFile,
	ranges: CriticMarkupRange[],
): Promise<void> {
	ranges.sort((a, b) => a.from - b.from);
	const text = await app.vault.read(file);

	const output = applyToText(text, applyFn, ranges);

	await app.vault.modify(file, output);
}
