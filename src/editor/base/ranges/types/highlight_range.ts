import { CriticMarkupRange, INHERITED_KEYS, type MetadataFields, type MetaLocation } from "../base_range";
import { SuggestionType } from "../definitions";

export class HighlightRange extends CriticMarkupRange {
	// EXPL: Thread rule 2 (spec "Thread rules"): an anchor that does not state author/time takes its first
	//       comment's. Computed on read so it holds however the thread was assembled (full or incremental parse).
	get fields(): MetadataFields {
		const first = this.replies[0];
		if (!first) return this.own_fields;
		const inherited: Record<string, string | number> = {};
		for (const key of INHERITED_KEYS) {
			if (!(key in this.own_fields) && first.own_fields[key] !== undefined)
				inherited[key] = first.own_fields[key];
		}
		return Object.keys(inherited).length ? { ...inherited, ...this.own_fields } as MetadataFields : this.own_fields;
	}

	constructor(from: number, to: number, text: string, meta?: MetaLocation) {
		super(from, to, SuggestionType.HIGHLIGHT, "Highlight", text, meta);
	}
}
