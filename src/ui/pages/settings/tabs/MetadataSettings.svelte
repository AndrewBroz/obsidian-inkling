<script lang="ts">
	import { author_at_warning } from "../../../../editor/base/edit-util/attributes";
import { Dropdown, Input, SettingItem, Toggle } from "../../../components";

import type CommentatorPlugin from "../../../../main";
import type { MetadataSyntax } from "../../../../types";

let { plugin }: { plugin: CommentatorPlugin } = $props();
</script>

<SettingItem name="Add Metadata" type="toggle">
	{#snippet control()}
		<Toggle
			value={plugin.settings.enable_metadata}
			onChange={(value) => {
				plugin.settings.enable_metadata = value;
				plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<SettingItem
	name="Metadata format"
	description="How Inkling writes author, time and resolution. Both formats are always read. Attribute blocks avoid ZotLit citation false positives, but collaborators need Inkling 0.13 or later, and Commentator does not read them."
>
	{#snippet control()}
		<Dropdown
			value={plugin.settings.metadata_syntax}
			options={[
				{ value: "legacy", text: "Legacy ({json}@@)" },
				{ value: "attributes", text: "Attribute blocks" },
			]}
			onChange={(value) => {
				plugin.settings.metadata_syntax = value as MetadataSyntax;
				plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

<SettingItem
	name="Enable Authorship"
	description="Enable rendering and processing of author metadata"
	type="toggle"
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.enable_author_metadata}
			onChange={(value) => {
				plugin.settings.enable_author_metadata = value;
				plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

{#if plugin.settings.enable_author_metadata}
	<SettingItem
		name="Add Author Metadata"
		description="Author metadata will be added into new suggestions and comments"
		type="toggle"
		depth={1}
	>
		{#snippet control()}
			<Toggle
				value={plugin.settings.add_author_metadata}
				onChange={(value) => {
					plugin.settings.add_author_metadata = value;
					plugin.saveSettings();
				}}
			/>
		{/snippet}
	</SettingItem>

	<SettingItem
		name="Name"
		depth={1}
		notices={[
			{
				type: "warning" as const,
				text: author_at_warning(plugin.settings.author) ?? "",
			},
		].filter((notice) => notice.text)}
	>
		{#snippet control()}
			<Input
				type="text"
				bind:value={plugin.settings.author}
				onChange={(value) => {
					plugin.settings.author = value;
					plugin.saveSettings();
				}}
			/>
		{/snippet}
	</SettingItem>
{/if}

<SettingItem
	name="Enable Timestamp"
	description="Enable rendering and processing of timestamp metadata"
	type="toggle"
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.enable_timestamp_metadata}
			onChange={(value) => {
				plugin.settings.enable_timestamp_metadata = value;
				plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

{#if plugin.settings.enable_timestamp_metadata}
	<SettingItem
		name="Add Timestamp Metadata"
		description="Timestamp metadata will be added into new suggestions and comments"
		depth={1}
	>
		{#snippet control()}
			<Toggle
				value={plugin.settings.add_timestamp_metadata}
				onChange={(value) => {
					plugin.settings.add_timestamp_metadata = value;
					plugin.saveSettings();
				}}
			/>
		{/snippet}
	</SettingItem>
{/if}

<SettingItem
	name="Enable Completed"
	description="Enable rendering and processing of completed metadata"
	type="toggle"
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.enable_completed_metadata}
			onChange={(value) => {
				plugin.settings.enable_completed_metadata = value;
				plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

{#if plugin.settings.enable_completed_metadata}
	<SettingItem
		name="Add Completed Metadata"
		description="Completed metadata will be added into new suggestions and comments"
		depth={1}
	>
		{#snippet control()}
			<Toggle
				value={plugin.settings.add_completed_metadata}
				onChange={(value) => {
					plugin.settings.add_completed_metadata = value;
					plugin.saveSettings();
				}}
			/>
		{/snippet}
	</SettingItem>
{/if}

<SettingItem
	name="Enable Style"
	description="Enable rendering and processing of style metadata"
	type="toggle"
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.enable_style_metadata}
			onChange={(value) => {
				plugin.settings.enable_style_metadata = value;
				plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

{#if plugin.settings.enable_style_metadata}
	<SettingItem
		name="Add Style Metadata"
		description="Style metadata will be added into new suggestions and comments"
		depth={1}
	>
		{#snippet control()}
			<Toggle
				value={plugin.settings.add_style_metadata}
				onChange={(value) => {
					plugin.settings.add_style_metadata = value;
					plugin.saveSettings();
				}}
			/>
		{/snippet}
	</SettingItem>
{/if}

<SettingItem
	name="Enable Color"
	description="Enable rendering and processing of color metadata"
	type="toggle"
>
	{#snippet control()}
		<Toggle
			value={plugin.settings.enable_color_metadata}
			onChange={(value) => {
				plugin.settings.enable_color_metadata = value;
				plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>

{#if plugin.settings.enable_color_metadata}
	<SettingItem
		name="Add Color Metadata"
		description="Color metadata will be added into new suggestions and comments"
		depth={1}
	>
		{#snippet control()}
			<Toggle
				value={plugin.settings.add_color_metadata}
				onChange={(value) => {
					plugin.settings.add_color_metadata = value;
					plugin.saveSettings();
				}}
			/>
		{/snippet}
	</SettingItem>
{/if}
