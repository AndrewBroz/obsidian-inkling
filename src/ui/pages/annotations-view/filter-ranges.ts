import { search } from "@codemirror/search";
import { prepareSimpleSearch, TFile } from "obsidian";
import { type DatabaseEntry } from "../../../database";
import {
	type CommentRange,
	type CriticMarkupRange,
	SuggestionType,
	thread_resolved,
} from "../../../editor/base";
import type CommentatorPlugin from "../../../main";

export const enum SuggestionTypeFilter {
	ALL,
	ADDITION,
	DELETION,
	SUBSTITUTION,
	HIGHLIGHT,
	COMMENT,
}

export const enum LocationFilter {
	VAULT,
	FOLDER,
	FILE,
}

export const enum ContentFilter {
	ALL,
	CONTENT,
	EMPTY,
}

export const enum AuthorFilter {
	ALL,
	SELF,
	OTHERS,
}

export const enum ResolvedFilter {
	ALL,
	UNRESOLVED,
	RESOLVED,
}

const SuggestionTypeValues = Object.values(SuggestionType);

/**
 * Filter ranges based on various criteria.
 * @param plugin - The Commentator plugin instance.
 * @param items - Database entries containing ranges to filter.
 * @param search_filter - Search term to filter ranges by text.
 * @param location_filter - Filter by location (vault, folder, file).
 * @param range_type_filter - Filter by type of suggestion (addition, deletion, etc.).
 * @param content_filter - Filter by content (empty or not).
 * @param author_filter - Filter by author of the range.
 * @param date_filter - Filter by date range of the range's metadata.
 * @param active_file - The currently active file in the editor, used for location filtering.
 * @param resolved_filter - Filter by resolved status of the thread (defaults to UNRESOLVED).
 */
export function filterRanges(
	plugin: CommentatorPlugin,
	items?: DatabaseEntry<CriticMarkupRange[]>[],
	search_filter?: string,
	location_filter?: LocationFilter,
	range_type_filter?: SuggestionTypeFilter,
	content_filter?: ContentFilter,
	author_filter?: AuthorFilter,
	date_filter?: number[],
	active_file?: TFile | null,
	resolved_filter: ResolvedFilter = ResolvedFilter.UNRESOLVED,
) {
	if (!items)
		return [];

	let basic_ranges = items;

	// EXPL: Filter by location (vault, folder, file)
	if (location_filter !== LocationFilter.VAULT) {
		if (active_file) {
			if (location_filter === LocationFilter.FOLDER) {
				const parent_path = active_file.parent?.path === "/" ? undefined : active_file.parent?.path;
				if (!parent_path)
					basic_ranges = items;
				else
					basic_ranges = items.filter(([key, _]) => key.startsWith(parent_path));
			} else if (location_filter === LocationFilter.FILE) {
				basic_ranges = items.filter(([key, _]) => key === active_file.path);
			}
		}
	}

	let filtered_ranges = basic_ranges.flatMap(([path, value]) =>
		value.data.map((range) => {
			return { path, range };
		})
	);

	// EXPL: Only keep the top-level ranges
	filtered_ranges = filtered_ranges.filter(
		(item) =>
			item.range.type !== SuggestionType.COMMENT ||
			!(item.range as CommentRange).attached_comment,
	);

	// EXPL: Filter by resolved status. Independent of enable_metadata: when metadata parsing is
	// off, no range ever carries `done`, so everything is simply unresolved.
	if (resolved_filter !== ResolvedFilter.ALL) {
		filtered_ranges = filtered_ranges.filter(
			(item) => thread_resolved(item.range) === (resolved_filter === ResolvedFilter.RESOLVED),
		);
	}

	// EXPL: Filter by type (addition, deletion, etc.)
	if (range_type_filter !== undefined && range_type_filter !== SuggestionTypeFilter.ALL) {
		filtered_ranges = filtered_ranges.filter(
			(item) =>
				item.range.full_thread.some(
					(range) => range.type === SuggestionTypeValues[range_type_filter - 1],
				),
		);
	}

	// EXPL: Filter by content (empty or not)
	if (content_filter !== ContentFilter.ALL) {
		filtered_ranges = filtered_ranges.filter(
			(item) =>
				item.range.full_thread.some(
					(range) => (content_filter === ContentFilter.CONTENT) !== range.empty(),
				),
		);
	}

	// EXPL: Filter by metadata
	if (plugin.settings.enable_metadata) {
		// EXPL: Filter by author metadata
		if (
			plugin.settings.enable_author_metadata &&
			author_filter !== AuthorFilter.ALL &&
			plugin.settings.author
		) {
			if (author_filter === AuthorFilter.SELF) {
				filtered_ranges = filtered_ranges.filter(
					// (item) => item.range.fields.author === plugin.settings.author,
					(item) =>
						item.range.full_thread.some(
							(range) => range.fields.author === plugin.settings.author,
						),
				);
			} else if (author_filter === AuthorFilter.OTHERS) {
				filtered_ranges = filtered_ranges.filter(
					(item) =>
						item.range.full_thread.some(
							(range) =>
								range.fields.author &&
								range.fields.author !== plugin.settings.author,
						),
				);
			}
		}

		// EXPL: Filter by date metadata
		if (plugin.settings.enable_timestamp_metadata && date_filter) {
			if (date_filter[0] && date_filter[1]) {
				filtered_ranges = filtered_ranges.filter(
					(item) =>
						item.range.full_thread.some(
							(range) =>
								range.fields.time &&
								range.fields.time >= date_filter![0] &&
								range.fields.time <= date_filter![1],
						),
				);
			} else if (date_filter[0]) {
				filtered_ranges = filtered_ranges.filter(
					(item) =>
						item.range.full_thread.some(
							(range) =>
								range.fields.time &&
								range.fields.time >= date_filter![0],
						),
				);
			} else if (date_filter[1]) {
				filtered_ranges = filtered_ranges.filter(
					(item) =>
						item.range.full_thread.some(
							(range) =>
								range.fields.time &&
								range.fields.time <= date_filter![1],
						),
				);
			}
		}
	}

	// EXPL: Filter by search terms
	if (search_filter?.length) {
		filtered_ranges = filtered_ranges.filter(
			(item) => prepareSimpleSearch(search_filter)(item.range.full_text)?.score,
		);
	}

	return filtered_ranges;
}
