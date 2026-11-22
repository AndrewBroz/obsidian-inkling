import { type EditorState, StateField, type Text } from "@codemirror/state";

import { type CriticMarkupRange, type CriticMarkupRanges, type MetadataFields, SuggestionType } from "../ranges";
import type { CodeRegion } from "./code-regions";
import { rangeParser } from "./range-state";

// EXPL: Comments on fenced code. Inkling never writes inside a code block, so a comment on code is a standalone
//       comment on the line directly after the closing fence, and remembers what it was about in its attribute
//       block: `quote` (the selected text, one line at most), `line` (1-based, within the block) and `lines` (the
//       number of selected lines, when more than one). No fields means the whole block. See
//       docs/superpowers/specs/2026-11-21-code-block-comments-design.md.

/** What a comment on code remembers about its selection: nothing for the whole block. */
export interface CodeQuote {
	quote?: string;
	line?: number;
	lines?: number;
}

/** Where a comment's code is now: a span to highlight, the whole block, or its quote no longer in the block. */
export type CodeTarget = { from: number; to: number } | "block" | "changed";

export interface CodeLink {
	region: CodeRegion;
	target: CodeTarget;
}

/** Whether a block has a closing fence. An unclosed block runs to the end of its container, with no "after". */
export function closed_region(region: CodeRegion): boolean {
	return region.close_from < region.to;
}

/** The code block a new comment on `from`-`to` is about: the block an end of it is in, its start first. */
export function code_comment_region(regions: CodeRegion[], from: number, to: number): CodeRegion | undefined {
	const at = (pos: number) => regions.find(r => r.from <= pos && pos <= r.to);
	return at(from) ?? at(to);
}

/** The first and last line numbers of a block's code (between its fences); first > last for an empty block. */
function code_lines(doc: Text, region: CodeRegion): { first: number; last: number } {
	const first = doc.lineAt(region.open_to).number + 1;
	const last = closed_region(region) ? doc.lineAt(region.close_from).number - 1 : doc.lineAt(region.to).number;
	return { first, last };
}

/**
 * The part of `from`-`to` on the block's code lines, without a line break at either end, or undefined when nothing
 * of the code is selected (a cursor, or only fence text): the comment is then about the whole block.
 */
export function code_selection(
	doc: Text,
	region: CodeRegion,
	from: number,
	to: number,
): { from: number; to: number } | undefined {
	const { first, last } = code_lines(doc, region);
	if (first > last) return undefined;
	let start = Math.max(from, doc.line(first).from), end = Math.min(to, doc.line(last).to);
	while (start < end && doc.lineAt(start).to === start) start++;
	while (start < end && doc.lineAt(end).from === end) end--;
	return start < end ? { from: start, to: end } : undefined;
}

/** The fields for a comment on `selection` (from `code_selection`) in `region`. */
export function code_quote(doc: Text, region: CodeRegion, selection: { from: number; to: number } | undefined): CodeQuote {
	if (!selection) return {};
	const start = doc.lineAt(selection.from), end = doc.lineAt(selection.to);
	const fields: CodeQuote = {
		quote: doc.sliceString(selection.from, Math.min(selection.to, start.to)),
		line: start.number - doc.lineAt(region.from).number,
	};
	if (end.number > start.number) fields.lines = end.number - start.number + 1;
	return fields;
}

/** A comment's remembered quote, or undefined if it has none. A hand-written bare number counts as text. */
export function quote_of(fields: MetadataFields): string | undefined {
	const quote = fields.quote;
	if (typeof quote === "number") return String(quote);
	return typeof quote === "string" && quote ? quote : undefined;
}

const positive = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/**
 * Where `fields`' quote is in the block now. Of several occurrences, the one whose line is closest to the remembered
 * `line` (the earlier on a tie); with `lines` > 1, from the match to the end of that many lines, within the block.
 */
export function code_target(doc: Text, region: CodeRegion, fields: MetadataFields): CodeTarget {
	const quote = quote_of(fields);
	if (!quote) return "block";
	const { first, last } = code_lines(doc, region);
	const base = doc.lineAt(region.from).number, remembered = positive(fields.line);
	let best: { line: number; from: number } | undefined, best_distance = Infinity;
	for (let n = first; n <= last; n++) {
		const line = doc.line(n);
		for (let i = line.text.indexOf(quote); i !== -1; i = line.text.indexOf(quote, i + 1)) {
			const distance = remembered === undefined ? 0 : Math.abs(n - base - remembered);
			if (distance < best_distance) {
				best = { line: n, from: line.from + i };
				best_distance = distance;
			}
		}
	}
	if (!best) return "changed";
	const lines = positive(fields.lines) ?? 1;
	return {
		from: best.from,
		to: lines > 1 ? doc.line(Math.min(best.line + lines - 1, last)).to : best.from + quote.length,
	};
}

