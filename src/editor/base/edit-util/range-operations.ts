import { type EditorSelection, Text } from "@codemirror/state";

import { CriticMarkupRange, SuggestionType } from "../ranges";

/**
 * `spans` (sorted, non-overlapping spans being removed), with spans that only spaces separate on one line merged,
 * and each widened to its whole line and one line break when nothing but container markers (`>`, indentation) would
 * be left on that line. A comment on code has a line of its own (code-comments.ts), and removing it must not leave
 * an empty line behind; a comment alone on a line inside a paragraph would otherwise split the paragraph in two.
 */
export function removal_spans(doc: Text, spans: { from: number; to: number }[]): { from: number; to: number }[] {
	const merged: { from: number; to: number }[] = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last && /^[ \t]*$/.test(doc.sliceString(last.to, span.from))) last.to = span.to;
		else merged.push({ ...span });
	}
	return merged.map(({ from, to }) => {
		const start = doc.lineAt(from), end = doc.lineAt(to);
		if (!/^[ \t>]*$/.test(doc.sliceString(start.from, from)) || doc.sliceString(to, end.to).trim() !== "")
			return { from, to };
		if (end.to < doc.length) return { from: start.from, to: end.to + 1 };
		if (start.from === 0) return { from: 0, to: end.to };
		// EXPL: The last line takes the line break before it, a CRLF one whole (a vault file's text is read raw).
		return { from: start.from - (doc.sliceString(start.from - 2, start.from - 1) === "\r" ? 2 : 1), to: end.to };
	});
}

/**
 * `text` with each of `ranges` (sorted, non-overlapping) replaced by what `fn` returns for it. A comment thread that
 * `fn` removes entirely takes its line with it when nothing else is left on it (`removal_spans`).
 */
export function applyToText(
	text: string,
	fn: (range: CriticMarkupRange, text: string) => string,
	ranges: CriticMarkupRange[],
) {
	const edits = ranges.map(range => ({ from: range.from, to: range.to, insert: fn(range, text), range }));
	// EXPL: Consecutive removed members of comment threads, as spans: a thread's members are adjacent, so a removed
	//       thread is one span, and threads on one line are merged by `removal_spans`.
	const removed: { from: number; to: number }[] = [];
	for (const edit of edits) {
		if (edit.insert !== "" || edit.range.base_range.type !== SuggestionType.COMMENT) continue;
		const last = removed[removed.length - 1];
		if (last && last.to === edit.from) last.to = edit.to;
		else removed.push({ from: edit.from, to: edit.to });
	}
	const widened = removed.length ? removal_spans(Text.of(text.split("\n")), removed) : [];

	let output = "";
	let last_range = 0;
	for (const edit of edits) {
		// EXPL: An edit inside a widened span is covered by it; the span is written once, at its first edit.
		const span = widened.find(w => w.from <= edit.from && edit.to <= w.to);
		if (span) {
			if (last_range <= span.from) {
				output += text.slice(last_range, span.from);
				last_range = span.to;
			}
			continue;
		}
		output += text.slice(last_range, edit.from) + edit.insert;
		last_range = edit.to;
	}
	return output + text.slice(last_range);
}

export function is_forward_movement(prev_selection: EditorSelection, next_selection: EditorSelection) {
	return prev_selection.main.head < next_selection.main.head;
}
