import { type SyntaxNode, type Tree } from "@lezer/common";

import {
	AdditionRange,
	CommentRange,
	CriticMarkupRange,
	DeletionRange,
	HighlightRange,
	type MetaLocation,
	SubstitutionRange,
	SuggestionType,
} from "../ranges";

import { criticmarkupLanguage } from "@fevol/lang-criticmarkup";
import type { PluginSettings } from "../../../types";
import { parseAttrBlock, parseLegacyMetadata } from "./attributes";

function constructRangeFromSyntaxNode(
	settings: PluginSettings,
	range: SyntaxNode,
	text: string,
	offset = 0,
	to = range.to + offset,
) {
	const from = range.from + offset;
	// EXPL: The grammar marks the first `@@` in any range with an MDSep node that starts at the `@@`. The text between
	//       the opener and it is legacy metadata only if it is a JSON object; otherwise the `@@` is content.
	const separator = settings.enable_metadata && range.firstChild?.type.name.startsWith("MDSep") ?
		range.firstChild.from + offset :
		undefined;
	const legacy = separator !== undefined && parseLegacyMetadata(text.slice(from + 3, separator)) !== undefined;
	const meta: MetaLocation | undefined = legacy ?
		{ syntax: "legacy", from: from + 3, to: separator! + 2 } :
		undefined;
	let middle = undefined;
	if (range.type.name === "Substitution") {
		const child = range.getChild("MSub");
		if (!child) return;
		middle = child.from + offset;
	}

	let end = to;
	let location = meta;
	// EXPL: A trailing attribute block sits outside the grammar's node, right after the closer. A range with legacy
	//       metadata never takes one (one range, one syntax).
	if (settings.enable_metadata && !legacy) {
		const block = parseAttrBlock(text, to);
		if (block) {
			location = { syntax: "attributes", from: block.from, to: block.to };
			end = block.to;
		}
	}

	return constructRange(from, end, range.type.name, text.slice(from, end), middle, location);
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
			// EXPL: The grammar does not know attribute blocks and scans their text, so a quoted value such as
			//       `author="{++x"` can open a node inside the previous range's block. Such a node is not a range;
			//       re-parse from the end of the block instead of trusting the grammar past it.
			if (previous_range?.meta?.syntax === "attributes" && range.from + offset < previous_range.to) {
				resume = previous_range.to;
				break;
			}
			const end = rangeEnd(range, text, offset);
			const new_range = end === undefined ?
				undefined :
				constructRangeFromSyntaxNode(settings, range, text, offset, end);
			if (end !== range.to + offset) {
				// EXPL: A malformed node that is not a range is left as written; parsing continues after its opener.
				resume = new_range ? new_range.to : range.from + offset + 3;
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
	meta?: MetaLocation,
) {
	switch (type) {
		case "Addition":
			return new AdditionRange(from, to, text, meta);
		case "Deletion":
			return new DeletionRange(from, to, text, meta);
		case "Substitution":
			return new SubstitutionRange(from, middle!, to, text, meta);
		case "Highlight":
			return new HighlightRange(from, to, text, meta);
		case "Comment":
			return new CommentRange(from, to, text, meta);
		default:
			// Will never get called
			return new AdditionRange(from, to, text, meta);
	}
}

export const RANGE_PROTOTYPE_MAPPER = {
	[SuggestionType.ADDITION]: AdditionRange,
	[SuggestionType.DELETION]: DeletionRange,
	[SuggestionType.HIGHLIGHT]: HighlightRange,
	[SuggestionType.SUBSTITUTION]: SubstitutionRange,
	[SuggestionType.COMMENT]: CommentRange,
};

/**
 * Reattach range prototypes to a vault-cache entry read back from IndexedDB or a worker (both strip prototypes).
 * Returns undefined for an entry written before attribute blocks, whose ranges have an own `fields` and no
 * `own_fields`: with the prototype reattached, that stale `fields` would shadow the getter and every edit built
 * from `own_fields` would drop the metadata. The caller discards such an entry so the file is parsed again.
 */
export function reviveCachedRanges(data: CriticMarkupRange[]): CriticMarkupRange[] | undefined {
	if (data.some(range => !Object.hasOwn(range, "own_fields"))) return undefined;
	return data.map(range => Object.setPrototypeOf(range, RANGE_PROTOTYPE_MAPPER[range.type].prototype));
}
