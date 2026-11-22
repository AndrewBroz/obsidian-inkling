<script lang="ts">
	import { Dropdown, SettingItem, Toggle } from "../../../components";

import type CommentatorPlugin from "../../../../main";
import { SuggestionType } from "../../../../editor/base";
import { RANGE_BRACKET_MOVEMENT_OPTION, RANGE_CURSOR_MOVEMENT_OPTION } from "../../../../types";

let { plugin }: { plugin: CommentatorPlugin } = $props();

const suggestion_ranges: Record<SuggestionType, { icon: string; tooltip: string }> = {
	[SuggestionType.ADDITION]: { icon: "plus-circle", tooltip: "Additions" },
	[SuggestionType.DELETION]: { icon: "minus-square", tooltip: "Deletions" },
	[SuggestionType.SUBSTITUTION]: { icon: "replace", tooltip: "Substitutions" },
	[SuggestionType.HIGHLIGHT]: { icon: "highlighter", tooltip: "Highlights" },
	[SuggestionType.COMMENT]: { icon: "message-square", tooltip: "Comments" },
};
const suggestion_types = Object.values(SuggestionType);

const cursor_movement_options = [
	{ value: "unchanged", text: "Regular movement" },
	{ value: "ignore_bracket", text: "Skip brackets" },
	{ value: "ignore_metadata", text: "Skip brackets and metadata" },
	{ value: "ignore_completely", text: "Skip completely" },
];

const bracket_movement_options = [
	{ value: "unchanged", text: "Regular movement" },
	{ value: "stay_inside", text: "Keep cursor within range" },
	{ value: "stay_outside", text: "Treat range as word group" },
];
</script>

<SettingItem name="Functionality" type="heading" />

<SettingItem name="Suggestion mode" type="heading" depth={1} />

<SettingItem name="Cursor movement" type="heading" depth={2} />
{#each suggestion_types as type (type)}
	<SettingItem name={suggestion_ranges[type].tooltip} type="dropdown" depth={2}>
		{#snippet control()}
			<Dropdown
				value={plugin.settings.suggestion_mode_operations.cursor_movement[type]}
				options={cursor_movement_options}
				onChange={(value: string) => {
					plugin.settings.suggestion_mode_operations.cursor_movement[type] = value as RANGE_CURSOR_MOVEMENT_OPTION;
					void plugin.saveSettings();
				}}
			/>
		{/snippet}
	</SettingItem>
{/each}

<SettingItem name="Bracket movement" type="heading" depth={2} />
{#each suggestion_types as type (type)}
	<SettingItem name={suggestion_ranges[type].tooltip} type="dropdown" depth={2}>
		{#snippet control()}
			<Dropdown
				value={plugin.settings.suggestion_mode_operations.bracket_movement[type]}
				options={bracket_movement_options}
				onChange={(value: string) => {
					plugin.settings.suggestion_mode_operations.bracket_movement[type] = value as RANGE_BRACKET_MOVEMENT_OPTION;
					void plugin.saveSettings();
				}}
			/>
		{/snippet}
	</SettingItem>
{/each}

<SettingItem
	name="Suggestion mode cursor movement"
	description="Determine how the cursor should move through suggestions in suggestion mode"
	type="dropdown"
></SettingItem>

<SettingItem name="Rendering" type="heading" />

<SettingItem
	name="Live Preview renderer"
	description="Enable custom rendering of CriticMarkup syntax in Live Preview"
	type="toggle"
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.live_preview}
			onChange={() => {
				plugin.settings.live_preview = !plugin.settings.live_preview;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<SettingItem
	name="Reading View renderer"
	description="Enable custom rendering of CriticMarkup syntax in Reading View"
	type="toggle"
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.post_processor}
			onChange={() => {
				plugin.settings.post_processor = !plugin.settings.post_processor;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>
