<script lang="ts">
	import { Menu } from "obsidian";
import {
	applyToFile,
	type CriticMarkupRangeEntry,
	reopen_source,
	resolve_source,
	SuggestionType,
	thread_resolvable,
	thread_resolved,
} from "../../../editor/base";
import {
	applyRangeEditsToVault,
	openNoteAtRangeEntry,
} from "../../../editor/uix";
import CommentatorPlugin from "../../../main";
import { Button } from "../../components";

interface Props {
	plugin: CommentatorPlugin;

	entry: CriticMarkupRangeEntry;

	// EXPL: Resolve/reopen apply to the whole thread and are only shown on the base entry, not
	// on individual replies.
	is_base?: boolean;

	menu_open?: boolean;
	moreOptionsMenu: (
		plugin: any,
		evt: MouseEvent,
		entries: CriticMarkupRangeEntry[],
	) => Menu;
}

let {
	plugin,

	entry,

	is_base = false,

	menu_open = $bindable(false),
	moreOptionsMenu,
}: Props = $props();
</script>

<div style="position: relative;">
	<div class="cmtr-view-suggestion-buttons">
		{#if entry.range.type === SuggestionType.COMMENT}
			{#if entry.range.replies.length}
				<Button
					icon="message-square-off"
					tooltip={"Delete comment thread"}
					onClick={(() =>
					applyRangeEditsToVault(
						plugin,
						[entry],
						applyToFile.bind(null, (range, _) => range.accept()),
					))}
				/>
			{:else}
				<Button
					icon="cross"
					tooltip={"Delete comment"}
					onClick={(() =>
					applyRangeEditsToVault(
						plugin,
						[entry],
						applyToFile.bind(null, (range, _) => range.accept()),
					))}
				/>
			{/if}
		{:else if entry.range.type !== SuggestionType.HIGHLIGHT}
			<Button
				icon="check"
				tooltip={"Accept change" + (entry.range.replies.length ? " (and delete thread)" : "")}
				onClick={(() =>
				applyRangeEditsToVault(
					plugin,
					[entry],
					applyToFile.bind(null, (range, _) => range.accept()),
				))}
			/>
			<Button
				icon="cross"
				tooltip={"Reject change" + (entry.range.replies.length ? " (and delete thread)" : "")}
				onClick={(() =>
				applyRangeEditsToVault(
					plugin,
					[entry],
					applyToFile.bind(null, (range, _) => range.reject()),
				))}
			/>
		{/if}

		<!-- EXPL: Resolve/reopen is a comment-thread concept (HIGHLIGHT/COMMENT base only, see
		     thread_resolvable) — suggestion threads are closed via accept/reject instead. -->
		{#if is_base && thread_resolvable(entry.range)}
			{#if thread_resolved(entry.range)}
				<Button
					icon="rotate-ccw"
					tooltip="Reopen thread"
					onClick={(() =>
					applyRangeEditsToVault(
						plugin,
						[entry],
						applyToFile.bind(null, (range, text) => reopen_source(range, text, plugin.settings.metadata_syntax)),
						true,
					))}
				/>
			{:else}
				<Button
					icon="check"
					tooltip={plugin.settings.remove_on_resolve ? "Resolve and remove thread" : "Resolve thread"}
					onClick={(() =>
					applyRangeEditsToVault(
						plugin,
						[entry],
						applyToFile.bind(null, (range, text) => resolve_source(range, text, plugin.settings)),
						true,
					))}
				/>
			{/if}
		{/if}

		<div class="cmtr-view-suggestion-button-sep"></div>

		<Button
			icon="eye"
			tooltip="View in note"
			onClick={async () => {
				await openNoteAtRangeEntry(plugin, entry);
			}}
		/>

		<Button
			icon="more-vertical"
			tooltip="More options"
			onClick={(evt) => {
				menu_open = true;
				const menu = moreOptionsMenu(plugin, evt, [entry]);
				menu.onHide(() => {
					menu_open = false;
				});
			}}
		/>
	</div>
</div>
