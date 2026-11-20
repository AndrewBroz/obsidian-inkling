import { ChangeSet, type Text } from "@codemirror/state";

import type { EditorChange, EditorEditChange } from "../../../base";
import {
	type CodeRegion,
	fenceMarker,
	findCodeRegions,
	inCodeRegion,
	regionsPreserved,
} from "../../../base/edit-util/code-regions";

/** Changes for one suggest-mode change, in start-document positions, and where its cursor ends up. */
export interface GuardedEdit {
	changes: EditorChange[];
	/** The cursor position in the document with only `changes` applied. */
	cursor: number;
}

/** How suggest mode would track a change; the guard asks for it when it needs it. */
export interface SuggestionTracker {
	/** The usual tracked suggestion for `change`, if it makes one. */
	track(change: EditorEditChange): GuardedEdit | undefined;
	/** `text` inserted at `at` as an addition of its own, not merged into a range around it. */
	addition(at: number, text: string): GuardedEdit;
	/** `[from, to)` as a deletion of its own, not merged into a range beside it. */
	deletion(from: number, to: number): GuardedEdit;
	/** Whether `[from, to)` lies inside one addition, where deleting removes the suggested text outright. */
	ownText(from: number, to: number): boolean;
}

const OPENER = /\{(?:\+\+|--|~~|==|>>)/g;
const FENCE_RUN = /```|~~~/;
const FENCE_LINE_IN = /(^|\n)[ >]*(```|~~~)/;

interface FenceLine {
	/** Start of the line. */
	from: number;
	/** The indent and quote markers before the fence (and before a range opener in front of it). */
	prefix: string;
	/** The fence characters. */
	marker_from: number;
	marker_to: number;
}

/**
 * The CriticMarkup openers in `doc` that overlap `[from, to)`, text an edit wrote: an opener can be partly kept text
 * (a change re-emitting `{--x--}` as `{~~x~>y~~}` only replaces the characters after the `{`).
 */
function openersWritten(doc: Text, from: number, to: number): number[] {
	const start = Math.max(0, from - 2);
	return [...doc.sliceString(start, Math.min(doc.length, to + 2)).matchAll(OPENER)]
		.map(m => start + m.index)
		.filter(pos => pos < to && pos + 3 > from);
}

/** The length change `edit` makes. */
export function editDelta(edit: GuardedEdit): number {
	return edit.changes.reduce((sum, c) => sum + c.insert.length - (c.to - c.from), 0);
}

/**
 * Guards suggest-mode edits against breaking fenced code.
 * INVARIANT: a suggest-mode edit never changes the document's fenced-code structure unless the user's own plain edit
 *            deliberately does, and never leaves CriticMarkup inside code content or on a fence line where it breaks
 *            the fence. "Structure-preserving" is `regionsPreserved`: the old regions map through the edit onto the
 *            regions of its result (the same comparison range-state uses to decide whether to re-parse).
 * EXPL: Each change is decided on its own (another cursor's change is never affected), by the first acceptable of:
 *       1. the tracked edit, if structure-preserving and writing no markup into code;
 *       2. the plain edit, if the change is whitespace-only or touches a block's lines, and structure-preserving;
 *       3. text inserted before a fence on its line (at the start, the indent or the `>` prefix): moved onto a new
 *          line above the fence, with the line's prefix. Above an opening fence it is prose and tracked; above a
 *          closing fence it is code content and plain. Prefix characters it replaces are deleted plain;
 *       4. a deletion of a line break (with quote markers or indent) that joins a fence line with a non-empty
 *          neighbour: refused;
 *       5. a change that would join a fence line with its neighbour keeps the line break: inside one block (from its
 *          opening line's info string to its closing line's prefix) it is applied plain with the line breaks after the
 *          opening line and before the closing line kept; from prose into an opening fence line's start or prefix it
 *          stops at the line break before it, tracked if possible (refused if nothing is left);
 *       6. a deletion covering fence characters: the user means to change the block, so it stays tracked, as long as
 *          the markup lands outside code. A tracked deletion starting in a block's content is split: the content
 *          part is deleted plain, the rest (from the closing fence line) tracked, so its opener sits before the fence;
 *       otherwise the plain edit, which writes no markup.
 *       Decided alone, one cursor's change can still break another's: a fence one cursor deletes can put the opener
 *       another cursor's tracked edit wrote inside code. Such an edit is decided again with nothing tracked (see
 *       `guardSuggestions`).
 */
