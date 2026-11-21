import type { MetadataSyntax, PluginSettings } from "../../../types";
import { CM_All_Brackets, type MetadataFields, SuggestionType } from "../ranges";
import { serializeAttrBlock, unconvertibleContent, unconvertibleReason } from "./attributes";
import { generate_metadata } from "./metadata";

export function construct_suggestion(
	inserted: string,
	deleted: string,
	metadata_fields?: MetadataFields,
	start_offset = 0,
	end_offset = 0,
) {
	return construct_range(
		inserted,
		deleted,
		inserted && deleted ?
			SuggestionType.SUBSTITUTION :
			(inserted ? SuggestionType.ADDITION : SuggestionType.DELETION),
		metadata_fields,
		start_offset,
		end_offset,
	);
}

export function construct_range(
	inserted: string,
	deleted: string,
	type: SuggestionType,
	metadata_fields?: MetadataFields,
	start_offset = 0,
	end_offset = 0,
) {
	if (!type)
		return { insert: deleted + inserted, start_offset, end_offset };

	const brackets = CM_All_Brackets[type];
	const has_fields = !!metadata_fields && Object.values(metadata_fields).some(value => value !== undefined);
	const body = type === SuggestionType.SUBSTITUTION ?
		deleted + brackets[1] + inserted + brackets[2] :
		deleted + inserted + brackets[1];
	// EXPL: Legacy metadata is deprecated and never written by choice: always attribute blocks, except where they
	//       would lose something. Merging into a legacy range can carry fields a block cannot hold, and content that
	//       starts with a JSON object and `@@` would read back as legacy metadata; keep both legacy.
	const syntax: MetadataSyntax =
		has_fields && (unconvertibleReason(metadata_fields!) || unconvertibleContent(brackets[0] + body)) ?
			"legacy" :
			"attributes";
	// EXPL: Legacy metadata sits between the opener and the content, so it shifts every offset into the range.
	//       An attribute block sits after the closer and shifts nothing the caller measures.
	const prefix = has_fields && syntax === "legacy" ? JSON.stringify(metadata_fields) + "@@" : "";
	const suffix = has_fields && syntax === "attributes" ? serializeAttrBlock(metadata_fields!) : "";
	const output = brackets[0] + prefix + body + suffix;
	start_offset += brackets[0].length + prefix.length;
	// FIXME: end may not be offset if the bracket appears after the end
	end_offset += type === SuggestionType.SUBSTITUTION ? brackets[1].length : 0;

	return { insert: output, start_offset, end_offset };
}

export function create_suggestion(settings: PluginSettings, inserted: string, deleted: string = "") {
	return construct_suggestion(inserted, deleted, generate_metadata(settings)).insert;
}

/** A new range with freshly generated metadata. */
export function create_range(settings: PluginSettings, type: SuggestionType, inserted: string, deleted: string = "") {
	return construct_range(inserted, deleted, type, generate_metadata(settings)).insert;
}

/**
 * A highlight with its first comment, written in one action. Metadata is generated once, so the pair can never
 * straddle a second boundary. Thread rule 2: the anchor states nothing and inherits from the comment.
 */
export function create_anchored_comment(settings: PluginSettings, anchor_text: string, comment_text: string) {
	const fields = generate_metadata(settings);
	return construct_range(anchor_text, "", SuggestionType.HIGHLIGHT, undefined).insert +
		construct_range(comment_text, "", SuggestionType.COMMENT, fields).insert;
}
