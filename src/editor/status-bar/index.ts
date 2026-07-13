import type CommentatorPlugin from "../../main";
import { EditMode, PreviewMode } from "../../types";
import { editModeValueState, previewModeState } from "../settings";
import { MetadataStatusBarButton } from "./metadata-status-bar-button";
import { StatusBarButton } from "./status-bar-button";

export const previewModeStatusBarButton = (plugin: CommentatorPlugin, render: boolean) =>
	new StatusBarButton(
		[
			{ value: PreviewMode.ALL, icon: "message-square", text: "Showing all suggestions" },
			{ value: PreviewMode.ACCEPT, icon: "check", text: "Previewing \"accept all\"" },
			{ value: PreviewMode.REJECT, icon: "cross", text: "Previewing \"reject all\"" },
		],
		plugin.setPreviewMode.bind(plugin),
		(editor) => {
			return editor.cm.state.facet(previewModeState);
		},
		plugin,
		render,
	);

export const suggestionModeStatusBarButton = (plugin: CommentatorPlugin, render: boolean) =>
	new StatusBarButton(
		[
			{ value: EditMode.CORRECTED, icon: "edit", text: "Editing" },
			{ value: EditMode.SUGGEST, icon: "file-edit", text: "Suggesting" },
			{ value: EditMode.COMMENT, icon: "message-square", text: "Commenting" },
		],
		plugin.setEditMode.bind(plugin),
		(editor) => {
			return editor.cm.state.facet(editModeValueState);
		},
		plugin,
		render,
	);

export const metadataStatusBarButton = (plugin: CommentatorPlugin, render: boolean) =>
	new MetadataStatusBarButton(plugin, render);

export { MetadataStatusBarButton, StatusBarButton };
