import { EditorSelection } from "@codemirror/state";
import { MarkdownView, Menu, TFile } from "obsidian";
import type CommentatorPlugin from "../../../main";

import {
	addCommentToView,
	applyToFile,
	CommentRange,
	type CriticMarkupRangeEntry,
	groupRangeEntryByPath,
	range_source_with_fields,
	SuggestionType,
	thread_resolvable,
	thread_resolved,
} from "../../../editor/base";
import { annotationGutterFocusAnnotation } from "../../../editor/renderers/gutters";
import { applyRangeEditsToVault, centerRangeInEditorView } from "../../../editor/uix";

export function onContextMenu(
	plugin: CommentatorPlugin,
	e: MouseEvent,
	ranges: CriticMarkupRangeEntry[],
) {
	const menu = new Menu();

	const used_types = new Set(ranges.map((range) => range.range.type));
	const use_warning = ranges.length > 20;
	const multiple_ranges = ranges.length > 1;

	// EXPL: Resolve/reopen always act on whole threads (base_range.full_thread), regardless of
	// whether the base or one of its replies was the range actually right-clicked/selected —
	// same semantics as the gutter's resolve_thread/reopen_thread. Dedupe by base range identity
	// so a thread selected via multiple of its own replies isn't rewritten more than once (which
	// would corrupt applyToText's sequential span replacement).
	const base_entries = [...new Map(
		ranges.map((entry) => [entry.range.base_range, { path: entry.path, range: entry.range.base_range }]),
	).values()];

	// EXPL: Only suggestions are used
	if (!(used_types.has(SuggestionType.COMMENT) || used_types.has(SuggestionType.HIGHLIGHT))) {
		menu.addItem((item) => {
			item
				.setTitle(multiple_ranges ? "Apply selected changes" : "Apply change")
				.setIcon("check")
				.setSection("close-annotation")
				.setWarning(use_warning)
				.onClick(async () =>
					applyRangeEditsToVault(plugin, ranges, applyToFile.bind(null, (range, _) => range.accept()))
				);
		});
		menu.addItem((item) => {
			item
				.setTitle(multiple_ranges ? "Reject selected changes" : "Reject change")
				.setIcon("cross")
				.setSection("close-annotation")
				.setWarning(use_warning)
				.onClick(async () =>
					applyRangeEditsToVault(plugin, ranges, applyToFile.bind(null, (range, _) => range.reject()))
				);
		});
	} else if (used_types.size === 1 && used_types.has(SuggestionType.COMMENT)) {
		menu.addItem((item) => {
			item
				.setTitle(multiple_ranges ? "Remove selected comment threads" : "Remove comment thread")
				.setIcon("message-square-off")
				.setSection("close-annotation")
				.setWarning(use_warning)
				.onClick(async () => applyRangeEditsToVault(plugin, ranges, applyToFile.bind(null, (range, _) => "")));
		});
	} else {
		menu.addItem((item) => {
			item
				.setTitle(multiple_ranges ? "Remove selected threads" : "Remove thread")
				.setIcon("trash")
				.setSection("close-annotation")
				.setWarning(use_warning)
				.onClick(async () => applyRangeEditsToVault(plugin, ranges, applyToFile.bind(null, (range, _) => "")));
		});
	}

	// EXPL: Resolve/reopen is a comment-thread concept (HIGHLIGHT/COMMENT base only, see
	// `thread_resolvable`) — suggestion threads are closed via accept/reject, so done-flagged
	// suggestions (legacy "Set completed" data) are excluded from both the offer and the edit.
	const resolvable_entries = base_entries.filter((entry) => thread_resolvable(entry.range));
	if (resolvable_entries.length) {
		menu.addItem((item) => {
			// EXPL: A thread is resolved iff its base carries `done: true` (see `thread_resolved`).
			// When multiple threads are selected with a mixed resolved state, resolve wins — the
			// action always moves every selected thread toward "resolved".
			const any_unresolved = resolvable_entries.some((entry) => !thread_resolved(entry.range));
			if (any_unresolved) {
				item
					.setTitle(multiple_ranges ? "Resolve selected threads" : "Resolve thread")
					.setIcon("check")
					.setSection("close-annotation")
					.onClick(async () =>
						applyRangeEditsToVault(
							plugin,
							resolvable_entries,
							applyToFile.bind(
								null,
								(range, _) => range_source_with_fields(range, { ...range.fields, done: true }),
							),
						)
					);
			} else {
				item
					.setTitle(multiple_ranges ? "Reopen selected threads" : "Reopen thread")
					.setIcon("rotate-ccw")
					.setSection("close-annotation")
					.onClick(async () =>
						applyRangeEditsToVault(
							plugin,
							resolvable_entries,
							applyToFile.bind(null, (range, _) => {
								const fields = { ...range.fields };
								delete fields.done;
								return range_source_with_fields(range, fields);
							}),
						)
					);
			}
		});
	}

	if (!multiple_ranges) {
		const { range, path } = ranges[0];

		menu.addItem((item) => {
			item
				.setTitle("Add reply")
				.setIcon("reply")
				.setSection("comment-handling")
				.onClick(async (evt) => {
					// TODO: This is temporary, ideally, this should be handled inside the view
					const file = plugin.app.vault.getAbstractFileByPath(path);
					if (file && file instanceof TFile) {
						const leaf = plugin.app.workspace.getLeaf(false);
						await leaf.openLinkText(path, "");
						if (leaf.view instanceof MarkdownView) {
							centerRangeInEditorView(leaf.view.editor, range);
							addCommentToView(leaf.view.editor.cm, range, false);
						}
					}
				});
		});

		if (range.type === SuggestionType.COMMENT) {
			menu.addItem((item) => {
				item.setTitle("Edit comment")
					.setIcon("pencil")
					.setSection("comment-handling")
					.onClick(async () => {
						// TODO: This is temporary, ideally, this should be handled inside the view
						const file = plugin.app.vault.getAbstractFileByPath(path);
						if (file && file instanceof TFile) {
							const leaf = plugin.app.workspace.getLeaf(false);
							await leaf.openLinkText(path, "");
							if (leaf.view instanceof MarkdownView) {
								const { editor } = leaf.view;
								centerRangeInEditorView(editor, range);
								editor.cm.dispatch(editor.cm.state.update({
									selection: EditorSelection.cursor(range.full_range_back),
									annotations: [
										annotationGutterFocusAnnotation.of({
											from: range.full_range_back,
											to: range.full_range_back,
											index: (range as CommentRange).reply_depth,
										}),
									],
								}));
							}
						}
					});
			});

			menu.addItem((item) => {
				item.setTitle("Remove comment")
					.setIcon("cross")
					.setSection("comment-handling")
					.onClick(async () => applyRangeEditsToVault(plugin, ranges, applyToFile.bind(null, (range, _) => ""), false));
			});
		}
	}

	menu.addItem((item) => {
		item
			.setTitle(multiple_ranges ? "Open in new tabs" : "Open in new tab")
			.setIcon("file-plus")
			.setSection("open-annotation")
			.onClick(async (evt) => {
				const grouped_ranges = groupRangeEntryByPath(ranges);

				for (const [path, ranges] of Object.entries(grouped_ranges).slice(0, 10)) {
					const file = plugin.app.vault.getAbstractFileByPath(path);
					if (file && file instanceof TFile) {
						const leaf = plugin.app.workspace.getLeaf(evt.metaKey || evt.ctrlKey || true);
						await leaf.openLinkText(path, "");
						if (leaf.view instanceof MarkdownView)
							centerRangeInEditorView(leaf.view.editor, ranges[0]);
					}
				}
			});
	});

	menu.showAtMouseEvent(e);

	return menu;
}
