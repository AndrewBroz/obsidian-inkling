import { DEFAULT_SETTINGS } from "../constants";
import { applyToText } from "../editor/base/edit-util/range-operations";
import { getRangesInText } from "../editor/base/edit-util/range-parser";
import type { CriticMarkupRange } from "../editor/base/ranges/base_range";
import { SuggestionType } from "../editor/base/ranges/definitions";
import type { PluginSettings } from "../types";

// EXPL: Placeholder for a range that disappears entirely, so the whitespace it leaves behind
//       can be tidied without touching whitespace elsewhere in the text.
const REMOVED = "\u0000";

function parse(markdown: string, settings: PluginSettings) {
	// EXPL: Metadata must always be parsed, otherwise `{"author":…}@@` would be treated as range content.
	return getRangesInText(markdown, { ...settings, enable_metadata: true });
}

function originalOf(range: CriticMarkupRange): string {
	switch (range.type) {
		case SuggestionType.ADDITION:
		case SuggestionType.DELETION:
		case SuggestionType.SUBSTITUTION:
			return range.reject();
		case SuggestionType.HIGHLIGHT:
			return range.unwrap();
		default:
			// EXPL: Comments are never document text.
			return "";
	}
}

export function hasCriticMarkup(markdown: string, settings: PluginSettings = DEFAULT_SETTINGS): boolean {
	return parse(markdown, settings).length > 0;
}

/**
 * The note as it reads before review: suggestions rejected, comments removed, highlights unwrapped.
 */
export function toOriginalText(markdown: string, settings: PluginSettings = DEFAULT_SETTINGS): string {
	const ranges = parse(markdown, settings);
	if (!ranges.length) return markdown;
	const marked = applyToText(markdown, (range) => originalOf(range) || REMOVED, ranges);
	return tidy(marked);
}

function tidy(marked: string): string {
	const out: string[] = [];
	let collapse_next_blank = false;
	for (const line of marked.split("\n")) {
		const emptied = line.includes(REMOVED) && line.split(REMOVED).join("").trim() === "";
		if (emptied) {
			// EXPL: Dropping a line that sat between two blank lines would leave them touching.
			collapse_next_blank = out.length > 0 && out[out.length - 1].trim() === "";
			continue;
		}
		if (collapse_next_blank && line.trim() === "") {
			collapse_next_blank = false;
			continue;
		}
		collapse_next_blank = false;
		out.push(line.includes(REMOVED) ? tidyLine(line) : line);
	}
	return out.join("\n");
}

function tidyLine(line: string): string {
	// EXPL: The pattern intentionally matches the REMOVED placeholder (a literal control character).
	// eslint-disable-next-line no-control-regex
	return line.replace(/ ?\u0000(?: ?\u0000)*( ?)/g, (match: string, trailing: string, offset: number) => {
		const leading = match.startsWith(" ");
		const at_start = line.slice(0, offset).trim() === "";
		const at_end = line.slice(offset + match.length) === "";
		if (at_start) return leading ? " " : "";
		if (at_end) return "";
		return leading || trailing ? " " : "";
	});
}
