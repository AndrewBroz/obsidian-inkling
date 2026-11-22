<script lang="ts">
	import {
	type CriticMarkupRangeEntry,
	SUGGESTION_ICON_MAPPER,
	SuggestionType,
	thread_resolvable,
	thread_resolved,
} from "../../../editor/base";
import type CommentatorPlugin from "../../../main";
import { Icon, MarkdownRenderer, mountElement } from "../../components";
import { createMetadataInfoElement } from "../../snippets";
import AnnotationThreadQuickActions from "./AnnotationThreadQuickActions.svelte";
import { onContextMenu } from "./context-menu";

interface Props {
	plugin: CommentatorPlugin;
	selected_ranges: CriticMarkupRangeEntry[];
	row: CriticMarkupRangeEntry;
	index: number;
	onClick: (evt: MouseEvent, row: CriticMarkupRangeEntry, index: number) => void;
	onDblClick: (evt: MouseEvent, row: CriticMarkupRangeEntry, index: number) => void;
	menu_open: boolean;
}

let {
	plugin,
	selected_ranges,
	row,
	index,
	onClick,
	onDblClick,
	menu_open = $bindable(false),
}: Props = $props();

let hovered_idx = $state<number | null>(null);
let menu_open_at_idx = $state<number | null>(null);

function setHoveredIndex(idx: number | null) {
	if (!menu_open) {
		hovered_idx = idx;
		menu_open_at_idx = hovered_idx;
	}
}

let is_selected = $derived(
	selected_ranges.some((range) =>
		range.path === row.path && range.range.from === row.range.from
	),
);

// EXPL: An anchored highlight (HIGHLIGHT with replies) is the quote the thread is attached to,
// not a comment itself — render it as a muted quote instead of a full comment card. Standalone
// highlights (no replies) keep today's rendering.
const is_anchor_quote = $derived(
	row.range.type === SuggestionType.HIGHLIGHT && row.range.replies.length > 0,
);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	tabindex={index}
	class="cmtr-view-range"
	class:cmtr-view-range-completed={thread_resolvable(row.range) && thread_resolved(row.range)}
	class:cmtr-view-range-selected={is_selected}
	onmouseenter={() => {
		setHoveredIndex(0);
	}}
	onmouseleave={() => {
		setHoveredIndex(null);
	}}
	onclick={(e) => {
		onClick(e, row, index);
	}}
	ondblclick={(e) => {
		onDblClick(e, row, index);
	}}
	oncontextmenu={(e) => {
		onContextMenu(
			plugin,
			e,
			selected_ranges.length ?
				selected_ranges :
				[{ path: row.path, range: (hovered_idx === null ? undefined : row.range.thread[hovered_idx]) ?? row.range }],
		);
	}}
>
	{#if (!menu_open && hovered_idx === 0) || (menu_open && menu_open_at_idx === 0)}
		<AnnotationThreadQuickActions
			plugin={plugin}
			entry={row}
			is_base={true}
			bind:menu_open={menu_open}
			moreOptionsMenu={onContextMenu}
		/>
	{/if}

	<!-- TODO: Only show path if folder/vault-wide filter is active -->
	<div class="cmtr-view-range-top">
		<Icon size={24} icon={SUGGESTION_ICON_MAPPER[row.range.type]} />
		<div>
			<span class="cmtr-view-range-title">{row.path}</span>
			{#if !is_anchor_quote}
				<span class="svelcomlib-contents" use:mountElement={createMetadataInfoElement(row.range, "", "icon")}></span>
			{/if}
		</div>
	</div>

	{#key row.range.text}
		<div
			class="cmtr-view-range-text"
			class:cmtr-view-range-anchor-quote={is_anchor_quote}
			onmouseenter={() => {
				setHoveredIndex(0);
			}}
		>
			{#if row.range.empty()}
				<p class="cmtr-view-range-empty">
					This range is empty
				</p>
			{:else}
				{@const parts = row.range.unwrap_parts()}
				<MarkdownRenderer
					{plugin}
					text={parts[0]}
					source={row.path}
					class={row.range.fields.style}
				/>
				{#if row.range.type === SuggestionType.SUBSTITUTION}
					<MarkdownRenderer {plugin} text={parts[1]} source={row.path} />
				{/if}
			{/if}
		</div>
	{/key}

	{#if row.range.replies.length}
		{#each row.range.replies as reply, idx (reply.from)}
			{#key reply.text}
				<div
					class="cmtr-view-range-reply"
					onmouseenter={() => {
						setHoveredIndex(idx + 1);
					}}
					class:cmtr-view-range-reply-hovered={hovered_idx === idx + 1}
				>
					{#if (!menu_open && hovered_idx === idx + 1) ||
	(menu_open && menu_open_at_idx === idx + 1)}
						<AnnotationThreadQuickActions
							plugin={plugin}
							entry={{ path: row.path, range: reply }}
							bind:menu_open={menu_open}
							moreOptionsMenu={onContextMenu}
						/>
					{/if}

					<span class="svelcomlib-contents" use:mountElement={createMetadataInfoElement(reply, "cmtr-view-range-reply-top")}></span>

					<div class="cmtr-view-range-reply-text">
						<MarkdownRenderer
							{plugin}
							text={reply.unwrap()}
							source={row.path}
							class={reply.fields.style}
						/>
					</div>
				</div>
			{/key}
		{/each}
	{/if}
</div>
