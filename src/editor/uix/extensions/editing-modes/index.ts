import { commentMode } from "./comment-mode";
import { editMode } from "./edit-mode";
import { suggestionMode } from "./suggestion-mode";

import { type Extension } from "@codemirror/state";
import { EditMode, type PluginSettings } from "../../../../types";

// EXPL: Fail CLOSED, not open. An unrecognized `edit_mode` (a hand-edited data.json, a schema
//       from another plugin version, or a future retirement like EditMode.OFF's) must never fall
//       through to zero extensions — that would recreate the exact hazard the OFF-mode removal
//       exists to eliminate: an editor with no protection against corrupting CriticMarkup syntax.
//       The fallthrough therefore installs the protected `editMode` (CORRECTED) extension set,
//       same as the explicit CORRECTED branch, instead of returning no extensions at all.
export function getEditMode(edit_mode: EditMode, settings: PluginSettings): Extension[] {
	if (edit_mode === EditMode.CORRECTED)
		return [editMode(settings)];
	else if (edit_mode === EditMode.SUGGEST)
		return [suggestionMode(settings)];
	else if (edit_mode === EditMode.COMMENT)
		return [commentMode(settings)];
	return [editMode(settings)];
}

export * from "./comment-mode";
export * from "./cursor_movement";
export * from "./edit-mode";
export * from "./suggestion-mode";
export * from "./tracked-edit";
