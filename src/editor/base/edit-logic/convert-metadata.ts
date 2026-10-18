import type { MetadataSyntax } from "../../../types";
import type { EditorChange } from "../edit-handler";
import { unconvertibleReason } from "../edit-util/attributes";
import { type CriticMarkupRange, INHERITED_KEYS, type MetadataFields, SuggestionType } from "../ranges";

export interface MetadataConversion {
	changes: EditorChange[];
	converted: number;
	skipped: { range: CriticMarkupRange; reason: string }[];
}

const is_reply = (range: CriticMarkupRange) => range.type === SuggestionType.COMMENT && range.base_range !== range;
const is_anchor = (range: CriticMarkupRange) => range.type === SuggestionType.HIGHLIGHT && range.replies.length > 0;

// EXPL: What a range writes in the attributes syntax: its own fields, minus `done` on a reply (rule 1) and minus an
//       anchor's author/time where they equal its first comment's (rule 2).
function attribute_fields(range: CriticMarkupRange): MetadataFields {
	const fields = { ...range.own_fields };
	if (is_reply(range)) delete fields.done;
	// EXPL: A first comment that stays legacy (unconvertible) cannot be inherited from on the way back, so the anchor
	//       keeps its own fields.
	const first_reply = is_anchor(range) ? range.replies[0] : undefined;
	if (first_reply && (first_reply.meta?.syntax === "attributes" || !unconvertibleReason(first_reply.own_fields))) {
		const first = first_reply.own_fields;
		for (const key of INHERITED_KEYS)
			if (key in fields && fields[key] === first[key]) delete fields[key];
	}
	return fields;
}

// EXPL: `set_metadata` also assigns `own_fields`; the ranges belong to the editor state and the user may still cancel,
//       so put them back once the changes are computed.
function preview(range: CriticMarkupRange, fields: MetadataFields, syntax: MetadataSyntax): EditorChange[] {
	const original = range.own_fields;
	try {
		return range.set_metadata(fields, syntax);
	} finally {
		range.own_fields = original;
	}
}

/**
 * The changes that rewrite every range's metadata in `target` syntax, per the spec's lossless-conversion rules.
 * Ranges already in `target`, or that cannot round-trip, are left as they are. Each range only edits its own span,
 * so the changes never overlap.
 */
export function convert_metadata(ranges: CriticMarkupRange[], target: MetadataSyntax): MetadataConversion {
	const result: MetadataConversion = { changes: [], converted: 0, skipped: [] };
	for (const range of ranges) {
		if (target === "attributes") {
			if (range.meta?.syntax !== "legacy") continue;
			const reason = unconvertibleReason(range.own_fields);
			if (reason) {
				result.skipped.push({ range, reason });
				continue;
			}
			result.changes.push(...preview(range, attribute_fields(range), "attributes"));
			result.converted++;
		} else {
			// EXPL: An anchor whose first comment is in attributes syntax may be relying on inheritance; legacy has no
			//       inheritance (older versions read the anchor alone), so its inherited fields are written out in full.
			const relies_on_inheritance = is_anchor(range) &&
				(range.meta?.syntax === "attributes" || range.replies[0].meta?.syntax === "attributes");
			if (range.meta?.syntax !== "attributes" && !relies_on_inheritance) continue;
			const fields = relies_on_inheritance ? { ...range.fields } : { ...range.own_fields };
			if (range.meta?.syntax !== "attributes" && Object.keys(fields).length === Object.keys(range.own_fields).length)
				continue;
			result.changes.push(...preview(range, fields, "legacy"));
			result.converted++;
		}
	}
	return result;
}
