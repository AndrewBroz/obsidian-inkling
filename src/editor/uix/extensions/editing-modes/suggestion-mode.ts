import { EditorSelection, EditorState, type Extension, SelectionRange, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorEditorField } from "obsidian";
import type { VimEditor } from "obsidian-typings";
import { type PluginSettings } from "../../../../types";

import {
	CriticMarkupRanges,
	cursor_move_range,
	cursorMoved,
	deriveUserEvent,
	type EditorChange,
	type EditorEditChange,
	generate_metadata,
	getEditorRanges,
	getUserEvents,
	isUserEvent,
	mark_ranges,
	MarkAction,
	type MarkType,
	range_metadata_compatible,
	rangeParser,
	SubstitutionRange,
	SuggestionType,
} from "../../../base";

import { latest_event } from "../keypress-catcher";
import { cursor_transaction_pass_syntax } from "./cursor_movement";
import { editDelta, type GuardedEdit, guardSuggestions } from "./fence-guard";
import { is_exempt_from_tracking, pluginEditAnnotation } from "./tracked-edit";

const vim_action_resolver = {
	"moveByCharacters": {
		"group": false,
	},
};

// TODO: Actions to verify:
// 	{ keys: 'h', motion: 'moveByCharacters',
// 	{ keys: 'l', motion: 'moveByCharacters',
// 	{ keys: 'j', motion: 'moveByLines',
// 	{ keys: 'k', motion: 'moveByLines',
// 	{ keys: 'H', motion: 'moveToTopLine',
// 	{ keys: 'M', motion: 'moveToMiddleLine',
// 	{ keys: 'L', motion: 'moveToBottomLine',
// 	{ keys: 'gj', motion: 'moveByDisplayLines',
// 	{ keys: 'gk', motion: 'moveByDisplayLines',
// 	{ keys: 'w', motion: 'moveByWords',
// 	{ keys: 'W', motion: 'moveByWords',
// 	{ keys: 'e', motion: 'moveByWords',
// 	{ keys: 'E', motion: 'moveByWords',
// 	{ keys: 'b', motion: 'moveByWords',
// 	{ keys: 'B', motion: 'moveByWords',
// 	{ keys: 'ge', motion: 'moveByWords',
// 	{ keys: 'gE', motion: 'moveByWords',
// 	{ keys: '{', motion: 'moveByParagraph',
// 	{ keys: '}', motion: 'moveByParagraph',
// 	{ keys: '(', motion: 'moveBySentence',
// 	{ keys: ')', motion: 'moveBySentence',
// 	{ keys: '<C-f>', motion: 'moveByPage',
// 	{ keys: '<C-b>', motion: 'moveByPage',
// 	{ keys: '<C-d>', motion: 'moveByScroll',
// 	{ keys: '<C-u>', motion: 'moveByScroll',
// 	{ keys: 'gg', motion: 'moveToLineOrEdgeOfDocument',
// 	{ keys: 'G', motion: 'moveToLineOrEdgeOfDocument',
// 	{ keys: "g$", type: "motion", motion: "moveToEndOfDisplayLine"},
// 	{ keys: "g^", type: "motion", motion: "moveToStartOfDisplayLine"},
// 	{ keys: "g0", type: "motion", motion: "moveToStartOfDisplayLine"},
// 	{ keys: '0', motion: 'moveToStartOfLine' },
// 	{ keys: '^', motion: 'moveToFirstNonWhiteSpaceCharacter' },
// 	{ keys: '+', motion: 'moveByLines',
// 	{ keys: '-', motion: 'moveByLines',
// 	{ keys: '_', motion: 'moveByLines',
// 	{ keys: '$', motion: 'moveToEol',
// 	{ keys: '%', motion: 'moveToMatchedSymbol',
// 	{ keys: 'f<character>', motion: 'moveToCharacter',
// 	{ keys: 'F<character>', motion: 'moveToCharacter',
// 	{ keys: 't<character>', motion: 'moveTillCharacter',
// 	{ keys: 'T<character>', motion: 'moveTillCharacter',
// 	{ keys: ';', motion: 'repeatLastCharacterSearch',
// 	{ keys: ',', motion: 'repeatLastCharacterSearch',
// 	{ keys: '\'<character>', motion: 'goToMark',
// 	{ keys: '`<character>', motion: 'goToMark',
// 	{ keys: ']`', motion: 'jumpToMark',
// 	{ keys: '[`', motion: 'jumpToMark',
// 	{ keys: ']\'', motion: 'jumpToMark',
// 	{ keys: '[\'', motion: 'jumpToMark',
// 	{ keys: ']<character>', motion: 'moveToSymbol',
// 	{ keys: '[<character>', motion: 'moveToSymbol',
// 	{ keys: '|', motion: 'moveToColumn'},
// 	{ keys: 'o', motion: 'moveToOtherHighlightedEnd', context:'visual'},
// 	{ keys: 'O', motion: 'moveToOtherHighlightedEnd',
// 	'moveToLineOrEdgeOfDocument':

