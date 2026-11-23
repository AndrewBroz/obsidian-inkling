<script lang="ts">
	import {
	SettingItem,
	Slider,
	Toggle,
} from "../../../components";

import { AnnotationInclusionType } from "../../../../constants";
import type CommentatorPlugin from "../../../../main";

let { plugin }: { plugin: CommentatorPlugin } = $props();
</script>

<SettingItem name="Change markers" type="heading" />

<SettingItem
	name="Show change markers in the margin"
	description="Mark the lines that have suggested changes in the margin"
	notices={[
		{
			type: "info",
			text:
				"Click a marker to accept or reject all changes in that block",
		},
	]}
	type="toggle"
>
	{#snippet control()}
		<Toggle
			slot="control"
			value={plugin.settings.diff_gutter}
			onChange={() => {
				plugin.settings.diff_gutter = !plugin.settings.diff_gutter;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<SettingItem
	name="Hide when empty"
	description="When the note has no changes, the margin takes no space"
	notices={[{
		type: "info",
		text:
			"When enabled, switching between different notes may cause content to shift",
	}]}
	type="toggle"
	depth={1}
>
	{#snippet control()}
		<Toggle
			slot="control"
			value={plugin.settings.diff_gutter_hide_empty}
			onChange={() => {
				plugin.settings.diff_gutter_hide_empty = !plugin.settings
					.diff_gutter_hide_empty;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<SettingItem name="Comments beside the note" type="heading" />

<SettingItem
	name="Show comments beside the note"
	description="Show comments and suggestions in a column beside the note"
	type="toggle"
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.annotation_gutter}
			onChange={() => {
				plugin.settings.annotation_gutter = !plugin.settings.annotation_gutter;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<SettingItem
	name="Included annotations"
	description="Determine which annotations should be shown by default"
	notices={[{ type: "info", text: "This setting only applies after reloading the app" }]}
	type="subheading"
	depth={1}
/>
{#each Object.keys(AnnotationInclusionType).filter(key => isNaN(Number(key))) as key (key)}
	<SettingItem
		name={key.toLowerCase().replace(/\b\w/g, s => s.toUpperCase())}
		type="toggle"
		depth={2}
	>
		{#snippet control()}
			<Toggle
				value={(plugin.settings.annotation_gutter_included_types &
				AnnotationInclusionType[key]) !== 0}
				onChange={() => {
					plugin.settings.annotation_gutter_included_types ^=
						AnnotationInclusionType[key];
					void plugin.saveSettings();
				}}
			/>
		{/snippet}
	</SettingItem>
{/each}

<SettingItem
	name="Focus annotation on selection"
	description="When you select an annotation in the note, its card in the comment column is selected too"
	type="toggle"
	depth={1}
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.annotation_gutter_focus_on_click}
			onChange={() => {
				plugin.settings.annotation_gutter_focus_on_click = !plugin.settings
					.annotation_gutter_focus_on_click;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<SettingItem
	name="Width"
	description="The width of the comment column, in pixels"
	type="slider"
	depth={1}
>
	{#snippet control()}
		<Slider
			min={100}
			max={500}
			step={50}
			value={plugin.settings.annotation_gutter_width}
			onChange={(value: number) => {
				plugin.settings.annotation_gutter_width = value;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<SettingItem
	name="Show resize handle"
	description="Drag the line between the note and the comment column to change the column's width"
	type="toggle"
	depth={1}
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.annotation_gutter_resize_handle}
			onChange={() => {
				plugin.settings.annotation_gutter_resize_handle = !plugin.settings
					.annotation_gutter_resize_handle;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<SettingItem
	name="Hide comments by default"
	description="Start with the comment column hidden"
	notices={[{ type: "info", text: "This setting only applies after reloading the app" }]}
	type="toggle"
	depth={1}
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.annotation_gutter_default_fold_state}
			onChange={() => {
				plugin.settings.annotation_gutter_default_fold_state = !plugin.settings
					.annotation_gutter_default_fold_state;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<SettingItem
	name="Show the hide/show comments button"
	description="A round button on the line beside the comment column that hides or shows it"
	type="toggle"
	depth={1}
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.annotation_gutter_fold_button}
			onChange={() => {
				plugin.settings.annotation_gutter_fold_button = !plugin.settings
					.annotation_gutter_fold_button;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<SettingItem
	name="Hide when empty"
	description="When the note has no comments or suggestions, the comment column takes no space"
	notices={[{
		type: "info",
		text:
			"When enabled, switching between different notes may cause content to shift",
	}]}
	type="toggle"
	depth={1}
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.annotation_gutter_hide_empty}
			onChange={() => {
				plugin.settings.annotation_gutter_hide_empty = !plugin.settings
					.annotation_gutter_hide_empty;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>
