import type { SettingDefinitionItem, SettingGroupItem } from "obsidian";

import { AnnotationInclusionType } from "../constants";
import { author_at_warning } from "../editor/base/edit-util/attributes";
import { SuggestionType } from "../editor/base/ranges/definitions";
import type CommentatorPlugin from "../main";
import { EditMode, PreviewMode, RANGE_BRACKET_MOVEMENT_OPTION, RANGE_CURSOR_MOVEMENT_OPTION } from "../types";
import { openGithubIssueLink } from "../util/obsidian-util";

/*
 * Inkling's settings as Obsidian 1.13+ setting definitions, so they appear in the settings search. They mirror the
 * Svelte settings page (pages/settings), which older versions of Obsidian still show.
 *
 * Most controls are keyed by their PluginSettings field. A few keys name something inside a field; the tab
 * (settings.ts) reads and writes them through `readSetting` and `writeSetting` below.
 */

const CURSOR_MOVEMENT = "cursor_movement:";
const BRACKET_MOVEMENT = "bracket_movement:";
const INCLUDED_ANNOTATION = "annotation_gutter_included_types:";

const SUGGESTION_TYPE_NAMES: Record<SuggestionType, string> = {
	[SuggestionType.ADDITION]: "Additions",
	[SuggestionType.DELETION]: "Deletions",
	[SuggestionType.SUBSTITUTION]: "Substitutions",
	[SuggestionType.HIGHLIGHT]: "Highlights",
	[SuggestionType.COMMENT]: "Comments",
};

const INCLUDED_ANNOTATION_TYPES: [keyof typeof AnnotationInclusionType, string][] = [
	["ADDITION", "Addition"],
	["DELETION", "Deletion"],
	["SUBSTITUTION", "Substitution"],
	["HIGHLIGHT", "Highlight"],
	["COMMENT", "Comment"],
];

/** The value a control key stands for. */
export function readSetting(plugin: CommentatorPlugin, key: string): unknown {
	const settings = plugin.settings;
	if (key.startsWith(CURSOR_MOVEMENT))
		return settings.suggestion_mode_operations.cursor_movement[key.slice(CURSOR_MOVEMENT.length) as SuggestionType];
	if (key.startsWith(BRACKET_MOVEMENT))
		return settings.suggestion_mode_operations.bracket_movement[key.slice(BRACKET_MOVEMENT.length) as SuggestionType];
	if (key.startsWith(INCLUDED_ANNOTATION)) {
		const bit = AnnotationInclusionType[key.slice(INCLUDED_ANNOTATION.length) as keyof typeof AnnotationInclusionType];
		return (settings.annotation_gutter_included_types & bit) !== 0;
	}
	// EXPL: Dropdown options are strings; these two are stored as numbers.
	if (key === "default_edit_mode" || key === "default_preview_mode") return String(settings[key]);
	return (settings as unknown as Record<string, unknown>)[key];
}

/** Stores `value` for a control key (the caller saves the settings). */
export function writeSetting(plugin: CommentatorPlugin, key: string, value: unknown) {
	const settings = plugin.settings;
	if (key.startsWith(CURSOR_MOVEMENT)) {
		settings.suggestion_mode_operations.cursor_movement[key.slice(CURSOR_MOVEMENT.length) as SuggestionType] =
			value as RANGE_CURSOR_MOVEMENT_OPTION;
	} else if (key.startsWith(BRACKET_MOVEMENT)) {
		settings.suggestion_mode_operations.bracket_movement[key.slice(BRACKET_MOVEMENT.length) as SuggestionType] =
			value as RANGE_BRACKET_MOVEMENT_OPTION;
	} else if (key.startsWith(INCLUDED_ANNOTATION)) {
		const bit = AnnotationInclusionType[key.slice(INCLUDED_ANNOTATION.length) as keyof typeof AnnotationInclusionType];
		settings.annotation_gutter_included_types = value ?
			settings.annotation_gutter_included_types | bit :
			settings.annotation_gutter_included_types & ~bit;
	} else if (key === "default_edit_mode") {
		settings.default_edit_mode = parseInt(value as string);
	} else if (key === "default_preview_mode") {
		settings.default_preview_mode = parseInt(value as string);
	} else {
		(settings as unknown as Record<string, unknown>)[key] = value;
	}
}