function createFenceGuard(doc: Text, regions: CodeRegion[]) {
	function fenceLineAt(pos: number): FenceLine | undefined {
		const line = doc.lineAt(pos);
		const marker = fenceMarker(line.text);
		return marker &&
			{
				from: line.from,
				prefix: marker.prefix,
				marker_from: line.from + marker.from,
				marker_to: line.from + marker.to,
			};
	}

	const closed = (r: CodeRegion) => r.inner_to < doc.length;

	/** The fence lines of every region: opening lines, and closing lines of closed regions. */
	function fenceLines(): { line: FenceLine; region: CodeRegion; closing: boolean }[] {
		const lines = [];
		for (const region of regions) {
			const open = fenceLineAt(region.from);
			if (open) lines.push({ line: open, region, closing: false });
			if (closed(region)) {
				const close = fenceLineAt(region.inner_to);
				if (close) lines.push({ line: close, region, closing: true });
			}
		}
		return lines;
	}

	interface Result {
		changes: ChangeSet;
		next_doc: Text;
		/** Undefined when it is known that the result has no region (see `result`). */
		next_regions?: CodeRegion[];
	}

	function result(edit: GuardedEdit): Result {
		const changes = ChangeSet.of(edit.changes, doc.length);
		const next_doc = changes.apply(doc);
		if (!regions.length) {
			// EXPL: Without a region, no line is a fence line, so a region can only appear on a changed line.
			let fence = false;
			changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
				const from = next_doc.lineAt(fromB).from, to = next_doc.lineAt(toB).to;
				if (FENCE_RUN.test(next_doc.sliceString(from, to))) fence = true;
			});
			if (!fence) return { changes, next_doc };
		}
		return { changes, next_doc, next_regions: findCodeRegions(next_doc) };
	}

	/** Whether no CriticMarkup opener `res`'s changes write lies inside code, where it would be inert. */
	function markupOutsideCode({ changes, next_doc, next_regions }: Result): boolean {
		if (!next_regions?.length) return true;
		let inert = false;
		changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
			if (openersWritten(next_doc, fromB, toB).some(pos => inCodeRegion(next_regions, pos))) inert = true;
		});
		return !inert;
	}

	/**
	 * Whether `edit` is acceptable: its structure is kept (`exact`: `regionsPreserved`; `blocks`: every block keeps
	 * its fence lines, where a closing line ends may move; `none`: not checked), and, if it writes markup, no opener it
	 * writes is inside code.
	 */
	function acceptable(edit: GuardedEdit, markup: boolean, structure: "exact" | "blocks" | "none" = "exact"): boolean {
		const res = result(edit);
		const next_regions = res.next_regions ?? [];
		if (structure !== "none" && !regionsPreserved(regions, res.changes, next_regions, structure === "exact"))
			return false;
		return !markup || markupOutsideCode(res);
	}

	/**
	 * Whether `tracked` has the same block structure as `plain`, by line: as many blocks, opening and closing on the
	 * same lines (a tracked insertion adds the same lines as the plain one).
	 */
	function sameLinesAs(tracked: Result, plain: Result): boolean {
		const lines = ({ next_doc, next_regions = [] }: Result) =>
			next_doc.lines + ":" +
			next_regions.map(r =>
				next_doc.lineAt(r.from).number + "-" + (r.inner_to < next_doc.length ? next_doc.lineAt(r.inner_to).number : "")
			).join(",");
		return lines(tracked) === lines(plain);
	}

	/**
	 * Option 3: text typed or pasted before the fence of a fence line (at its start, in its indent or `>` prefix) goes
	 * onto a new line above it. Prefix characters the change replaces are deleted plain.
	 */
	function redirect(change: EditorEditChange, tracker: SuggestionTracker): GuardedEdit | undefined {
		const { from, to, inserted } = change;
		const fence = fenceLines().find(({ line }) => line.from <= from && to <= line.marker_from);
		if (!fence) return undefined;
		const { line, closing } = fence;
		const removed = from < to ? [{ from, to, insert: "" }] : [];
		// EXPL: Inserted at the line's start, so the fence line itself moves down (and its boundaries map past the
		//       insertion), carrying its prefix onto the new line.
		const at = line.from;
		if (closing) {
			const insert = line.prefix + inserted + "\n";
			return { changes: [{ from: at, to: at, insert }, ...removed], cursor: at + line.prefix.length + inserted.length };
		}
		const addition = tracker.addition(at, inserted);
		return {
			changes: [
				{ from: at, to: at, insert: line.prefix },
				...addition.changes,
				{ from: at, to: at, insert: "\n" },
				...removed,
			],
			cursor: addition.cursor + line.prefix.length,
		};
	}

	/**
	 * Option 5: a change inside one block, after its opening fence and before its closing fence, that removes the line
	 * break after the opening line or before the closing line (or part of the closing line's prefix).
	 */
	function glue(change: EditorEditChange): GuardedEdit | undefined {
		const { from, inserted } = change;
		const region = regions.find(r => r.head_end <= change.to && from < r.inner_to);
		if (!region) return undefined;
		const open = fenceLineAt(region.from);
		const close = closed(region) ? fenceLineAt(region.inner_to) : undefined;
		if (!open || from < open.marker_to || (close && change.to > close.marker_from)) return undefined;
		// The closing line's prefix stays.
		const to = Math.min(change.to, region.inner_to);
		const lead = from <= region.head_end && to > region.head_end ? "\n" + open.prefix : "";
		const body = lead + inserted;
		const fence_joined = close !== undefined && to === region.inner_to && to > from &&
			!body.endsWith("\n") && !(body === "" && doc.sliceString(from - 1, from) === "\n");
		const insert = body + (fence_joined ? "\n" : "");
		if (!lead && !fence_joined) return undefined;
		return { changes: [{ from, to, insert }], cursor: from + body.length };
	}

	/**
	 * Option 5, before an opening fence: a change from before an opening fence line into its start or prefix (a
	 * selection ending there, Delete at the end of the line above) keeps the line break and the prefix, and is
	 * tracked or applied plain without them.
	 */
	function clamp(change: EditorEditChange, tracker: SuggestionTracker): GuardedEdit | null | undefined {
		const fence = fenceLines().find(({ line, closing }) =>
			!closing && change.from < line.from && line.from <= change.to && change.to <= line.marker_from
		);
		if (!fence) return undefined;
		const to = fence.line.from - 1;
		if (to <= change.from && !change.inserted) return null;
		const clamped = {
			...change,
			to: Math.max(change.from, to),
			deleted: doc.sliceString(change.from, Math.max(change.from, to)),
		};
		const tracked = tracker.track(clamped);
		if (tracked && acceptable(tracked, true)) return tracked;
		const plain = {
			changes: [{ from: clamped.from, to: clamped.to, insert: clamped.inserted }],
			cursor: clamped.from + clamped.inserted.length,
		};
		return acceptable(plain, false) ? plain : undefined;
	}

	/** Option 6, split: the part of a deletion inside a block's content plain, the rest from its closing fence line tracked. */
	function split(change: EditorEditChange, tracker: SuggestionTracker): GuardedEdit | undefined {
		const region = regions.find(r => r.inner_from <= change.from && change.from < r.inner_to && r.inner_to < change.to);
		if (!region || !closed(region)) return undefined;
		// The closing line's prefix stays outside the deletion, so the line still starts with it.
		const close = fenceLineAt(region.inner_to);
		const tail_from = Math.min(change.to, close ? region.inner_to + close.prefix.length : region.inner_to);
		const tail = tracker.track({
			...change,
			from: tail_from,
			deleted: doc.sliceString(tail_from, change.to),
			selection: true,
		});
		if (!tail) return undefined;
		const plain_to = Math.max(change.from, region.inner_to - 1);
		if (plain_to === change.from) return tail;
		return {
			changes: [{ from: change.from, to: plain_to, insert: "" }, ...tail.changes],
			cursor: tail.cursor - (plain_to - change.from),
		};
	}

	/**
	 * Option 6: a change covering fence characters becomes a tracked deletion of whole fences, so each fence stays
	 * readable as a fence inside the deletion (`{--```--}`) and every block keeps its fence lines. A selection is widened
	 * to the whole fence markers it touches; Backspace or Delete inside a fence deletes that fence (with an opening
	 * fence's info string, unless the info string holds CriticMarkup). A deletion starting in a block's content is split
	 * (see `split`). Refused if neither keeps the markup outside code; a selection may still change the structure if its
	 * deletion is otherwise sound (deleting several fences at once).
	 */
	function deleteFences(
		change: EditorEditChange,
		covered: { line: FenceLine; region: CodeRegion; closing: boolean }[],
		tracker: SuggestionTracker,
	): GuardedEdit | null {
		// EXPL: Inside one's own addition the text is a suggestion: editing it (fences included) edits it outright.
		if (tracker.ownText(change.from, change.to)) {
			const own = tracker.track({ ...change });
			if (own && acceptable(own, true, "none")) return own;
		}
		let { from, to } = change;
		const keystroke = !change.selection && to - from <= 1;
		// EXPL: A deletion starting at the end of a closing line (that fence not deleted) starts on the next line: a trailing
		//       opener there would only close the block if no fence line followed before its closer.
		for (const { line, region, closing } of fenceLines()) {
			if (!closing || covered.some(c => c.line.from === line.from)) continue;
			const end = doc.lineAt(line.from).to;
			if (from === end && end < to && region.to <= end) from = end + 1;
		}
		for (const { line, region, closing } of covered) {
			// A fence's indent and quote markers stay outside the deletion, so the line still starts with them.
			const line_start = line.from + line.prefix.length;
			from = line.from <= from && from < line_start ? line_start : Math.min(from, line.marker_from);
			const info = doc.sliceString(line.marker_to, region.head_end);
			to = Math.max(to, keystroke && !closing && !/[{}]/.test(info) ? region.head_end : line.marker_to);
		}
		// EXPL: The line breaks around fence lines the deletion does not delete stay, so no fence joins another line:
		//       one ending at the start (or in the prefix) of a fence line stops before its line break, one starting at
		//       the end of an opening line starts on the next line.
		for (const { line } of fenceLines()) {
			if (covered.some(c => c.line.from === line.from)) continue;
			if (line.from <= to && to <= line.marker_from && from < line.from) to = Math.max(from, line.from - 1);
		}
		//       One starting in an opening line's info string (that fence not deleted) deletes the rest of the info
		//       string plain, as code, and the rest from the next line.
		let info: EditorChange | undefined;
		for (const region of regions) {
			if (covered.some(c => c.region === region && !c.closing) || from >= region.inner_from) continue;
			const open = fenceLineAt(region.from);
			if (!open || from < open.marker_to) continue;
			if (from < region.head_end) info = { from, to: region.head_end, insert: "" };
			from = Math.min(region.inner_from, to);
		}
		const with_info = (edit: GuardedEdit | undefined): GuardedEdit | undefined =>
			edit && info ?
				{ changes: [info, ...edit.changes], cursor: edit.cursor - (info.to - info.from) } :
				edit;
		// EXPL: Text replacing the fences goes into an addition after the deletion: a substitution's `{~~` would run
		//       into a ~~~ fence.
		const deletion = { ...change, from, to, inserted: "", deleted: doc.sliceString(from, to), selection: true };
		//       After an opening fence that text would be its info string, so it may instead go onto its own line above
		//       the first fence (as with option 3).
		const first = covered[0].line;
		const with_text = (edit: GuardedEdit | undefined, above = false): GuardedEdit | undefined => {
			if (!edit || !change.inserted) return edit;
			if (!above) {
				const addition = tracker.addition(to, change.inserted);
				return { changes: [...edit.changes, ...addition.changes], cursor: addition.cursor + editDelta(edit) };
			}
			const addition = tracker.addition(first.from, change.inserted);
			return {
				changes: [
					{ from: first.from, to: first.from, insert: first.prefix },
					...addition.changes,
					{ from: first.from, to: first.from, insert: "\n" },
					...edit.changes,
				],
				cursor: addition.cursor + first.prefix.length,
			};
		};
		if (from >= to) {
			if (!change.inserted) return null;
			const addition = tracker.addition(from, change.inserted);
			return acceptable(addition, true) ? addition : null;
		}
		// A deletion merging with a range beside it can become a substitution, whose `{~~` runs into a ~~~ fence: a
		// deletion of its own is tried too.
		const tracked = tracker.track(deletion), parts = split(deletion, tracker);
		const candidates = [with_text(tracked), with_text(parts), with_text(tracker.deletion(from, to))];
		if (change.inserted) {
			// Before the deletion, when it starts in prose.
			for (const edit of [tracked, parts]) {
				if (!edit) continue;
				const addition = tracker.addition(from, change.inserted);
				candidates.push({ changes: [...addition.changes, ...edit.changes], cursor: addition.cursor });
			}
			if (from >= first.from && !covered[0].closing) candidates.push(with_text(tracked, true), with_text(parts, true));
			// After a closing fence inside the deletion, where the text stays outside code: two deletions around it.
			for (const { line, closing } of covered) {
				if (!closing || line.marker_to <= from || line.marker_to >= to) continue;
				const before = tracker.track({
					...deletion,
					to: line.marker_to,
					deleted: doc.sliceString(from, line.marker_to),
				});
				const after = tracker.track({
					...deletion,
					from: line.marker_to,
					deleted: doc.sliceString(line.marker_to, to),
				});
				if (!before || !after) continue;
				const addition = tracker.addition(line.marker_to, change.inserted);
				candidates.push({
					changes: [...before.changes, ...addition.changes, ...after.changes],
					cursor: addition.cursor + editDelta(before),
				});
			}
		}
		// EXPL: Last, the deletion line by line, keeping its line breaks: each fence is wrapped on its own line, and
		//       parts in a block's content (code) are deleted plain. Text may go right after a deleted closing fence.
		const pieces: { end: number; changes: EditorChange[]; cursor: number }[] = [];
		for (let pos = from; pos < to;) {
			const line = doc.lineAt(pos);
			const fence_line = fenceLineAt(line.from);
			const a = Math.max(from, line.from + (fence_line?.prefix.length ?? 0)), b = Math.min(to, line.to);
			if (a < b) {
				const code = regions.some(r => r.inner_from <= a && b <= r.inner_to);
				const piece = code ?
					{ changes: [{ from: a, to: b, insert: "" }], cursor: a } :
					tracker.track({ ...deletion, from: a, to: b, deleted: doc.sliceString(a, b) });
				if (!piece) {
					pieces.length = 0;
					break;
				}
				pieces.push({ end: b, ...piece });
			}
			pos = line.to + 1;
		}
		const join = (list: typeof pieces): GuardedEdit => {
			const changes = list.flatMap(piece => piece.changes);
			const last = list.at(-1)!;
			return {
				changes,
				cursor: last.cursor + editDelta({ changes: changes.slice(0, -last.changes.length), cursor: 0 }),
			};
		};
		if (pieces.length) {
			candidates.push(with_text(join(pieces)));
			for (const { line, closing } of covered) {
				if (!closing || !change.inserted || line.marker_to >= to) continue;
				const before = pieces.filter(piece => piece.end <= line.marker_to), after = pieces.slice(before.length);
				if (!before.length) continue;
				const head = join(before), addition = tracker.addition(line.marker_to, change.inserted);
				candidates.push({
					changes: [...head.changes, ...addition.changes, ...after.flatMap(piece => piece.changes)],
					cursor: addition.cursor + editDelta(head),
				});
			}
		}
		for (const structure of change.selection ? ["blocks", "none"] as const : ["blocks"] as const) {
			for (const candidate of candidates.map(with_info))
				if (candidate && acceptable(candidate, true, structure)) return candidate;
		}
		// EXPL: Typed text is never dropped: if no deletion keeps the blocks, the text alone goes in, as option 3 would
		//       place it (or at the change's start), and the selection stays.
		if (change.inserted) {
			const typed = [
				redirect({ ...change, to: change.from, deleted: "" }, tracker),
				redirect({ ...change, from: first.from, to: first.from, deleted: "" }, tracker),
				tracker.addition(change.from, change.inserted),
			];
			for (const candidate of typed)
				if (candidate && acceptable(candidate, true, "blocks")) return candidate;
			// In a block's content the text is code, plain.
			const at = change.from;
			const plain_text = {
				changes: [{ from: at, to: at, insert: change.inserted }],
				cursor: at + change.inserted.length,
			};
			if (regions.some(r => r.inner_from <= at && at <= r.inner_to) && acceptable(plain_text, false, "blocks"))
				return plain_text;
		}
		return null;
	}

	/** The first acceptable option for `change`; null to refuse it. */
	function decide(change: EditorEditChange, tracker: SuggestionTracker): GuardedEdit | null {
		const { from, to, inserted } = change;
		const deleted = doc.sliceString(from, to);

		// 1
		const tracked = tracker.track({ ...change });
		if (tracked && acceptable(tracked, true)) return tracked;
		const plain: GuardedEdit = { changes: [{ from, to, insert: inserted }], cursor: from + inserted.length };
		// A closing line may run past the region's end (`{--```--}`, `````{++`): the whole line counts.
		const touches = regions.some(r =>
			doc.lineAt(r.from).from <= to && from <= (closed(r) ? doc.lineAt(r.inner_to).to : r.to)
		);
		// EXPL: In prose, the user's own edit may change the structure (pasting a whole code block): the tracked edit
		//       is kept if it makes the same blocks as the plain edit would.
		if (tracked && !touches && !acceptable(plain, false)) {
			const tracked_result = result(tracked);
			if (markupOutsideCode(tracked_result) && sameLinesAs(tracked_result, result(plain))) return tracked;
		}

		// 2
		const whitespace = /^\s*$/.test(inserted + deleted);
		if ((whitespace || touches) && acceptable(plain, false)) return plain;

		// 3
		if (inserted) {
			// Text typed inside a fence's characters would split the fence: it goes above the fence instead.
			const inside = deleted ?
				undefined :
				fenceLines().find(({ line }) => line.marker_from < from && from < line.marker_to);
			const at = inside ? { ...change, from: inside.line.marker_from, to: inside.line.marker_from } : change;
			const moved = redirect(at, tracker);
			// Text that itself holds a fence line changes the structure wherever it goes; it still goes above the fence.
			if (moved && acceptable(moved, true, FENCE_LINE_IN.test(inserted) || inside ? "none" : "exact")) return moved;
		}

		const covered = fenceLines().filter(({ line }) => from < to && from < line.marker_to && line.marker_from < to);
		const covers_fence = covered.length > 0;

		// 4: a join (a line break, with quote markers or indent) of a fence line with its neighbour.
		if (deleted && !inserted && /^[\s>]*$/.test(deleted) && !covers_fence) return null;

		// 5
		if (!covers_fence) {
			const glued = glue(change);
			if (glued && acceptable(glued, false)) return glued;
			const clamped = clamp(change, tracker);
			if (clamped !== undefined) return clamped;
		}

		// 6
		if (covers_fence) return deleteFences(change, covered, tracker);

		return plain;
	}

	/** The positions of the CriticMarkup openers `edits` (in document order) write, in `next_doc`, after all of them. */
	function writtenOpeners(edits: (GuardedEdit | null)[], next_doc: Text): number[][] {
		let offset = 0;
		return edits.map(edit => {
			const openers: number[] = [];
			for (const change of edit?.changes ?? []) {
				const from = change.from + offset;
				openers.push(...openersWritten(next_doc, from, from + change.insert.length));
				offset += change.insert.length - (change.to - change.from);
			}
			return openers;
		});
	}

	return { decide, writtenOpeners, acceptable };
}

