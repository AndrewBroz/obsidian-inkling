import type CommentatorPlugin from "../../main";
import { EditMode, PreviewMode } from "../../types";
import { editModeValueState, previewModeState } from "../settings";
import { HeaderButton } from "./header-button";

export const previewModeHeaderButton = (plugin: CommentatorPlugin, render: boolean) =>
	new HeaderButton(
		[
			{
				value: PreviewMode.ALL,
				icon: "message-square",
				tooltip: "Current mode: show all suggestions\nClick to preview 'accept all'",
				text: "Showing all suggestions",
			},
			{
				value: PreviewMode.ACCEPT,
				icon: "check",
				tooltip: "Current mode: preview 'accept all'\nClick to preview 'reject all'",
				text: "Previewing \"accept all\"",
			},
			{
				value: PreviewMode.REJECT,
				icon: "cross",
				tooltip: "Current mode: preview 'reject all'\nClick to preview 'show all'",
				text: "Previewing \"reject all\"",
			},
		],
		plugin.settings.toolbar_show_buttons_labels,
		"cmtr-suggestion-status",
		plugin.setPreviewMode.bind(plugin),
		(view) => view.editor.cm.state.facet(previewModeState),
		plugin,
		render,
	);

export const editModeHeaderButton = (plugin: CommentatorPlugin, render: boolean) =>
	new HeaderButton(
		[
			{
				value: EditMode.CORRECTED,
				icon: "edit",
				tooltip: "Current mode: editing\nClick to suggest",
				text: "Editing",
			},
			{
				value: EditMode.SUGGEST,
				icon: "file-edit",
				tooltip: "Current mode: suggesting\nClick to comment",
				text: "Suggesting",
			},
			{
				value: EditMode.COMMENT,
				icon: "message-square",
				tooltip: "Current mode: commenting\nClick to edit",
				text: "Commenting",
			},
		],
		plugin.settings.toolbar_show_buttons_labels,
		"cmtr-suggestion-status",
		plugin.setEditMode.bind(plugin),
		(view) => view.editor.cm.state.facet(editModeValueState),
		plugin,
		render,
	);

export { HeaderButton };