function toggle(key: string, name: string, desc?: string, visible?: () => boolean): SettingGroupItem {
	return { name, desc, visible, control: { type: "toggle", key } };
}

export function settingDefinitions(plugin: CommentatorPlugin): SettingDefinitionItem[] {
	const settings = plugin.settings;
	return [
		{
			type: "group",
			items: [
				{
					name: "Default edit mode",
					desc: "When opening a new note, this will be the default editing mode",
					control: {
						type: "dropdown",
						key: "default_edit_mode",
						options: {
							[EditMode.CORRECTED]: "Editing",
							[EditMode.SUGGEST]: "Suggesting",
							[EditMode.COMMENT]: "Commenting",
						},
					},
				},
				{
					name: "Default preview mode",
					desc: "When opening a new note, this will be the default preview mode",
					control: {
						type: "dropdown",
						key: "default_preview_mode",
						options: {
							[PreviewMode.ALL]: "View all suggestions",
							[PreviewMode.ACCEPT]: "Preview 'accept all'",
							[PreviewMode.REJECT]: "Preview 'reject all'",
						},
					},
				},
				toggle(
					"enable_metadata",
					"Include Metadata Extension",
					"Allow inclusion of metadata for suggestions, such as authorship, time, etc. Suggestion metadata is " +
						"not part of the official CriticMarkup standard, so other editors won't process or show it. " +
						"Toggling this setting re-indexes the entire vault.",
				),
				{
					name: "Report a bug",
					desc: "Opens a bug report on GitHub with your Obsidian and Inkling versions filled in",
					render: (setting) => {
						setting.addButton(button =>
							button.setIcon("bug").setButtonText("Report bug").onClick(() => openGithubIssueLink(plugin.app))
						);
					},
				},
			],
		},
		{
			type: "group",
			heading: "Database",
			items: [
				{
					name: "Database Workers",
					desc: "Number of workers to use for database indexing. More workers index faster.",
					control: {
						type: "slider",
						key: "database_workers",
						min: 1,
						max: Math.max(1, navigator.hardwareConcurrency / 2),
						step: 1,
					},
				},
				{
					name: "Rebuild Database",
					desc: "Recommended if you're encountering issues with the view after updating. In large vaults, " +
						"reindexing the database may take a while.",
					render: (setting) => {
						setting.addButton(button =>
							button.setButtonText("Rebuild").onClick(() => void plugin.database.reinitializeDatabase())
						);
					},
				},
			],
		},
		{
			type: "group",
			heading: "Editing features",
			items: [
				toggle(
					"tag_completion",
					"Automatic tag completion",
					"When typing {++, the tag automatically gets completed with ++}",
				),
				toggle(
					"clipboard_remove_syntax",
					"Remove syntax on copy",
					"When copying in the editor to the clipboard, any CriticMarkup syntax is removed. Copying " +
						"\"my {++text++}\" will result in \"my text\".",
				),
				toggle(
					"tag_correcter",
					"Automatic tag correction",
					"Dangling tags and redundant whitespaces automatically get removed to prevent invalid CriticMarkup syntax",
				),
				toggle("editor_styling", "Show style while editing", "Keep the style of suggestions visible while editing"),
				toggle(
					"reveal_syntax_on_focus",
					"Reveal CriticMarkup syntax under the cursor",
					"Show brackets and metadata for the range your cursor is inside — useful for repairing malformed " +
						"markup. Placing the cursor inside {++text++} reveals the {++ and ++} brackets, in any editing mode.",
				),
			],
		},
		{
			type: "group",
			heading: "Comments Rendering",
			items: [
				{
					name: "Comment rendering mode",
					desc: "Determine how comments are rendered inside the editor. Inline: comments get a background color " +
						"and are fully visible. Icon: comments are icons you hover to read. Hidden: comments aren't shown " +
						"in the editor (use this with the annotation gutter).",
					control: {
						type: "dropdown",
						key: "comment_style",
						options: { inline: "Inline", icon: "Icon", none: "Hidden" },
					},
				},
				toggle(
					"remove_on_resolve",
					"Remove comments on resolve",
					"Resolving a thread deletes it instead of marking it done. Highlighted text is kept. Undo restores " +
						"it. Threads resolved earlier can be removed with “Remove resolved comments in this note”.",
				),
				toggle(
					"cleanup_broken_markup",
					"Clean up broken markup automatically",
					"When a note opens or sync changes it, remove stray CriticMarkup brackets and orphaned metadata. Text " +
						"is never removed. Undo restores it.",
				),
			],
		},
		{
			type: "group",
			heading: "Editor header",
			items: [
				toggle("toolbar_show_buttons_labels", "Full button labels", "Adds labels to the buttons in the editor header"),
				toggle(
					"toolbar_preview_button",
					"Preview mode header button",
					"Adds a button to the editor's header for quickly changing preview mode",
				),
				toggle(
					"toolbar_edit_button",
					"Suggestion mode header button",
					"Adds a button to the editor's header for quickly toggling suggestion mode",
				),
			],
		},
		{
			type: "group",
			heading: "Editor status bar",
			items: [
				toggle(
					"status_bar_preview_button",
					"Preview mode status bar toggle",
					"Adds a status bar item for quickly selecting suggestion mode",
				),
				toggle(
					"status_bar_edit_button",
					"Suggestion mode status bar toggle",
					"Adds a status bar item for quickly selecting suggestion mode",
				),
				toggle(
					"status_bar_metadata_button",
					"Metadata status bar toggle",
					"Adds a status bar item for quickly toggling the inclusion of (particular) metadata",
				),
			],
		},
		{
			type: "group",
			heading: "Diff gutter",
			items: [
				toggle(
					"diff_gutter",
					"Enable diff gutter",
					"Display a gutter in the editor for showing changes from suggestions. Clicking on the gutter reveals " +
						"a menu for accepting/rejecting all changes within the block.",
				),
				toggle(
					"diff_gutter_hide_empty",
					"Hide when empty",
					"When enabled, the gutter will not take up any space when there are no changes in the current note. " +
						"Switching between notes may then cause content to shift.",
				),
			],
		},
		{
			type: "group",
			heading: "Annotation gutter",
			items: [
				toggle("annotation_gutter", "Enable annotation gutter", "Display a gutter in the editor for annotations"),
				...INCLUDED_ANNOTATION_TYPES.map(([type, name]) =>
					toggle(
						INCLUDED_ANNOTATION + type,
						`Included annotations: ${name}`,
						"Whether the gutter shows this kind of annotation by default. Applies after reloading the app.",
					)
				),
				toggle(
					"annotation_gutter_focus_on_click",
					"Focus annotation on selection",
					"When selecting an annotation in the editor, the corresponding annotation in the gutter will be focused",
				),
				{
					name: "Width",
					desc: "The width of the gutter in pixels",
					control: { type: "slider", key: "annotation_gutter_width", min: 100, max: 500, step: 50 },
				},
				toggle(
					"annotation_gutter_resize_handle",
					"Show resize handle",
					"Display a handle bar within the editor for quickly resizing the gutter",
				),
				toggle(
					"annotation_gutter_default_fold_state",
					"Default fold state",
					"Determine whether the gutter is shown by default. Applies after reloading the app.",
				),
				toggle(
					"annotation_gutter_fold_button",
					"Show fold button",
					"Display a button within the editor for (un)folding the gutter",
				),
				toggle(
					"annotation_gutter_hide_empty",
					"Hide when empty",
					"When enabled, the gutter will not take up any space when there are no annotations in the current " +
						"note. Switching between notes may then cause content to shift.",
				),
			],
		},
		{
			type: "group",
			heading: "Metadata",
			items: [
				toggle("enable_metadata", "Add Metadata"),
				toggle("enable_author_metadata", "Enable Authorship", "Enable rendering and processing of author metadata"),
				toggle(
					"add_author_metadata",
					"Add Author Metadata",
					"Author metadata will be added into new suggestions and comments",
					() => settings.enable_author_metadata,
				),
				{
					name: "Name",
					desc: "The author name added to new suggestions and comments",
					visible: () => settings.enable_author_metadata,
					render: (setting) => {
						// EXPL: A warning, not a rejection (a control's `validate` would refuse the name).
						const showWarning = (author: string) =>
							setting.setDesc(
								author_at_warning(author) ?? "The author name added to new suggestions and comments",
							);
						showWarning(settings.author ?? "");
						setting.addText(text =>
							text.setValue(settings.author ?? "").onChange(value => {
								settings.author = value;
								showWarning(value);
								void plugin.saveSettings();
							})
						);
					},
				},
				toggle(
					"enable_timestamp_metadata",
					"Enable Timestamp",
					"Enable rendering and processing of timestamp metadata",
				),
				toggle(
					"add_timestamp_metadata",
					"Add Timestamp Metadata",
					"Timestamp metadata will be added into new suggestions and comments",
					() => settings.enable_timestamp_metadata,
				),
				toggle(
					"enable_completed_metadata",
					"Enable Completed",
					"Enable rendering and processing of completed metadata",
				),
				toggle(
					"add_completed_metadata",
					"Add Completed Metadata",
					"Completed metadata will be added into new suggestions and comments",
					() => settings.enable_completed_metadata,
				),
				toggle("enable_style_metadata", "Enable Style", "Enable rendering and processing of style metadata"),
				toggle(
					"add_style_metadata",
					"Add Style Metadata",
					"Style metadata will be added into new suggestions and comments",
					() => settings.enable_style_metadata,
				),
				toggle("enable_color_metadata", "Enable Color", "Enable rendering and processing of color metadata"),
				toggle(
					"add_color_metadata",
					"Add Color Metadata",
					"Color metadata will be added into new suggestions and comments",
					() => settings.enable_color_metadata,
				),
			],
		},
		{
			type: "group",
			heading: "Suggestion mode: cursor movement",
			items: Object.values(SuggestionType).map(type => ({
				name: SUGGESTION_TYPE_NAMES[type],
				desc: `How the cursor moves through ${SUGGESTION_TYPE_NAMES[type].toLowerCase()} in suggestion mode`,
				aliases: ["cursor movement", "suggestion mode"],
				control: {
					type: "dropdown",
					key: CURSOR_MOVEMENT + type,
					options: {
						[RANGE_CURSOR_MOVEMENT_OPTION.UNCHANGED]: "Regular movement",
						[RANGE_CURSOR_MOVEMENT_OPTION.IGNORE_BRACKET]: "Skip brackets",
						[RANGE_CURSOR_MOVEMENT_OPTION.IGNORE_METADATA]: "Skip brackets and metadata",
						[RANGE_CURSOR_MOVEMENT_OPTION.IGNORE_COMPLETELY]: "Skip completely",
					},
				},
			})),
		},
		{
			type: "group",
			heading: "Suggestion mode: bracket movement",
			items: Object.values(SuggestionType).map(type => ({
				name: SUGGESTION_TYPE_NAMES[type],
				desc: `How the cursor moves past the brackets of ${
					SUGGESTION_TYPE_NAMES[type].toLowerCase()
				} in suggestion mode`,
				aliases: ["bracket movement", "suggestion mode"],
				control: {
					type: "dropdown",
					key: BRACKET_MOVEMENT + type,
					options: {
						[RANGE_BRACKET_MOVEMENT_OPTION.UNCHANGED]: "Regular movement",
						[RANGE_BRACKET_MOVEMENT_OPTION.STAY_INSIDE]: "Keep cursor within range",
						[RANGE_BRACKET_MOVEMENT_OPTION.STAY_OUTSIDE]: "Treat range as word group",
					},
				},
			})),
		},
		{
			type: "group",
			heading: "Rendering",
			items: [
				toggle("live_preview", "Live Preview renderer", "Enable custom rendering of CriticMarkup syntax in Live Preview"),
				toggle(
					"post_processor",
					"Reading View renderer",
					"Enable custom rendering of CriticMarkup syntax in Reading View",
				),
			],
		},
	];
}