/**
 * The fence guard's edit for each of `changes` (one per cursor, in document order, positions in `doc`), or null where
 * a change is refused. See `createFenceGuard` for the options.
 */
export function guardSuggestions(
	doc: Text,
	regions: CodeRegion[],
	changes: EditorEditChange[],
	tracker: SuggestionTracker,
): (GuardedEdit | null)[] {
	const guard = createFenceGuard(doc, regions);
	// EXPL: A tracked edit may re-emit a whole range around its cursor (typing inside an addition or a substitution's new
	//       text); only its minimal changes are kept, so two cursors in one range do not overlap.
	//       A change re-emitting the text it replaces with markup around it ("```" -> "{--```--}") becomes insertions
	//       around that text, so positions inside it map through unchanged.
	const minimal = (change: EditorChange): EditorChange[] => {
		const old = doc.sliceString(change.from, change.to), insert = change.insert;
		const kept = old ? insert.indexOf(old) : -1;
		if (kept !== -1) {
			return [
				{ from: change.from, to: change.from, insert: insert.slice(0, kept) },
				{ from: change.to, to: change.to, insert: insert.slice(kept + old.length) },
			].filter(c => c.insert);
		}
		const max = Math.min(old.length, insert.length);
		let head = 0, tail = 0;
		while (head < max && old[head] === insert[head]) head++;
		while (tail < max - head && old[old.length - 1 - tail] === insert[insert.length - 1 - tail]) tail++;
		if (head === old.length && head === insert.length) return [];
		return [{ from: change.from + head, to: change.to - tail, insert: insert.slice(head, insert.length - tail) }];
	};
	const trimmed: SuggestionTracker = {
		track: change => {
			const edit = tracker.track(change);
			return edit && { changes: edit.changes.flatMap(minimal), cursor: edit.cursor };
		},
		addition: tracker.addition,
		deletion: tracker.deletion,
		ownText: tracker.ownText,
	};
	const in_order = (edits: (GuardedEdit | null | undefined)[]) => {
		let end = 0;
		return edits.every(edit =>
			(edit?.changes ?? []).every(change => {
				const ok = change.from >= end;
				end = Math.max(end, change.to);
				return ok;
			})
		);
	};
	// EXPL: With several cursors, the tracked edits are first checked together with one scan of the result; only if
	//       that fails is each change decided on its own.
	if (changes.length > 1) {
		const tracked = changes.map(change => trimmed.track({ ...change }));
		if (
			tracked.every(edit => edit) && in_order(tracked) &&
			guard.acceptable({ changes: tracked.flatMap(edit => edit!.changes), cursor: 0 }, true)
		) {
			return tracked as GuardedEdit[];
		}
	}
	const edits = changes.map(change => guard.decide(change, trimmed));
	if (edits.length < 2) return edits;
	// EXPL: The guard's decision with nothing tracked: the same options, with plain candidates only.
	const untracked: SuggestionTracker = {
		track: () => undefined,
		addition: (at, text) => ({ changes: [{ from: at, to: at, insert: text }], cursor: at + text.length }),
		deletion: from => ({ changes: [], cursor: from }),
		ownText: () => false,
	};
	const untracked_edits = new Set<number>();
	const plain = (i: number) => {
		untracked_edits.add(i);
		return guard.decide(changes[i], untracked);
	};
	// EXPL: A tracked edit can rewrite a whole range around its cursor (a substitution is re-emitted), reaching over
	//       another cursor's change in the same range. Edits must stay in document order without overlapping, so a
	//       later edit reaching back over an earlier one is decided again untracked, and refused if that overlaps too.
	const order = () => {
		let end = 0;
		edits.forEach((edit, i) => {
			if (edit && edit.changes.some(change => change.from < end)) {
				edit = plain(i);
				edits[i] = edit = edit && edit.changes.every(change => change.from >= end) ? edit : null;
			}
			for (const change of edit?.changes ?? []) end = Math.max(end, change.to);
		});
	};
	order();
	// EXPL: An edit whose opener another cursor's change puts inside code is decided again untracked. Each pass
	//       makes at least one more edit untracked, and those write no markup, so this ends.
	for (let pass = 0; pass < edits.length; pass++) {
		const all = edits.flatMap(edit => edit?.changes ?? []);
		const next_doc = ChangeSet.of(all, doc.length).apply(doc);
		const next_regions = findCodeRegions(next_doc);
		const openers = guard.writtenOpeners(edits, next_doc);
		let changed = false;
		edits.forEach((edit, i) => {
			if (edit && !untracked_edits.has(i) && openers[i].some(pos => inCodeRegion(next_regions, pos))) {
				edits[i] = plain(i);
				changed = true;
			}
		});
		if (!changed) break;
		order();
	}
	return edits;
}
