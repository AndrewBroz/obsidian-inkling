import { type ChangeSpec, EditorSelection, EditorState } from "@codemirror/state";

import { rangeParser, SubstitutionRange, SuggestionType } from "../../base";

/**
 * Removes initial whitespaces and double newlines from ranges that would otherwise result in markup being applied
 * to text that is not part of the range (due to CM shenanigans)
 */
export const rangeCorrecter = EditorState.transactionFilter.of(tr => {
	if (tr.isUserEvent("select")) {
		const previous_selection = tr.startState.selection.main, current_selection = tr.selection!.main;

		if (current_selection.anchor === current_selection.head) {
			const ranges = tr.startState.field(rangeParser).ranges;

			const start_range = ranges.at_cursor(previous_selection.head);
			const end_range = ranges.at_cursor(current_selection.head);

			// Execute only if the cursor is moved outside a particular range
			if (
				start_range && start_range !== end_range &&
				(start_range.type === SuggestionType.SUBSTITUTION || start_range.type === SuggestionType.HIGHLIGHT)
			) {
				const is_substitution = start_range.type === SuggestionType.SUBSTITUTION;
				const parts = is_substitution ?
					(start_range as SubstitutionRange).unwrap_parts() :
					[start_range.unwrap()];
				let changed = false;
				let removed_characters = 0;

				const left_whitespace_end = parts[0].search(/\S/);
				if (left_whitespace_end >= 1) {
					changed = true;
					parts[0] = parts[0].slice(left_whitespace_end);
					removed_characters += left_whitespace_end;
				}

				for (let i = 0; i < parts.length; i++) {
					const invalid_endlines = parts[i].match(/\n\s*\n/g);
					if (invalid_endlines) {
						changed = true;
						parts[i] = parts[i].replace(/\n\s*\n/g, "\n");
						// EXPL: Each match is replaced by a single "\n", so one character per match survives
						removed_characters += invalid_endlines.reduce((acc, cur) => acc + cur.length - 1, 0);
					}
				}

				if (changed) {
					const changes: ChangeSpec[] = [{
						// EXPL: unwrap()/unwrap_parts() strip the metadata block, so the replacement must
						//       start at range_start (after the metadata) — from + 3 would delete it
						from: start_range.range_start,
						to: start_range.to - 3,
						// EXPL: unwrap_parts() also strips the "~>" separator; rejoin so it survives
						insert: parts.join("~>"),
					}];
					// EXPL: Only shift the cursor when it exited past the removed characters
					const head = current_selection.head <= start_range.range_start ?
						current_selection.head :
						current_selection.head - removed_characters;
					return {
						changes,
						selection: EditorSelection.cursor(head),
					};
				}
			}
		}
	}

	return tr;
});
