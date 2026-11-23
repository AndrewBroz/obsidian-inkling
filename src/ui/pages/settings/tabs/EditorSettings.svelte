<script lang="ts">
	import { Dropdown, SettingItem, Toggle } from "../../../components";

import type CommentatorPlugin from "../../../../main";
import type { PluginSettings } from "../../../../types";

let { plugin }: { plugin: CommentatorPlugin } = $props();

let comment_rendering_mode = $state(plugin.settings.comment_style);
let comment_rendering_mode_notices = {
	inline:
		"Comments receive a background color and are fully visible (similar to suggestions)",
	icon:
		"Comments are displayed as icons and can be hovered over to reveal the comment",
	none:
		"Comments are not rendered in the editor; use this with the comment column",
};
</script>

<SettingItem name="Editing features" type="heading" />

<SettingItem
	name="Automatic tag completion"
	notices={[
		{
			type: "info",
			text:
				"When typing {++, the tag automatically gets completed with ++}",
		},
	]}
	type="toggle"
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.tag_completion}
			onChange={() => {
				plugin.settings.tag_completion = !plugin.settings.tag_completion;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<SettingItem
	name="Remove syntax on copy"
	description="When copying in the editor to the clipboard, any CriticMarkup syntax is removed"
	notices={[
		{
			type: "info",
			text:
				"Copying \"my {++text++}\" will result in \"my text\"",
		},
	]}
	type="toggle"
>
	{#snippet control()}
		<Toggle
			slot="control"
			value={plugin.settings.clipboard_remove_syntax}
			onChange={() => {
				plugin.settings.clipboard_remove_syntax = !plugin.settings
					.clipboard_remove_syntax;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<SettingItem
	name="Automatic tag correction"
	description="Dangling tags and redundant whitespaces automatically get removed to prevent invalid CriticMarkup syntax"
	type="toggle"
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.tag_correcter}
			onChange={() => {
				plugin.settings.tag_correcter = !plugin.settings.tag_correcter;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<!--<SettingItem-->
<!--	name="Edit Info"-->
<!--	description="Display a warning when editing a suggestion is not allowed due to editing rules"-->
<!--	type='toggle'-->
<!--&gt;-->
<!--	<Toggle-->
<!--		slot='control'-->
<!--		value={plugin.settings.edit_info}-->
<!--		onChange={() => {-->
<!--			plugin.settings.edit_info = !plugin.settings.edit_info;-->
<!--			plugin.saveSettings();-->
<!--		}}-->
<!--	/>-->
<!--</SettingItem>-->

<SettingItem
	name="Show style while editing"
	description="Keep the style of suggestions visible while editing"
	type="toggle"
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.editor_styling}
			onChange={() => {
				plugin.settings.editor_styling = !plugin.settings.editor_styling;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<SettingItem
	name="Reveal CriticMarkup syntax under the cursor"
	description="Show brackets and metadata for the range your cursor is inside — useful for repairing malformed markup"
	notices={[
		{
			type: "info",
			text:
				"Placing the cursor inside {++text++} reveals the {++ and ++} brackets, in any editing mode",
		},
	]}
	type="toggle"
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.reveal_syntax_on_focus}
			onChange={() => {
				plugin.settings.reveal_syntax_on_focus = !plugin.settings
					.reveal_syntax_on_focus;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<SettingItem name="Comments Rendering" type="heading" />

<SettingItem
	name="Comment rendering mode"
	description="Determine how comments are rendered inside the editor"
	notices={[
		{
			type: "info",
			text: comment_rendering_mode_notices[comment_rendering_mode],
		},
	]}
	type="dropdown"
>
	{#snippet control()}
		<Dropdown
			options={[
				{ value: "inline", text: "Inline" },
				{ value: "icon", text: "Icon" },
				{ value: "none", text: "Hidden" },
			]}
			value={comment_rendering_mode}
			onChange={(value: string) => {
				plugin.settings.comment_style = value as PluginSettings["comment_style"];
				comment_rendering_mode = plugin.settings.comment_style;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<SettingItem
	name="Remove comments on resolve"
	description="Resolving a thread deletes it instead of marking it done. Highlighted text is kept. Undo restores it. Threads resolved earlier can be removed with “Remove resolved comments in this note”."
	type="toggle"
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.remove_on_resolve}
			onChange={(value: boolean) => {
				plugin.settings.remove_on_resolve = value;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<SettingItem
	name="Clean up broken markup automatically"
	description="When a note opens or sync changes it, remove stray CriticMarkup brackets and orphaned metadata. Text is never removed. Undo restores it."
	type="toggle"
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.cleanup_broken_markup}
			onChange={(value: boolean) => {
				plugin.settings.cleanup_broken_markup = value;
				void plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>