export const suggestionMode = (settings: PluginSettings): Extension =>
	EditorState.transactionFilter.of(tr => applySuggestion(tr, settings));

// TODO: Functionality: Double click mouse should also floodfill (problem: no specific userevent attached)
function applySuggestion(tr: Transaction, settings: PluginSettings): Transaction {
	const editor = tr.startState.field(editorEditorField) as EditorView & { cm: VimEditor };
	const userEvents = getUserEvents(tr);
	const vim_mode = editor.cm !== undefined;

	// TODO: Resolve used vim cursor movements since they do not receive user event annotations
	if (vim_mode && !tr.docChanged && tr.selection) {
		if (cursorMoved(tr)) {
			userEvents.push(
				tr.startState.selection.ranges[0].from < tr.selection!.ranges[0].from ?
					"select.forward" :
					"select.backward",
			);
		}
		if (vim_action_resolver[editor.cm.state.vim.lastMotion?.name as keyof typeof vim_action_resolver]?.group)
			userEvents.push("select.group");
	}

	// CASE 1: Handle edit operations
	if (tr.docChanged) {
		const changed_ranges = getEditorRanges(tr.startState.selection, tr.changes, tr.startState.doc);

		if (is_exempt_from_tracking(tr))
			return tr;

		const ranges = tr.startState.field(rangeParser).ranges;
		const metadata = generate_metadata(settings);
		const backwards_delete = (latest_event as KeyboardEvent)?.key === "Backspace";
		const group_delete = (latest_event as KeyboardEvent)?.ctrlKey;

		/** The change as a tracked suggestion, with the cursor where it would be after only this change. */
		function track(editor_change: EditorEditChange): GuardedEdit | undefined {
			let type: MarkType = editor_change.deleted ?
				(editor_change.inserted ? SuggestionType.SUBSTITUTION : SuggestionType.DELETION) :
				SuggestionType.ADDITION;
			if (type === SuggestionType.DELETION) {
				editor_change = cursor_move_range(
					editor_change,
					ranges,
					backwards_delete,
					group_delete,
					tr.startState,
					settings.suggestion_mode_operations.cursor_movement,
					settings.suggestion_mode_operations.bracket_movement,
				);

				// EXPL: Only ranges the deletion overlaps: one that merely touches it (a deletion ending where an addition
				//       starts) is beside it, and counting it made deleting the start of that addition do nothing.
				const ranges_in_range = ranges.ranges_in_interval(editor_change.from, editor_change.to)
					.filter(range => range.from < editor_change.to && editor_change.from < range.to);
				if (ranges_in_range.length === 1) {
					const range = ranges_in_range[0];
					if (
						range.encloses_range(editor_change.from, editor_change.to) &&
						range_metadata_compatible(range, metadata).compatible &&
						(range.type === SuggestionType.ADDITION ||
							(range.type === SuggestionType.SUBSTITUTION &&
								(range as SubstitutionRange).contains_part(
										editor_change.from,
										editor_change.to,
										false,
									) === false))
					) {
						type = MarkAction.REGULAR;
					}
				}
			}

			const edits = mark_ranges(
				ranges,
				tr.startState.doc,
				editor_change.from,
				editor_change.to,
				editor_change.inserted,
				type,
				metadata,
				false,
				settings.metadata_syntax,
			);
			if (!edits.length) return undefined;
			const added_offset = edits.slice(0, -1).reduce((acc, op) => acc - (op.to - op.from) + op.insert.length, 0);
			return {
				changes: edits,
				cursor: backwards_delete ? edits[0].start : edits[edits.length - 1].end + added_offset,
			};
		}

		function addition(at: number, text: string): GuardedEdit {
			const edits = mark_ranges(
				new CriticMarkupRanges([]),
				tr.startState.doc,
				at,
				at,
				text,
				SuggestionType.ADDITION,
				metadata,
				false,
				settings.metadata_syntax,
			);
			const added_offset = edits.slice(0, -1).reduce((acc, op) => acc - (op.to - op.from) + op.insert.length, 0);
			return { changes: edits, cursor: edits[edits.length - 1].end + added_offset };
		}

		function deletion(from: number, to: number): GuardedEdit {
			const edits = mark_ranges(
				new CriticMarkupRanges([]),
				tr.startState.doc,
				from,
				to,
				"",
				SuggestionType.DELETION,
				metadata,
				false,
				settings.metadata_syntax,
			);
			const added_offset = edits.slice(0, -1).reduce((acc, op) => acc - (op.to - op.from) + op.insert.length, 0);
			return {
				changes: edits,
				cursor: backwards_delete ? edits[0].start : edits[edits.length - 1].end + added_offset,
			};
		}

		// EXPL: Each change is decided on its own by the fence guard (see fence-guard.ts): tracked in prose, plain in
		//       code, and never in a way that breaks a fence. A change it refuses leaves its cursor where it was and
		//       does not affect the other cursors' changes. Positions are in the START document; `offset` carries the
		//       length change of the earlier changes into each cursor.
		const edits = guardSuggestions(
			tr.startState.doc,
			tr.startState.field(rangeParser).code_regions,
			changed_ranges,
			{
				track,
				addition,
				deletion,
				ownText: (from, to) => {
					const inside = ranges.ranges_in_interval(from, to);
					return inside.length === 1 && inside[0].type === SuggestionType.ADDITION &&
						inside[0].encloses_range(from, to);
				},
			},
		);
		const changes: EditorChange[] = [];
		const selections: SelectionRange[] = [];
		let offset = 0;
		let unchanged = true;
		for (let i = 0; i < changed_ranges.length; i++) {
			const change = changed_ranges[i];
			const edit = edits[i];
			if (!edit) {
				selections.push(EditorSelection.cursor((tr.startState.selection.ranges[i]?.head ?? change.from) + offset));
				unchanged = false;
				continue;
			}
			const [first] = edit.changes;
			if (
				edit.changes.length !== 1 || first.from !== change.from || first.to !== change.to ||
				first.insert !== change.inserted
			) {
				unchanged = false;
			}
			changes.push(...edit.changes);
			selections.push(EditorSelection.cursor(edit.cursor + offset));
			offset += editDelta(edit);
		}

		if (unchanged)
			return tr;
		if (!changes.length)
			return tr.startState.update({ filter: false });

		const forwardedEvent = deriveUserEvent(tr);
		return tr.startState.update({
			changes,
			selection: EditorSelection.create(selections),
			annotations: forwardedEvent ?
				[Transaction.userEvent.of(forwardedEvent), pluginEditAnnotation.of(true)] :
				[pluginEditAnnotation.of(true)],
			filter: false,
		});
	} // CASE 2: Handle cursor movements
	else if (
		isUserEvent("select", userEvents) && cursorMoved(tr) &&
		settings.alternative_cursor_movement /*&& tr.startState.field(editorLivePreviewField)*/
	) {
		if (latest_event && latest_event.instanceOf(KeyboardEvent)) {
			const result = cursor_transaction_pass_syntax(tr, userEvents, vim_mode, settings, latest_event);
			if (result) {
				const forwardedEvent = deriveUserEvent(tr);
				return tr.startState.update({
					...result,
					annotations: forwardedEvent ? [Transaction.userEvent.of(forwardedEvent)] : result.annotations,
					filter: false,
				});
			}
			return tr;
		}
	}

	return tr;
}
