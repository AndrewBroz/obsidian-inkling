import { type SyntaxNode, type Tree } from "@lezer/common";

import {
	AdditionRange,
	CommentRange,
	CriticMarkupRange,
	DeletionRange,
	HighlightRange,
	SubstitutionRange,
	SuggestionType,
} from "../ranges";

import { criticmarkupLanguage } from "@fevol/lang-criticmarkup";
import type { PluginSettings } from "../../../types";

function constructRangeFromSyntaxNode(
	settings: PluginSettings,
	range: SyntaxNode,
	text: string,
	offset = 0,
	to = range.to + offset,
) {
	const metadata = (settings.enable_metadata && range.firstChild?.type.name.startsWith("MDSep")) ?
		range.firstChild!.from + offset :
		undefined;
	let middle = undefined;
	if (range.type.name === "Substitution") {
		const child = metadata ? range.firstChild?.nextSibling : range.firstChild;
		if (!child || child.type.name !== "MSub") return;
		middle = child.from + offset;
	}

	const from = range.from + offset;
	return constructRange(from, to, range.type.name, text.slice(from, to), middle, metadata);
}

// EXPL: The closing bracket that ends a well-formed node of each range type.
const CLOSERS: Record<string, string> = {
	Addition: "++}",
	Deletion: "--}",
	Substitution: "~~}",
	Comment: "<<}",
	Highlight: "==}",
};

/**
 * Where a range really ends: the node's end if it is well-formed, otherwise the first closer of its type
 * after the node, or undefined if there is none (an opener that is never closed is not a range).
 * @remarks The grammar never rejects a malformed range, it ends the node early with an error inside:
 *   - an opener without its closer (`{++text`) runs to the end of the text;
 *   - a repeated separator (`{~~a~>b~>c~~}`, `{++{}@@a@@b++}`) ends the node just before it.
 *   A well-formed range already ends at the first closer of its type, so a node cut short is extended to it.
 */
function rangeEnd(range: SyntaxNode, text: string, offset: number): number | undefined {
	const closer = CLOSERS[range.type.name];
	const to = range.to + offset;
	if (!closer) return to;
	if (to - (range.from + offset) >= 6 && text.startsWith(closer, to - closer.length))
		return to;
	const close = text.indexOf(closer, to);
	return close === -1 ? undefined : close + closer.length;
}

export function cursorGenerateRanges(tree: Tree, text: string, settings: PluginSettings, start = 0, to = text.length) {
	const ranges: CriticMarkupRange[] = [];

	let previous_range: CriticMarkupRange | undefined = undefined;
	// EXPL: Position in `text` where `tree` starts (non-zero once the text after a malformed range is re-parsed).
	let offset = 0;

	for (;;) {
		const cursor = tree.cursor();
		// Move into the first range if it exists (otherwise stays in CriticMarkup node), negative offset to be left-inclusive
		cursor.childAfter(start - offset - 1);
		if (cursor.node.type.name === "CriticMarkup")
			return ranges;
		if (cursor.node.from + offset > to)
			return ranges;

		// EXPL: Set once a malformed node is met. The grammar's output after it cannot be trusted (an unclosed
		//       opener swallows every later range), so the text from `resume` on is parsed again.
		let resume: number | undefined = undefined;
		do {
			const range = cursor.node;
			if (range.type.name === "⚠") continue;
			const end = rangeEnd(range, text, offset);
			const new_range = end === undefined ?
				undefined :
				constructRangeFromSyntaxNode(settings, range, text, offset, end);
			if (end !== range.to + offset) {
				// EXPL: A malformed node that is not a range is left as written; parsing continues after its opener.
				resume = new_range ? end : range.from + offset + 3;
			}
			if (new_range) {
				if (
					new_range.type === SuggestionType.COMMENT && previous_range &&
					previous_range.right_adjacent(new_range)
				) {
					(new_range as CommentRange).add_reply(previous_range);
				}
				ranges.push(new_range);
				previous_range = new_range;
			}
			if (resume !== undefined) break;
		} while (cursor.nextSibling() && cursor.node.from + offset <= to);

		if (resume === undefined || resume > to || resume >= text.length)
			return ranges;
		// EXPL: Parse a slice and shift positions by hand: with `ranges` passed to this parser, node positions
		//       came back relative to the range start rather than absolute.
		tree = criticmarkupLanguage.parser.parse(text.slice(resume));
		offset = resume;
		start = Math.max(start, resume);
	}
}

export function getRangesInText(text: string, settings: PluginSettings) {
	const tree = criticmarkupLanguage.parser.parse(text);
	return cursorGenerateRanges(tree, text, settings);
}

export function constructRange(
	from: number,
	to: number,
	type: string,
	text: string,
	middle?: number,
	metadata?: number,
) {
	switch (type) {
		case "Addition":
			return new AdditionRange(from, to, text, metadata);
		case "Deletion":
			return new DeletionRange(from, to, text, metadata);
		case "Substitution":
			return new SubstitutionRange(from, middle!, to, text, metadata);
		case "Highlight":
			return new HighlightRange(from, to, text, metadata);
		case "Comment":
			return new CommentRange(from, to, text, metadata);
		default:
			// Will never get called
			return new AdditionRange(from, to, text, metadata);
	}
}

export const RANGE_PROTOTYPE_MAPPER = {
	[SuggestionType.ADDITION]: AdditionRange,
	[SuggestionType.DELETION]: DeletionRange,
	[SuggestionType.HIGHLIGHT]: HighlightRange,
	[SuggestionType.SUBSTITUTION]: SubstitutionRange,
	[SuggestionType.COMMENT]: CommentRange,
};
