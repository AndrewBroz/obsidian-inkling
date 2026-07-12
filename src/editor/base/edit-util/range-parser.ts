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

function constructRangeFromSyntaxNode(settings: PluginSettings, range: SyntaxNode, text: string) {
	const metadata = (settings.enable_metadata && range.firstChild?.type.name.startsWith("MDSep")) ?
		range.firstChild!.from :
		undefined;
	let middle = undefined;
	if (range.type.name === "Substitution") {
		const child = metadata ? range.firstChild?.nextSibling : range.firstChild;
		if (!child || child.type.name !== "MSub") return;
		middle = child.from;
	}

	return constructRange(range.from, range.to, range.type.name, text.slice(range.from, range.to), middle, metadata);
}

export function cursorGenerateRanges(tree: Tree, text: string, settings: PluginSettings, start = 0, to = text.length) {
	const ranges: CriticMarkupRange[] = [];

	let previous_range: CriticMarkupRange | undefined = undefined;

	const cursor = tree.cursor();
	// Move into the first range if it exists (otherwise stays in CriticMarkup node), negative offset to be left-inclusive
	cursor.childAfter(start - 1);
	if (cursor.node.type.name === "CriticMarkup")
		return ranges;
	if (cursor.node.from > to)
		return ranges;

	if (cursor) {
		do {
			const range = cursor.node;
			if (range.type.name === "⚠") continue;
			const new_range = constructRangeFromSyntaxNode(settings, range, text);
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
		} while (cursor.nextSibling() && cursor.node.from <= to);
	}

	return ranges;
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
