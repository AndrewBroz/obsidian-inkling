import { ChangeSet, type Text } from "@codemirror/state";

import type { EditorChange, EditorEditChange } from "../../../base";
import { type CodeRegion, fenceMarker, findCodeRegions, regionsPreserved } from "../../../base/edit-util/code-regions";

/** Changes for one suggest-mode change, in document positions, and where its cursor ends up after them alone. */
export interface GuardedEdit {
	changes: EditorChange[];
	cursor: number;
}

/** How suggest mode tracks a change (positions in the document the transaction starts from). */
export interface SuggestionTracker {
	/** The usual tracked suggestion for `change`. */
	track(change: EditorEditChange): GuardedEdit | undefined;
	/** `text` inserted at `at` as an addition of its own; undefined if `at` is inside a range. */
	addition(at: number, text: string): GuardedEdit | undefined;
	/**
	 * `[from, to)` as a deletion of its own, with `before` and `after` added inside it around the deleted text;
	 * undefined if it overlaps a range.
	 */
	deletion(from: number, to: number, before?: string, after?: string): GuardedEdit | undefined;
	/** Whether `[from, to)` lies inside one addition, where deleting removes the suggested text outright. */
	ownText(from: number, to: number): boolean;
	/** The end of the range whose content ends at `pos`, if there is one. */
	rangeEnd(pos: number): number | undefined;
}

