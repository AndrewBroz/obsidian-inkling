import { ChangeSet, EditorSelection, EditorState, type Extension, StateEffect, Transaction } from "@codemirror/state";
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

import { findCodeRegions } from "../../../base/edit-util/code-regions";
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

const FENCES = /`{3}|~{3}/;
/** A line's start that is only line markers, each followed by a space: `> `, `## `, `- `, `1. `, `- [ ] `. */
const LINE_MARKERS = /^(?:[ \t]*(?:>|#{1,6}|(?:[-*+]|\d{1,9}[.)])(?: \[[ xX]\])?) +)+$/;
const MARKUP = /\{(?:\+\+|--|~~|==|>>)(?:\{[^{}]*\}@@)?|(?:\+\+|--|~~|==|<<)\}(?:\{[^{}]*\})?|~>/g;

type Piece = { text: string; markup: boolean };

/** `text` split into its characters, except that each delimiter, with any metadata it carries, is one piece. */
function pieces(text: string) {
	const out: Piece[] = [];
	const chars = (slice: string) => [...slice].map(char => ({ text: char, markup: false }));
	let last = 0;
	for (const m of text.matchAll(MARKUP)) {
		out.push(...chars(text.slice(last, m.index)), { text: m[0], markup: true });
		last = m.index + m[0].length;
	}
	out.push(...chars(text.slice(last)));
	return out;
}

/** Moves each lone insertion or deletion in `diffs` that could as well sit elsewhere in a run of the same text toward `at`. */
function slide(diffs: [number, string][], at: number) {
	let p = 0;
	for (let k = 0; k < diffs.length; k++) {
		if (diffs[k][0] !== 0 && (diffs[k - 1]?.[0] ?? 0) === 0 && (diffs[k + 1]?.[0] ?? 0) === 0) {
			if (k === 0) {
				diffs.unshift([0, ""]);
				k++;
			}
			if (k === diffs.length - 1) diffs.push([0, ""]);
			const left = diffs[k - 1], right = diffs[k + 1], change = diffs[k];
			for (let c; p > at && (c = left[1].at(-1)) !== undefined && c === change[1].at(-1); p--)
				[left[1], change[1], right[1]] = [left[1].slice(0, -1), c + change[1].slice(0, -1), c + right[1]];
			for (let c; p < at && (c = right[1][0]) !== undefined && c === change[1][0]; p++)
				[left[1], change[1], right[1]] = [left[1] + c, change[1].slice(1) + c, right[1].slice(1)];
		}
		if (diffs[k][0] !== 1) p += diffs[k][1].length;
	}
}

/**
 * `edit` (replacing `old`) as the changes a diff finds, so positions in text it keeps map through it. `at` is where
 * the change that made `edit` was: of equal diffs (text typed into a run of the same character), the one nearest it.
 * EXPL: The diff is of pieces (see `pieces`). Text is aligned first, on its own; the markup between two characters it
 *       keeps is diffed after. A diff of characters, when an edit also rewrote a range's metadata (its format, author
 *       or time), aligned the range's text with characters of the metadata, and mapped other cursors in that range to
 *       the wrong place.
 */
function minimal(old: string, edit: { from: number; insert: string }, at: number) {
	const codes = new Map<string, string>();
	// (A piece is one character to the diff. Only alignment rides on the code: one equal to some character aligns worse.)
	const code = ({ text }: Piece) => {
		if (text.length === 1) return text;
		if (!codes.has(text)) codes.set(text, String.fromCharCode(0xE000 + codes.size));
		return codes.get(text)!;
	};
	const before = pieces(old), after = pieces(edit.insert);
	const text_of = (list: Piece[]) => list.flatMap((piece, i) => piece.markup ? [] : [i]);
	const text_before = text_of(before), text_after = text_of(after);
	let target = 0;
	for (
		let i = 0, raw = edit.from;
		i < before.length && raw + before[i].text.length <= at;
		raw += before[i++].text.length
	) {
		if (!before[i].markup) target++;
	}
	const diffs = dmp.diff_main(
		text_before.map(i => code(before[i])).join(""),
		text_after.map(i => code(after[i])).join(""),
	);
	slide(diffs, target);
	// The pieces of text kept, as [index in `before`, in `after`], between the two ends.
	const kept: [number, number][] = [[-1, -1]];
	let x = 0, y = 0;
	for (const [op, text] of diffs) {
		if (op === 0) { for (let n = 0; n < text.length; n++) kept.push([text_before[x++], text_after[y++]]); }
		else if (op === -1) x += text.length;
		else y += text.length;
	}
	kept.push([before.length, after.length]);

	const out: { from: number; to: number; insert: string }[] = [];
	let pos = edit.from;
	for (let k = 1; k < kept.length; k++) {
		const gap_before = before.slice(kept[k - 1][0] + 1, kept[k][0]),
			gap_after = after.slice(kept[k - 1][1] + 1, kept[k][1]);
		let a = 0, b = 0;
		for (const [op, text] of dmp.diff_main(gap_before.map(code).join(""), gap_after.map(code).join(""))) {
			if (op !== 0 && out.at(-1)?.to !== pos) out.push({ from: pos, to: pos, insert: "" });
			if (op === 1) {
				out.at(-1)!.insert += gap_after.slice(b, b += text.length).map(piece => piece.text).join("");
				continue;
			}
			pos += gap_before.slice(a, a += text.length).reduce((n, piece) => n + piece.text.length, 0);
			if (op === -1) out.at(-1)!.to = pos;
			else b += text.length;
		}
		pos += before[kept[k][0]]?.text.length ?? 0;
	}
	return out;
}

/** What `text` says: its text and each range's type, parts and fields, but not how its metadata is written, nor times. */
function reading(text: string, settings: PluginSettings) {
	for (const r of getRangesInText(text, settings).reverse()) {
		const fields = Object.entries(r.fields).filter(([key, value]) => key !== "time" && value !== undefined).sort();
		const said = JSON.stringify([r.type, r.unwrap_parts(), fields]);
		text = text.slice(0, r.from) + "\0" + said + "\0" + text.slice(r.to);
	}
	return text;
}

/**
 * The effects of `tr`, a single insertion, mapped into the document its tracked form `all` makes, where the inserted
 * text ends at `end`; none if `tr` is anything else, or its text is not there.
 * EXPL: The tracked edit replaces the user's, which drops its effects, among them the one by which Obsidian types over
 *       an auto-paired bracket: `(a)` came out as `(a))`. The two documents are the same before both edits and after
 *       both, and hold the inserted text; around it, positions map to the edge of the markup that differs.
 */
function carriedEffects(tr: Transaction, all: ChangeSet, end: number): readonly StateEffect<unknown>[] {
	const edits: { fromA: number; toA: number; fromB: number; toB: number; text: string }[] = [];
	tr.changes.iterChanges((fromA, toA, fromB, toB, text) =>
		edits.push({ fromA, toA, fromB, toB, text: text.toString() })
	);
	if (!tr.effects.length || edits.length !== 1 || edits[0].fromA !== edits[0].toA) return [];
	const { fromA, fromB, toB, text } = edits[0];
	let low = fromA, high = fromA;
	all.iterChangedRanges((from, to) => {
		low = Math.min(low, from);
		high = Math.max(high, to);
	});
	const theirs = tr.newDoc, ours = all.apply(tr.startState.doc), start = end - text.length;
	const suffix = tr.startState.doc.length - high;
	if (start < low || end > ours.length - suffix || ours.sliceString(start, end) !== text) return [];
	const mapping = ChangeSet.of([
		{ from: low, to: fromB, insert: ours.sliceString(low, start) },
		{ from: toB, to: theirs.length - suffix, insert: ours.sliceString(end, ours.length - suffix) },
	], theirs.length);
	return StateEffect.mapEffects(tr.effects, mapping);
}

// TODO: Functionality: Double click mouse should also floodfill (problem: no specific userevent attached)
function applySuggestion(tr: Transaction, settings: PluginSettings): Transaction {
	const editor = tr.startState.field(editorEditorField) as EditorView & { cm: VimEditor };
	const userEvents = getUserEvents(tr);
	const vim_mode = editor.cm !== undefined;

	// TODO: Resolve used vim cursor movements since they do not receive user event annotations
	if (vim_mode && !tr.docChanged && tr.selection) {
		if (cursorMoved(tr)) {
			userEvents.push(
				tr.startState.selection.ranges[0].from < tr.selection.ranges[0].from ?
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
		// EXPL: A change touching a code block (its content or a fence line, in the document before it), or inserting text
		//       that is part of a code block after it (a pasted block), is applied as typed, untracked: markup there would
		//       be inert text in the code, or would sit on a fence line. A user who breaks a fence breaks it.
		const pasted_regions = changed_ranges.some(c => FENCES.test(c.inserted)) ?
			findCodeRegions(tr.state.doc.toString()) :
			[];
		const in_code = ({ from, to, inserted }: EditorEditChange) =>
			code_regions.some(region => region.from <= to && from <= region.to) || FENCES.test(inserted) &&
				pasted_regions.some(r => r.from <= tr.changes.mapPos(to, 1) && tr.changes.mapPos(from, -1) <= r.to);
		if (changed_ranges.length > 0 && changed_ranges.every(in_code))
			return tr;

		const metadata = generate_metadata(settings);

		const backwards_delete = tr.isUserEvent("delete.backward") || (latest_event as KeyboardEvent)?.key === "Backspace";
		// EXPL: How far before the end of each change's inserted text the edit left its cursor: an auto-paired bracket
		//       or quote (`(` typed as `()`) puts it between the pair. The tracked insertion keeps it there. Only a
		//       cursor the edit set counts: a mapped one stays before text inserted at it.
		const tails: number[] = [];
		tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
			const sel = tr.selection?.ranges[Math.min(tails.length, tr.selection.ranges.length - 1)];
			tails.push(sel?.empty && fromB <= sel.head && sel.head < toB ? toB - sel.head : 0);
		});
		const group_delete = (latest_event as KeyboardEvent)?.ctrlKey;
		// EXPL: Each change is tracked in turn, from the last cursor to the first, in the document the later ones left
		//       (its positions mapped there): tracked against the start document, two cursors in one range each rewrote
		//       it and duplicated its text. Before `low`, the first position the later ones changed, the document and
		//       its ranges are the start ones; a change whose line or ranges reach `low` gets them parsed afresh. Edits are
		//       reduced to what they change, so other positions map through them: other cursors, and what the editor
		//       keeps by position, such as where Obsidian put an auto-paired closer it will type over (rewriting the whole
		//       range dropped it, so `(a)` typed in one's own addition came out as `(a))`).
		let state = tr.startState, doc = state.doc, all = ChangeSet.empty(doc.length), low = Infinity;
		let fresh: CriticMarkupRanges | undefined;
		const cursors: number[] = [];
		/** Change `i`'s `edits` (in `doc`), made at `at`, as the changes they make there (see `minimal`). */
		const reduce = (edits: { from: number; to: number; insert: string }[], at: number) =>
			ChangeSet.of(edits.flatMap(edit => minimal(doc.sliceString(edit.from, edit.to), edit, at)), doc.length);
		/** Applies change `i`'s `edits` (in `doc`, made at `at`), with its cursor at `cursor`, for the changes before it. */
		const apply = (i: number, edits: { from: number; to: number; insert: string }[], cursor: number, at: number) => {
			const changes = reduce(edits, at);
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
				apply(i, [{ from, to, insert: original.inserted }], from + original.inserted.length - tails[i], from);
				continue;
			}
			// EXPL: A line marker (quote, heading, list item, task) typed at the start of a line goes in as typed,
			//       untracked, like code; text typed after it is tracked. Key by key, the marker's first characters were
			//       tracked as one's own addition (`{++-++}`); the space that completes it unwraps them.
			if (from === to && original.inserted.endsWith(" ") && !original.inserted.includes("\n")) {
				const line_start = doc.lineAt(from).from;
				const around = ranges.ranges_in_interval(from, from);
				const own = around.find(r =>
					r.type === SuggestionType.ADDITION && r.from >= line_start && from === r.closer_to - 3 &&
					!r.replies.length && range_metadata_compatible(r, metadata).compatible
				);
				const start = own?.from ?? from, typed = (own?.unwrap() ?? "") + original.inserted;
				// (Not inside another range that began on an earlier line: the line's start there is that range's text.)
				const outside = around.every(r => r === own || r.from === from);
				if (outside && LINE_MARKERS.test(doc.sliceString(line_start, start) + typed)) {
					apply(i, [{ from: start, to: own?.to ?? from, insert: typed }], start + typed.length, from);
					continue;
				}
			}
			// EXPL: Typing in one's own addition that would make one of its lines a fence line (markup ignored, as the
			//       parser reads fences) ends the addition before that line, and reopens it after the line if it goes on;
			//       the line's text goes in untracked. A block typed key by key stays a block.
			const line = doc.lineAt(from),
				r = from === to &&
					ranges.ranges_in_interval(from, from).find(r =>
						r.type === SuggestionType.ADDITION && r.range_start <= from && from <= r.closer_to - 3 &&
						range_metadata_compatible(r, metadata).compatible
					);
			const plain = (doc.sliceString(line.from, from) + original.inserted + doc.sliceString(from, line.to))
				.replace(MARKUP, "");
			if (
				r && FENCES.test(plain) &&
				findCodeRegions(doc.sliceString(0, line.from) + plain + doc.sliceString(line.to))
					.some(c => c.from === line.from || c.close_from === line.from)
			) {
				const keep = r.range_start < line.from - 1, start = keep ? line.from - 1 : r.from;
				const closer = doc.sliceString(r.closer_to - 3, r.to), end = Math.min(line.to, r.closer_to - 3);
				const after = doc.sliceString(line.to + 1, r.closer_to - 3), rest = doc.sliceString(from, end);
				const typed = (keep ? closer : "") + (r.range_start < line.from ? "\n" : "") +
					doc.sliceString(Math.max(line.from, r.range_start), from) + original.inserted;
				const tail = end < r.closer_to - 3 ?
					"\n" + (after && doc.sliceString(r.from, r.range_start) + after + closer) :
					"";
				apply(i, [{ from: start, to: r.to, insert: typed + rest + tail }], start + typed.length, from);
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
			);
			const added_offset = edits.slice(0, -1).reduce((acc, op) => acc - (op.to - op.from) + op.insert.length, 0);
			const cursor = backwards_delete ? edits[0].start : edits[edits.length - 1].end + added_offset - tails[i];
			// EXPL: A keystroke that changes what the document says (see `reading`) is tracked; one that does not
			//       (Backspace inside one's own deletion) leaves it alone, where rewriting the range would only have
			//       converted its metadata's format or refreshed its time. The cursor moves as it would have.
			if (!original.inserted && edits.length) {
				const reduced = reduce(edits, editor_change.from);
				const touched = ranges.ranges_in_interval(
					Math.min(...edits.map(edit => edit.from)),
					Math.max(...edits.map(edit => edit.to)),
				);
				const lo = Math.min(...edits.map(edit => edit.from), ...touched.map(r => r.from));
				const hi = Math.max(...edits.map(edit => edit.to), ...touched.map(r => r.to));
				const now = reduced.apply(doc).sliceString(reduced.mapPos(lo, -1), reduced.mapPos(hi, 1));
				if (reading(doc.sliceString(lo, hi), settings) === reading(now, settings)) {
					apply(i, [], reduced.invert(doc).mapPos(cursor), editor_change.from);
					continue;
				}
			}
			apply(i, edits, cursor, editor_change.from);
		}

		if (!changed_ranges.length)
			return tr;

		const forwardedEvent = deriveUserEvent(tr);
		return tr.startState.update({
			changes: all,
			selection: EditorSelection.create(cursors.map(cursor => EditorSelection.cursor(cursor))),
			effects: carriedEffects(tr, all, cursors[0] + tails[0]),
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
