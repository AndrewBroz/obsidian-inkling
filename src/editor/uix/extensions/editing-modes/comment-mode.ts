import { Annotation, EditorState, type Extension } from "@codemirror/state";
import { Notice } from "obsidian";

import { type PluginSettings } from "../../../../types";
import { rangeParser, SuggestionType } from "../../../base";
import { is_exempt_from_tracking } from "./tracked-edit";

/** Marks a transaction as a Commentator comment operation, exempt from comment-mode blocking. */
export const commentModeAnnotation = Annotation.define<boolean>();

// EXPL: One Notice per burst of blocked keystrokes, not one per keypress
let last_block_notice = 0;

export const commentMode = (settings: PluginSettings): Extension =>
	EditorState.transactionFilter.of(tr => {
		if (!tr.docChanged)
			return tr;
		if (tr.annotation(commentModeAnnotation))
			return tr;
		// EXPL: Only gate direct user edits; programmatic transactions (accept/reject from the
		//       gutter, comment-widget submissions, undo of allowed edits) pass through
		if (is_exempt_from_tracking(tr)) {
			return tr;
		}

		const ranges = tr.startState.field(rangeParser).ranges;
		let allowed = true;
		tr.changes.iterChangedRanges((fromA, toA) => {
			const range = ranges.at_cursor(fromA);
			// EXPL: The whole changed region must sit inside ONE comment range's content span
			if (
				!(range && range.type === SuggestionType.COMMENT &&
					range.range_start <= fromA && toA <= range.to - 3)
			) {
				allowed = false;
			}
		});
		if (allowed)
			return tr;

		if (Date.now() - last_block_notice > 2000) {
			last_block_notice = Date.now();
			new Notice(
				"Inkling: comment mode — text edits are disabled; add or edit comments instead.",
				3000,
			);
		}
		return [];
	});
