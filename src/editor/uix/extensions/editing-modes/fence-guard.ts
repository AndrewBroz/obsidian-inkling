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
}

const OPENER = /\{(?:\+\+|--|~~|==|>>)/g;
const FENCE_RUN = /```|~~~/;

interface FenceLine {
	/** Start of the line. */
	from: number;
	/** The indent and quote markers before the fence (and before a range opener in front of it). */
	prefix: string;
	/** The fence characters. */
	marker_from: number;
	marker_to: number;
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
 *       4. a whitespace deletion that joins a fence line with a non-empty neighbour: refused;
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

	/**
	 * Whether `edit` is acceptable: structure-preserving (unless `structure` is false), and, if it writes markup, with
	 * no CriticMarkup opener it writes inside code, where it would be inert.
	 */
	function acceptable(edit: GuardedEdit, markup: boolean, structure = true): boolean {
		const changes = ChangeSet.of(edit.changes, doc.length);
		const next_doc = changes.apply(doc);
		if (!regions.length) {
			// EXPL: Without a region, no line is a fence line, so a region can only appear on a changed line.
			let fence = false;
			changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
				const from = next_doc.lineAt(fromB).from, to = next_doc.lineAt(toB).to;
				if (FENCE_RUN.test(next_doc.sliceString(from, to))) fence = true;
			});
			if (!fence) return true;
		}
		const next_regions = findCodeRegions(next_doc.toString());
		if (structure && !regionsPreserved(regions, changes, next_regions)) return false;
		if (!markup) return true;
		let inert = false;
		changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
			for (const m of inserted.toString().matchAll(OPENER))
				if (inCodeRegion(next_regions, fromB + m.index)) inert = true;
		});
		return !inert;
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
		const tail = tracker.track({
			...change,
			from: region.inner_to,
			deleted: doc.sliceString(region.inner_to, change.to),
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

	/** The first acceptable option for `change`; null to refuse it. */
	function decide(change: EditorEditChange, tracker: SuggestionTracker): GuardedEdit | null {
		const { from, to, inserted } = change;
		const deleted = doc.sliceString(from, to);

		// 1
		const tracked = tracker.track({ ...change });
		if (tracked && acceptable(tracked, true)) return tracked;

		// 2
		const plain: GuardedEdit = { changes: [{ from, to, insert: inserted }], cursor: from + inserted.length };
		const whitespace = /^\s*$/.test(inserted + deleted);
		const touches = regions.some(r => doc.lineAt(r.from).from <= to && from <= r.to);
		if ((whitespace || touches) && acceptable(plain, false)) return plain;

		// 3
		if (inserted) {
			const moved = redirect(change, tracker);
			if (moved && acceptable(moved, true)) return moved;
		}

		const covers_fence = fenceLines().some(({ line }) => from < line.marker_to && line.marker_from < to);

		// 4
		if (deleted && !inserted && whitespace && !covers_fence) return null;

		// 5
		if (!covers_fence) {
			const glued = glue(change);
			if (glued && acceptable(glued, false)) return glued;
			const clamped = clamp(change, tracker);
			if (clamped !== undefined) return clamped;
		}

		// 6
		if (covers_fence) {
			if (tracked && acceptable(tracked, true, false)) return tracked;
			const parts = split(change, tracker);
			if (parts && acceptable(parts, true, false)) return parts;
		}

		return plain;
	}

	/** The positions of the CriticMarkup openers `edits` (in document order) write, in the document after all of them. */
	function writtenOpeners(edits: (GuardedEdit | null)[]): number[][] {
		let offset = 0;
		return edits.map(edit => {
			const openers: number[] = [];
			for (const change of edit?.changes ?? []) {
				for (const m of change.insert.matchAll(OPENER)) openers.push(change.from + offset + m.index);
				offset += change.insert.length - (change.to - change.from);
			}
			return openers;
		});
	}

	return { decide, writtenOpeners };
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
	const edits = changes.map(change => guard.decide(change, tracker));
	if (edits.length < 2) return edits;
	// EXPL: The guard's decision with nothing tracked: the same options, with plain candidates only.
	const untracked: SuggestionTracker = {
		track: () => undefined,
		addition: (at, text) => ({ changes: [{ from: at, to: at, insert: text }], cursor: at + text.length }),
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
		const next_regions = findCodeRegions(ChangeSet.of(all, doc.length).apply(doc).toString());
		const openers = guard.writtenOpeners(edits);
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
