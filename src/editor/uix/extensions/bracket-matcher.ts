import { type ChangeSpec, EditorSelection, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { CM_Brackets } from "../../base";

export const bracketMatcher = Prec.high(EditorView.inputHandler.of((view, from, to, text) => {
	const before = view.state.doc.sliceString(from - 2, from) + text;

	let bracket;
	if ((bracket = CM_Brackets[before]) !== undefined) {
		const changes: ChangeSpec[] = [{
			from,
			to: to + 1,
			insert: text + bracket.join(""),
		}];

		// EXPL: It replaces the user's keystroke, so it is typing: without the user event, automatic cleanup would
		//       read it as an external change (cleanup-trigger.ts).
		view.dispatch({
			changes,
			selection: EditorSelection.cursor(to + 1),
			userEvent: "input.type",
		});
		return true;
	}
	return false;
}));
