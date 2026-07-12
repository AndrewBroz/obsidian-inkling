import { commentMode } from "./comment-mode";
import { editMode } from "./edit-mode";
import { suggestionMode } from "./suggestion-mode";

import { type Extension } from "@codemirror/state";
import { EditMode, type PluginSettings } from "../../../../types";

export function getEditMode(edit_mode: EditMode, settings: PluginSettings): Extension[] {
	if (edit_mode === EditMode.OFF)
		return [];
	else if (edit_mode === EditMode.CORRECTED)
		return [editMode(settings)];
	else if (edit_mode === EditMode.SUGGEST)
		return [suggestionMode(settings)];
	else if (edit_mode === EditMode.COMMENT)
		return [commentMode(settings)];
	return [];
}

export * from "./comment-mode";
export * from "./cursor_movement";
export * from "./edit-mode";
export * from "./suggestion-mode";
