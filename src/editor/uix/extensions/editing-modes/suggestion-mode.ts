import { ChangeSet, EditorSelection, EditorState, type Extension, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import DiffMatchPatch from "diff-match-patch";
import { editorEditorField } from "obsidian";
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
	getRangesInText,
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

import { FENCE } from "../../../base/edit-util/code-regions";
import { latest_event } from "../keypress-catcher";
import { cursor_transaction_pass_syntax } from "./cursor_movement";
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

const dmp = new DiffMatchPatch();

/** `edit` (replacing `old`) as the changes a character diff finds, so positions in text it keeps map through it. */
function minimal(old: string, edit: { from: number; insert: string }) {
	const out: { from: number; to: number; insert: string }[] = [];
	let pos = edit.from;
	for (const [op, text] of dmp.diff_main(old, edit.insert)) {
		if (op !== 0 && out.at(-1)?.to !== pos) out.push({ from: pos, to: pos, insert: "" });
		if (op === 1) out.at(-1)!.insert += text;
		else pos += text.length;
		if (op === -1) out.at(-1)!.to = pos;
	}
	return out;
}

const FENCE_LINE = new RegExp(FENCE.source, "m");
const MARKUP = /\{(?:\+\+|--|~~|==|>>)(?:\{[^{}]*\}@@)?|(?:\+\+|--|~~|==|<<)\}(?:\{[^{}]*\})?|~>/g;

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

		const { ranges: start_ranges, code_regions } = tr.startState.field(rangeParser);
		let ranges: CriticMarkupRanges;
		// EXPL: A change touching a code block (its content or a fence line, start-document positions), or inserting a
		//       fence-shaped line, is applied as typed, untracked: markup there would be inert text in the code, or would
		//       sit on a fence line. A user who breaks a fence breaks it.
		const in_code = ({ from, to, inserted }: EditorEditChange) =>
			FENCE_LINE.test(inserted) || code_regions.some(region => region.from <= to && from <= region.to);
		if (changed_ranges.length > 0 && changed_ranges.every(in_code))
			return tr;

		const metadata = generate_metadata(settings);

		const backwards_delete = tr.isUserEvent("delete.backward") || (latest_event as KeyboardEvent)?.key === "Backspace";
		const group_delete = (latest_event as KeyboardEvent)?.ctrlKey;
		// EXPL: Each change is tracked in turn, from the last cursor to the first, in the document the later ones left
		//       (its positions mapped there): tracked against the start document, two cursors in one range each rewrote
		//       it and duplicated its text. Before `low`, the first position the later ones changed, the document and
		//       its ranges are the start ones; a change whose line or ranges reach `low` gets them parsed afresh. With several
		//       changes, edits are reduced to what they change, so other positions map through them.
		let state = tr.startState, doc = state.doc, all = ChangeSet.empty(doc.length), low = Infinity;
		let fresh: CriticMarkupRanges | undefined;
		const cursors: number[] = [];
		/** Applies change `i`'s `edits` (in `doc`), with its cursor at `cursor`, for the changes before it. */
		const apply = (i: number, edits: { from: number; to: number; insert: string }[], cursor: number) => {
			const changes = ChangeSet.of(
				changed_ranges.length > 1 ? edits.flatMap(edit => minimal(doc.sliceString(edit.from, edit.to), edit)) : edits,
				doc.length,
			);
			for (let k = i + 1; k < cursors.length; k++) cursors[k] = changes.mapPos(cursors[k]);
			cursors[i] = cursor;
			all = all.compose(changes);
			if (changes.empty || i === 0) return;
			changes.iterChangedRanges(fromA => low = Math.min(low, fromA));
			doc = changes.apply(doc);
			fresh = undefined;
			state = { doc, charCategorizer: tr.startState.charCategorizer.bind(tr.startState) } as EditorState;
		};
		for (let i = changed_ranges.length - 1; i >= 0; i--) {
			const original = changed_ranges[i];
			// A Backspace or Delete is taken from its mapped cursor, as its character may be one a later cursor rewrote.
			// In an opener (Backspace) or a closer (Delete) it acts just outside the range, so it is taken from there.
			const keystroke = !original.selection && !original.inserted, start = original.anchor ?? original.from;
			let at = start;
			for (const r of keystroke ? start_ranges.ranges_in_interval(at, at) : []) {
				if (backwards_delete && r.from < at && at <= r.range_start) at = r.from;
				else if (!backwards_delete && r.closer_to - 3 <= at && at < r.to) at = r.to;
			}
			const anchor = all.mapPos(at, -1);
			const from = keystroke ? Math.max(0, anchor + original.from - start) : all.mapPos(original.from, 1);
			const to = keystroke ?
				Math.min(doc.length, from + original.to - original.from) :
				Math.max(from, all.mapPos(original.to, -1));
			// (A Delete may reach the next line's start, or move through a range there.)
			const reach = doc.lineAt(to).to + 1;
			ranges = reach < low && start_ranges.ranges_in_interval(from, reach).every(r => r.to < low) ?
				start_ranges :
				(fresh ??= new CriticMarkupRanges(getRangesInText(doc.toString(), settings)));
			let editor_change = { ...original, from, to, anchor, deleted: doc.sliceString(from, to) };
			if (in_code(original)) {
				apply(i, [{ from, to, insert: original.inserted }], from + original.inserted.length);
				continue;
			}
			// EXPL: Typing in one's own addition that would make its closer's line fence-shaped (markup ignored) ends the
			//       addition before that line; the line's text goes in untracked. A block typed key by key stays a block.
			const line = doc.lineAt(from),
				r = from === to &&
					ranges.ranges_in_interval(from, from).find(r =>
						r.type === SuggestionType.ADDITION && r.range_start <= from && from <= r.closer_to - 3 &&
						r.closer_to <= line.to && range_metadata_compatible(r, metadata).compatible
					);
			const plain = doc.sliceString(line.from, from) + original.inserted + doc.sliceString(from, line.to);
			if (r && FENCE.test(plain.replace(MARKUP, ""))) {
				const keep = r.range_start < line.from - 1, start = keep ? line.from - 1 : r.from;
				const rest = doc.sliceString(from, r.closer_to - 3);
				const insert = (keep ? doc.sliceString(r.closer_to - 3, r.to) : "") + (r.range_start < line.from ? "\n" : "") +
					doc.sliceString(Math.max(line.from, r.range_start), from) + original.inserted + rest;
				apply(i, [{ from: start, to: r.to, insert }], start + insert.length - rest.length);
				continue;
			}
			// EXPL: A selection end inside a substitution's "~>" is at its start (or, for the selection's start, its end):
			//       splitting the separator left a stray ">".
			for (const r of ranges.ranges_in_interval(editor_change.from, editor_change.to)) {
				if (r.type !== SuggestionType.SUBSTITUTION || !editor_change.selection) continue;
				const middle = (r as SubstitutionRange).middle;
				const from = editor_change.from === middle + 1 ? middle + 2 : editor_change.from;
				const to = Math.max(from, editor_change.to === middle + 1 ? middle : editor_change.to);
				editor_change = { ...editor_change, from, to, deleted: doc.sliceString(from, to) };
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

				const ranges_in_range = ranges.ranges_in_interval(editor_change.from, editor_change.to);
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
				doc,
				editor_change.from,
				editor_change.to,
				editor_change.inserted,
				type,
				metadata,
				false,
				settings.metadata_syntax,
			);
			const added_offset = edits.slice(0, -1).reduce((acc, op) => acc - (op.to - op.from) + op.insert.length, 0);
			apply(i, edits, backwards_delete ? edits[0].start : edits[edits.length - 1].end + added_offset);
		}

		if (!changed_ranges.length)
			return tr;

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
