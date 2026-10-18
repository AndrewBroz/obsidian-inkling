import { CriticMarkupRange, type MetaLocation } from "../base_range";
import { SuggestionType } from "../definitions";

export class HighlightRange extends CriticMarkupRange {
	constructor(from: number, to: number, text: string, meta?: MetaLocation) {
		super(from, to, SuggestionType.HIGHLIGHT, "Highlight", text, meta);
	}
}