const FENCE_TEXT = /(^|\n)[ >]*(```|~~~)/;
const DELIMITER_CHAR = /[{}+~=<>-]/;

const delta = (edit: GuardedEdit) => edit.changes.reduce((sum, c) => sum + c.insert.length - (c.to - c.from), 0);

/**
 * Decides one suggest-mode change so that no CriticMarkup ends up on a fence line or in code (see the 0.13.0 spec's
 * addendum). In order:
 * 1. a change inside a block (its content, or the opening line after the fence) that keeps every fence line: plain;
 * 2. the usual tracked edit, if it leaves exactly the blocks it should: every old block, unchanged (a tracked deletion
 *    keeps its text), plus the complete blocks in the inserted text;
 * 3. a whitespace-only change on a fence line that keeps every fence line (Enter after a closing fence): plain;
 * 4. adjusted forms, checked the same way: text typed before a fence moves onto its own line above it (tracked above
 *    an opening fence, plain above a closing one), or below a closing fence typed after; a deletion covering fence
 *    characters is widened to whole blocks; markers move onto prose lines by shifting an equivalent deletion or
 *    insertion by a character, or by a line break inside the range;
 * otherwise the change is refused (null), and suggest mode shows a notice.
 */
function decide(doc: Text, regions: CodeRegion[], change: EditorEditChange, tracker: SuggestionTracker) {
	const { from, to, inserted } = change;
	const plain: GuardedEdit = { changes: [{ from, to, insert: inserted }], cursor: from + inserted.length };
	const fences = regions.flatMap(region =>
		(region.close_from < region.to ? [region.from, region.close_from] : [region.from]).map(at => {
			const line = doc.lineAt(at), marker = fenceMarker(line.text)!;
			return { region, at, prefix: marker.prefix, marker_from: at + marker.from, marker_to: at + marker.to };
		})
	);

	function result(edit: GuardedEdit) {
		const changes = ChangeSet.of(edit.changes, doc.length);
		const next = changes.apply(doc);
		// EXPL: Without a region, a region can only appear on a changed line.
		let fence = regions.length > 0;
		changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
			fence ||= FENCE_TEXT.test(next.sliceString(next.lineAt(fromB).from, next.lineAt(toB).to));
		});
		return { changes, next, regions: fence ? findCodeRegions(next.toString()) : [] };
	}

	/** Whether `edit`, which writes no markup, keeps every block's fence lines. */
	const keeps = (edit: GuardedEdit) => {
		const res = result(edit);
		return regionsPreserved(regions, res.changes, res.regions);
	};

	const inserted_blocks = FENCE_TEXT.test(inserted) ?
		findCodeRegions(inserted).filter(r => r.close_from < r.to).map(r => inserted.slice(r.from, r.to)) :
		[];
	/**
	 * Whether tracked `edit` leaves the old blocks unchanged (without those in `[a, b)` if it `removes` them, as from
	 * one's own addition) and the inserted text's complete blocks after `[a, b)`.
	 */
	function valid(edit: GuardedEdit | undefined, a = from, b = to, removes = false): edit is GuardedEdit {
		if (!edit) return false;
		const { next, regions: next_regions } = result(edit);
		const text = (r: CodeRegion) => doc.sliceString(r.from, r.to);
		const expected = [
			...regions.filter(r => r.from < b && !(removes && a <= r.from && r.to <= b)).map(text),
			...inserted_blocks,
			...regions.filter(r => r.from >= b).map(text),
		];
		return next_regions.length === expected.length &&
			next_regions.every((r, i) => next.sliceString(r.from, r.to) === expected[i]);
	}

	// 1: anywhere on a block's lines, but not text inserted before the opening line or after the closing one; keeping
	//    the line breaks after the opening line and before the closing one (replacing all of a block's content) if
	//    needed.
	const block = regions.find(r =>
		r.from <= from && to <= r.to && !(from === to && (from === r.from || (from === r.to && r.close_from < r.to)))
	);
	if (block) {
		if (keeps(plain)) return plain;
		const a = from === block.open_to ? from + 1 : from, b = to === block.close_from ? to - 1 : to;
		const kept = { changes: [{ from: a, to: b, insert: inserted }], cursor: a + inserted.length };
		if (a <= b && (a < b || inserted) && (a !== from || b !== to) && keeps(kept)) return kept;
	}

	// 2
	const tracked = tracker.track({ ...change });
	if (valid(tracked, from, to, tracker.ownText(from, to))) return tracked;

	// 3
	const on_fence_line = fences.some(f => f.at <= from && to <= doc.lineAt(f.at).to);
	if (on_fence_line && !/\S/.test(inserted + doc.sliceString(from, to)) && keeps(plain)) return plain;

	// 4
	const char = (pos: number) => doc.sliceString(pos, pos + 1);
	const HELPERS = [["", ""], ["\n", ""], ["", "\n"], ["\n", "\n"]];
	const quoted = (lines: typeof fences) => lines.some(f => f.prefix.includes(">"));
	if (from === to) {
		const at_fence = fences.find(f => f.at <= from && from < f.marker_to);
		// Text typed at a closing fence line's start, in its prefix or fence characters goes onto its own line above
		// it, in the block's content.
		if (at_fence && at_fence.at === at_fence.region.close_from) {
			const insert = at_fence.prefix + inserted.replaceAll("\n", "\n" + at_fence.prefix) + "\n";
			const above = {
				changes: [{ from: at_fence.at, to: at_fence.at, insert }],
				cursor: at_fence.at + insert.length - 1,
			};
			return keeps(above) ? above : null;
		}
		const after = fences.find(f => f.at === f.region.close_from && f.region.to === from);
		const range_end = tracker.rangeEnd(from);
		const candidates: [GuardedEdit | undefined, number][] = [];
		/** `addition` with `before` inserted before it and `after` after it, at `at`. */
		const around = (addition: GuardedEdit | undefined, at: number, before: string, after: string) =>
			addition && {
				changes: [{ from: at, to: at, insert: before }, ...addition.changes, { from: at, to: at, insert: after }],
				cursor: addition.cursor + before.length,
			};
		for (const [i, [before, after_text]] of (quoted(fences) ? HELPERS.slice(0, 1) : HELPERS).entries()) {
			const add = (at: number, text: string) => tracker.addition(at, before + text + after_text);
			candidates.push([add(from, inserted), from]);
			// An insertion moved by a character it starts or ends with is the same insertion.
			if (char(from - 1) === inserted.at(-1))
				candidates.push([add(from - 1, char(from - 1) + inserted.slice(0, -1)), from]);
			if (char(from) === inserted[0]) candidates.push([add(from + 1, inserted.slice(1) + char(from)), from]);
			// Typed at an opening fence line's start, in its prefix or fence characters: on its own line above it.
			if (at_fence)
				candidates.push([around(add(at_fence.at, inserted), at_fence.at, at_fence.prefix, "\n"), at_fence.at]);
			// Typed after a closing fence: on its own line below it.
			if (after) candidates.push([around(add(from, inserted), from, "\n" + after.prefix, ""), from]);
			if (i === 0) {
				// Typed at the end of a range's content: an addition of its own after the range.
				if (range_end !== undefined) candidates.push([tracker.addition(range_end, inserted), from]);
				// Typed at an opening fence line's start inside an addition: on its own line, in the addition.
				const { at, prefix } = at_fence ?? {};
				const own_line = at_fence &&
					tracker.track({ ...change, from: at!, to: at!, inserted: prefix + inserted + "\n" });
				if (own_line) candidates.push([{ ...own_line, cursor: own_line.cursor - 1 }, at!]);
			}
		}
		return candidates.find(([edit, at]) => valid(edit, at, at))?.[0] ?? null;
	}

	// A deletion covering fence characters is widened to whole blocks; anything else is refused here.
	if (!fences.some(f => from < f.marker_to && f.marker_from < to)) return null;
	let a = from, b = to;
	for (const r of regions) {
		if (r.from < b && a < r.to) {
			a = Math.min(a, r.from);
			b = Math.max(b, r.to);
		}
	}
	const widened = tracker.track({ ...change, from: a, to: b, deleted: doc.sliceString(a, b), selection: true });
	if (valid(widened, a, b, tracker.ownText(a, b))) return widened;
	// A line break inside the deletion carries the quote or indent prefix of the fence line next to it.
	const inside = fences.filter(f => a <= f.at && f.at <= b), first = inside[0], last = inside.at(-1);
	const helpers = [["", ""], ["\n" + first.prefix, ""], ["", "\n" + last!.prefix], [
		"\n" + first.prefix,
		"\n" + last!.prefix,
	]];
	// Whole lines first (the line break after a closing fence goes too), then without a final line break; or from after
	// the first fence line's prefix to the end of the last fence line (the prefix stays, on a line of its own); each
	// also shifted by a character it starts and ends with (the same deletion).
	const ends = regions.some(r => r.to === b) && char(b) === "\n" ? [b + 1, b] : char(b - 1) === "\n" ? [b, b - 1] : [b];
	const starts = first.at === a && first.prefix ? [a, a + first.prefix.length] : [a];
	const windows: [number, number][] = [];
	for (const s of starts) {
		for (const e of s === a ? ends : [b]) {
			windows.push([s, e]);
			if (s > 0 && char(s - 1) === char(e - 1)) windows.push([s - 1, e - 1]);
			if (e < doc.length && char(s) === char(e)) windows.push([s + 1, e + 1]);
		}
	}
	for (const [s, e] of windows) {
		for (const [before, after] of helpers) {
			const deletion = tracker.deletion(s, e, before, after);
			if (!deletion) continue;
			if (!inserted && valid(deletion, s, e)) return deletion;
			for (const [before, after] of inserted ? helpers : []) {
				const addition = tracker.addition(e, before + inserted + after);
				const edit = addition &&
					{ changes: [...deletion.changes, ...addition.changes], cursor: addition.cursor + delta(deletion) };
				if (valid(edit, s, e)) return edit;
			}
		}
	}
	return null;
}

/**
 * The fence guard's edit for each of `changes` (one per cursor, in document order, positions in `doc`), in `doc`'s
 * positions, or null where a change is refused. Each change is decided on its own, in the document as the earlier
 * changes left it, so no cursor's edit can break a fence another's relies on.
 */
export function guardSuggestions(
	doc: Text,
	regions: CodeRegion[],
	changes: EditorEditChange[],
	tracker: SuggestionTracker,
): (GuardedEdit | null)[] {
	const start = doc;
	// EXPL: A tracked edit may re-emit a whole range around its cursor (typing inside an addition or a substitution's new
	//       text); only its minimal changes are kept, so two cursors in one range do not overlap. A cut never splits a
	//       delimiter, so a change rewriting one still covers it.
	const minimal = (change: EditorChange): EditorChange[] => {
		const old = start.sliceString(change.from, change.to), insert = change.insert;
		const max = Math.min(old.length, insert.length);
		let head = 0, tail = 0;
		while (head < max && old[head] === insert[head]) head++;
		while (tail < max - head && old[old.length - 1 - tail] === insert[insert.length - 1 - tail]) tail++;
		while (head > 0 && DELIMITER_CHAR.test(old[head - 1])) head--;
		while (tail > 0 && DELIMITER_CHAR.test(old[old.length - tail])) tail--;
		if (head === old.length && head === insert.length) return [];
		return [{ from: change.from + head, to: change.to - tail, insert: insert.slice(head, insert.length - tail) }];
	};
	let offset = 0, end = 0;
	return changes.map((change, i) => {
		const shift = <T extends GuardedEdit | undefined>(edit: T, by: number): T =>
			edit && {
				changes: edit.changes.map(c => ({ from: c.from + by, to: c.to + by, insert: c.insert })),
				cursor: edit.cursor + by,
			} as T;
		// EXPL: The tracker works in the start document; an edit of it reaching back over an earlier cursor's edit is not
		//       an option.
		const after_end = <T extends GuardedEdit | undefined>(edit: T) =>
			edit?.changes.every(c => c.from >= end) ? shift(edit, offset) : undefined;
		const local: SuggestionTracker = {
			track: c => {
				const edit = tracker.track({ ...c, from: c.from - offset, to: c.to - offset });
				return after_end(edit && { changes: edit.changes.flatMap(minimal), cursor: edit.cursor });
			},
			addition: (at, text) => after_end(tracker.addition(at - offset, text)),
			deletion: (f, t, before, after) => after_end(tracker.deletion(f - offset, t - offset, before, after)),
			ownText: (f, t) => tracker.ownText(f - offset, t - offset),
			rangeEnd: pos => {
				const at = tracker.rangeEnd(pos - offset);
				return at === undefined ? undefined : at + offset;
			},
		};
		// EXPL: A change inside text an earlier cursor's edit rewrote (a block it widened to) is refused, as is an edit
		//       reaching back over an earlier one.
		if (change.from < end) return null;
		const decided = decide(doc, regions, { ...change, from: change.from + offset, to: change.to + offset }, local);
		const edit = shift(decided ?? undefined, -offset);
		if (!edit || edit.changes.some(c => c.from < end)) return null;
		const applied = ChangeSet.of(decided!.changes, doc.length);
		doc = applied.apply(doc);
		if (i < changes.length - 1) regions = findCodeRegions(doc.toString());
		for (const c of edit.changes) end = Math.max(end, c.to);
		offset += applied.newLength - applied.length;
		return edit;
	});
}

export { delta as editDelta };
