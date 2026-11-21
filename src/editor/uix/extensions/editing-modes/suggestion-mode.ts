import { ChangeSet, EditorSelection, EditorState, type Extension, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorEditorField, Notice } from "obsidian";
import type { VimEditor } from "obsidian-typings";
import { type PluginSettings } from "../../../../types";

import {
	CriticMarkupRanges,
	cursor_move_range,
	cursorMoved,
	deriveUserEvent,
	type EditorEditChange,
	generate_metadata,
	getEditorRanges,
	getUserEvents,
	isUserEvent,
	mark_ranges,
	MarkAction,
	type MarkType,
	rangeParser,
	SubstitutionRange,
	SuggestionType,
} from "../../../base";

import { findCodeRegions } from "../../../base/edit-util/code-regions";
import { getRangesInText } from "../../../base/edit-util/range-parser";
import { latest_event } from "../keypress-catcher";
import { cursor_transaction_pass_syntax } from "./cursor_movement";
import { guardChange, type GuardedEdit, minimalChanges, type SuggestionTracker } from "./fence-guard";
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

		const metadata = generate_metadata(settings);
		const backwards_delete = (latest_event as KeyboardEvent)?.key === "Backspace";
		const group_delete = (latest_event as KeyboardEvent)?.ctrlKey;

		/** The change as a tracked suggestion in `state` (whose ranges are `ranges`), and where its cursor ends up. */
		function track(editor_change: EditorEditChange, state: EditorState, ranges: CriticMarkupRanges): GuardedEdit {
			// EXPL: A selection only of a range's markup (its opener and metadata, or its closer) deletes nothing; text
			//       typed over it goes after the range.
			const { from: start, to: end } = editor_change;
			const zone = editor_change.selection && start < end &&
				ranges.ranges_in_interval(start, end).find(r =>
					(r.from <= start && end <= r.range_start) || (r.closer_to - 3 <= start && end <= r.to)
				);
			if (zone) {
				if (!editor_change.inserted) return { changes: [], cursor: start };
				editor_change = { ...editor_change, from: zone.to, to: zone.to, deleted: "", selection: false };
			}
			let type: MarkType = editor_change.deleted ?
				(editor_change.inserted ? SuggestionType.SUBSTITUTION : SuggestionType.DELETION) :
				SuggestionType.ADDITION;
			if (type === SuggestionType.DELETION) {
				editor_change = cursor_move_range(
					editor_change,
					ranges,
					backwards_delete,
					group_delete,
					state,
					settings.suggestion_mode_operations.cursor_movement,
					settings.suggestion_mode_operations.bracket_movement,
				);

				// EXPL: Only ranges the deletion overlaps, once its ends are out of a neighbour's delimiters
				//       (mark_ranges snaps them the same way): a range that merely touches it, or whose closer or
				//       opener it only clips, is beside it.
				const { from, to } = editor_change;
				for (const range of ranges.ranges_in_interval(from, to)) {
					if (range.closer_to - 3 <= from && from < range.to && range.to < to) editor_change.from = range.to;
					if (from < range.from && range.from < to && to <= range.range_start) editor_change.to = range.from;
				}
				const ranges_in_range = ranges.ranges_in_interval(editor_change.from, editor_change.to)
					.filter(range => range.from < editor_change.to && editor_change.from < range.to);
				// EXPL: Pending added text (an addition, or a substitution's new part), whoever wrote it, is
				//       removed outright; base text inside a deletion or a highlight never is.
				if (ranges_in_range.length === 1) {
					const range = ranges_in_range[0];
					if (
						range.encloses_range(editor_change.from, editor_change.to) &&
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
				state.doc,
				editor_change.from,
				editor_change.to,
				editor_change.inserted,
				type,
				metadata,
				false,
				settings.metadata_syntax,
			);
			// EXPL: Nothing to do (deleting text already suggested for deletion): the cursor moves over it.
			if (!edits.length) return { changes: [], cursor: backwards_delete ? editor_change.from : editor_change.to };
			const added_offset = edits.slice(0, -1).reduce((acc, op) => acc - (op.to - op.from) + op.insert.length, 0);
			return {
				changes: edits,
				cursor: backwards_delete ? edits[0].start : edits[edits.length - 1].end + added_offset,
			};
		}

		/** How changes are tracked in `state`, whose ranges are `ranges`. */
		const trackerFor = (state: EditorState, ranges: CriticMarkupRanges): SuggestionTracker => ({
			track: change => track(change, state, ranges),
			addition(at, text) {
				if (ranges.ranges_in_interval(at, at).some(r => r.from < at && at < r.to)) return undefined;
				const [edit] = mark_ranges(
					new CriticMarkupRanges([]),
					state.doc,
					at,
					at,
					text,
					SuggestionType.ADDITION,
					metadata,
					false,
					settings.metadata_syntax,
				);
				return { changes: [edit], cursor: edit.end };
			},
			ownText(from, to) {
				const inside = ranges.ranges_in_interval(from, to);
				return inside.length === 1 && inside[0].type === SuggestionType.ADDITION && inside[0].encloses_range(from, to);
			},
			rangeEnd: pos => ranges.ranges_in_interval(pos, pos).find(r => r.closer_to - 3 === pos)?.full_range_back,
			inRange: pos => ranges.ranges_in_interval(pos, pos).some(r => r.from <= pos && pos < r.to),
		});

		// EXPL: The changes are decided by the fence guard one by one, from the last cursor to the first, each in the
		//       document the cursors after it left, its positions (and cursor) mapped there: the same as applying each
		//       cursor in turn. A Backspace or Delete is taken from its mapped cursor. The ranges and blocks are parsed
		//       afresh (range-state updates its ranges in place, so the start state is not advanced); the cursor code
		//       reads only the document and the editor's character categories, taken from the start state at the
		//       mapped-back position. A refused change keeps its cursor and leaves the others alone.
		let state = tr.startState, all = ChangeSet.empty(state.doc.length), unchanged = true, refused = false;
		let { ranges, code_regions } = state.field(rangeParser);
		const cursors: number[] = [];
		for (let i = changed_ranges.length - 1; i >= 0; i--) {
			const original = changed_ranges[i], anchor = original.anchor ?? original.from;
			const keystroke = !original.selection && !original.inserted, mapped = all.mapPos(anchor, -1);
			const length = state.doc.length,
				start = keystroke ? mapped + original.from - anchor : all.mapPos(original.from, -1);
			const from = Math.min(Math.max(0, start), length);
			const to = Math.min(
				keystroke ? start + original.to - original.from : Math.max(from, all.mapPos(original.to, -1)),
				length,
			);
			const change = { ...original, from, to, anchor: mapped, deleted: state.doc.sliceString(from, to) };
			// One whose text an earlier edit already removed has nothing left to do.
			const edit = from === to && !change.inserted ?
				{ changes: [], cursor: from } :
				guardChange(state.doc, code_regions, change, trackerFor(state, ranges));
			if (!edit) {
				refused = true;
				unchanged = false;
				cursors[i] = all.mapPos(tr.startState.selection.ranges[i]?.head ?? change.from);
				continue;
			}
			const [first] = edit.changes;
			if (
				edit.changes.length !== 1 || first.from !== change.from || first.to !== change.to ||
				first.insert !== change.inserted
			) {
				unchanged = false;
			}
			const changes = ChangeSet.of(minimalChanges(state.doc, edit.changes), state.doc.length);
			for (let k = i + 1; k < changed_ranges.length; k++) cursors[k] = changes.mapPos(cursors[k]);
			cursors[i] = edit.cursor;
			all = all.compose(changes);
			if (i > 0 && !changes.empty) {
				const doc = changes.apply(state.doc), back = all.invertedDesc;
				state = {
					doc,
					charCategorizer: (pos: number) => tr.startState.charCategorizer(back.mapPos(pos)),
				} as EditorState;
				ranges = new CriticMarkupRanges(getRangesInText(doc.toString(), settings));
				code_regions = findCodeRegions(doc.toString());
			}
		}
		if (refused) new Notice("Inkling: this edit would break a code fence in Suggest mode.");

		if (unchanged)
			return tr;
		if (all.empty)
			return tr.startState.update({ filter: false });

		const forwardedEvent = deriveUserEvent(tr);
		return tr.startState.update({
			changes: all,
			selection: EditorSelection.create(cursors.map(cursor => EditorSelection.cursor(cursor))),
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