/** The comment thread base starting exactly at `pos`, if any. */
function thread_at(ranges: CriticMarkupRanges, pos: number): CriticMarkupRange | undefined {
	return ranges.ranges_in_interval(pos, pos).find(range =>
		range.from === pos && range.type === SuggestionType.COMMENT && range.base_range === range
	);
}

/**
 * The comment threads on the line directly after `region`'s closing fence, in order. A thread belongs to the block
 * when only container markers (`>`, indentation) and other such threads, with spaces, come before it on that line:
 * a blank line or any other text in between breaks the link.
 */
export function block_threads(doc: Text, ranges: CriticMarkupRanges, region: CodeRegion): CriticMarkupRange[] {
	if (!closed_region(region) || region.to >= doc.length) return [];
	const line = doc.lineAt(region.to + 1);
	const threads: CriticMarkupRange[] = [];
	for (let pos = line.from;;) {
		while (pos < line.to && /[ \t>]/.test(doc.sliceString(pos, pos + 1))) pos++;
		const thread = pos < line.to ? thread_at(ranges, pos) : undefined;
		if (!thread) return threads;
		threads.push(thread);
		pos = thread.full_range_back;
	}
}

// EXPL: Lines that start a block of their own even right after a paragraph line: a quote, a bullet or `1.` list item
//       with content, an ATX heading, a fence, a `*`/`_` thematic break. Anything else (text, a `---`/`===` setext
//       underline, indented code, a table) would join the comment's paragraph, or turn it into a heading.
const INTERRUPTS = /^ {0,3}(>|[-+*][ \t]+\S|0*1[.)][ \t]+\S|#{1,6}([ \t]|$)|`{3,}|~{3,}|(\*[ \t]*){3,}$|(_[ \t]*){3,}$)/;

/**
 * Where a new comment on `region` goes: on the comment line after the block's other threads, or on a new line
 * directly after the closing fence, carrying the fence line's container markers (`> `, list indentation) so the
 * comment stays in the same quote or list item.
 * @returns The position to insert at, and the text that goes before and after the comment.
 */
export function code_comment_insertion(
	doc: Text,
	ranges: CriticMarkupRanges,
	region: CodeRegion,
): { at: number; before: string; after: string } {
	const threads = block_threads(doc, ranges, region);
	if (threads.length) return { at: threads[threads.length - 1].full_range_back, before: " ", after: "" };
	const prefix = /^[ \t>]*/.exec(doc.lineAt(region.close_from).text)![0];
	if (region.to >= doc.length) return { at: region.to, before: "\n" + prefix, after: "" };
	// EXPL: The comment line is a paragraph, so a following line that would join it is kept apart with a blank line
	//       (inside the same container: `>` in a quote).
	const next = doc.lineAt(region.to + 1).text;
	const rest = next.startsWith(prefix) ? next.slice(prefix.length) : next;
	const joins = next.trim() !== "" && !/^[ \t>]*$/.test(next) && !INTERRUPTS.test(rest);
	return { at: region.to, before: "\n" + prefix, after: joins ? "\n" + prefix.trimEnd() : "" };
}

/** Every comment thread that belongs to a code block, by its base comment, with where its code is now. */
export function code_links(doc: Text, regions: CodeRegion[], ranges: CriticMarkupRanges): Map<CriticMarkupRange, CodeLink> {
	const links = new Map<CriticMarkupRange, CodeLink>();
	for (const region of regions) {
		for (const thread of block_threads(doc, ranges, region))
			links.set(thread, { region, target: code_target(doc, region, thread.fields) });
	}
	return links;
}

function compute(state: EditorState): Map<CriticMarkupRange, CodeLink> {
	const { code_regions, ranges } = state.field(rangeParser);
	return code_links(state.doc, code_regions, ranges);
}

/** The comment threads that belong to code blocks, recomputed whenever the note or its ranges change. */
export const codeCommentLinks = StateField.define<Map<CriticMarkupRange, CodeLink>>({
	create: compute,
	update(links, tr) {
		const parsed = tr.state.field(rangeParser);
		if (!tr.docChanged && !parsed.inserted_ranges.length && !parsed.deleted_ranges.length) return links;
		return compute(tr.state);
	},
});

/** The code link of `range`'s thread, if it belongs to a code block. Works without the field installed. */
export function code_link_of(state: EditorState, range: CriticMarkupRange): CodeLink | undefined {
	return (state.field(codeCommentLinks, false) ?? compute(state)).get(range.base_range);
}
