import { type ChangeSpec, EditorSelection, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { CM_Brackets, rangeParser } from "../../base";
import { inCode } from "../../base/edit-util/code-regions";

// EXPL: Completes an opener typed at the cursor (`{++` gets `++}`), replacing the `}` an auto-paired `{` left after
//       it. It stays out of the way when:
//       - text is selected: the keystroke replaces or wraps the selection (Obsidian wraps it in `~`, `=`), and
//         completing there deleted the selection and the character after it;
//       - the cursor is in a code block (content or fence line): markup there is plain code text;
//       - the next character is not `}`: there is no auto-paired brace to replace, and it was deleted.
export const bracketMatcher = Prec.high(EditorView.inputHandler.of((view, from, to, text) => {
	if (from !== to || inCode(view.state.field(rangeParser, false)?.code_regions ?? [], from))
		return false;
	const before = view.state.doc.sliceString(from - 2, from) + text;

	let bracket;
	if ((bracket = CM_Brackets[before]) !== undefined) {
		const paired = view.state.doc.sliceString(to, to + 1) === "}";
		const changes: ChangeSpec[] = [{
			from,
			to: paired ? to + 1 : to,
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
