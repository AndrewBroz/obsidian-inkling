import { ChangeSet, type Text } from "@codemirror/state";
import DiffMatchPatch from "diff-match-patch";

import type { EditorChange, EditorEditChange } from "../../../base";
import { type CodeRegion, fenceMarker, findCodeRegions, regionsPreserved } from "../../../base/edit-util/code-regions";

export interface GuardedEdit {
	changes: (EditorChange & { start?: number; end?: number })[];
	cursor: number;
}

/** Tracking in the document a change is decided in: `addition` is a range of its own (undefined inside a range). */
export interface SuggestionTracker {
	track(change: EditorEditChange): GuardedEdit | undefined;
	addition(at: number, text: string): GuardedEdit | undefined;
	ownText(from: number, to: number): boolean;
	rangeEnd(pos: number): number | undefined;
	inRange(pos: number): boolean;
	/** Whether pending added text (an addition, or a substitution's new part) lies in [from, to). */
	pending(from: number, to: number): boolean;
}

const FENCE_TEXT = /```|~~~/;
const PREFIX = /^[ \t>]*(?:(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$))?/;
/** A line's container prefix as it continues on a new line (a list marker becomes spaces). */
const continuation = (line: string) => PREFIX.exec(line)![0].replace(/[-+*]|\d{1,9}[.)]/, m => " ".repeat(m.length));

/**
 * One suggest-mode change with no CriticMarkup on a fence line or in code (spec addendum), or null to refuse it:
 * 1. plain on a block's lines if every fence line stays; 2. the tracked edit, if valid (the blocks after it are the
 * old ones plus the inserted text's complete ones); 3. plain whitespace on a fence line; 4. an adjusted tracked form:
 * text typed on a fence line on a line of its own, a deletion covering fence characters widened to whole blocks,
 * markers moved onto prose lines by an equivalent one-character shift or a line break inside the range.
 */
export function guardChange(doc: Text, regions: CodeRegion[], change: EditorEditChange, tracker: SuggestionTracker) {
	const { from, to, inserted } = change;
	const plain: GuardedEdit = { changes: [{ from, to, insert: inserted }], cursor: from + inserted.length };
	const fences = regions.flatMap(region =>
		(region.close_from < region.to ? [region.from, region.close_from] : [region.from]).map(at => {
			const line = doc.lineAt(at), marker = fenceMarker(line.text);
			return {
				region,
				at,
				end: line.to,
				prefix: marker.prefix,
				marker_from: at + marker.from,
				marker_to: at + marker.to,
			};
		})
	);
	const apply = (edit: GuardedEdit) => {
		const changes = ChangeSet.of(edit.changes, doc.length);
		return { changes, next: changes.apply(doc) };
	};
	// EXPL: An edit within lines, after their container prefixes, off fence lines and writing no fence moves no region
	//       (no rescan); with `prose`, it also writes nothing in a block.
	function shifts({ changes, next }: ReturnType<typeof apply>, prose: boolean) {
		// Text after the container prefix that can't start or end a block (or a paragraph a block interrupts).
		const inert = (line: string) => {
			const content = line.slice(PREFIX.exec(line)![0].length);
			return !!content.trim() && !/^[`~<>#=*_+\-\d]/.test(content) && !/[<>]|```|~~~/.test(content);
		};
		let ok = true;
		changes.iterChanges((fromA, toA, fromB, _toB, text) => {
			const line = doc.lineAt(fromA);
			ok &&= !text.toString().includes("\n") && toA <= line.to && inert(line.text) && inert(next.lineAt(fromB).text) &&
				fromA - line.from >= PREFIX.exec(line.text)![0].length && !fences.some(f => f.at <= toA && fromA <= f.end) &&
				!(prose && regions.some(r => r.from <= toA && fromA <= r.to));
		});
		return ok;
	}
	const keeps = (edit: GuardedEdit) => {
		const res = apply(edit);
		return shifts(res, false) || regionsPreserved(regions, res.changes, findCodeRegions(res.next.toString()));
	};
	const blocks = (text: string) => findCodeRegions(text).map(r => text.slice(r.from, r.to));
	const inserted_blocks = FENCE_TEXT.test(inserted) ?
		findCodeRegions(inserted).filter(r => r.close_from < r.to).map(r => inserted.slice(r.from, r.to)) :
		[];
	function valid(edit: GuardedEdit | undefined, a = from, b = to, removes = false): edit is GuardedEdit {
		if (!edit) return false;
		const res = apply(edit);
		if (!inserted_blocks.length && shifts(res, true)) return true;
		const text = (r: CodeRegion) => doc.sliceString(r.from, r.to);
		const expected = [
			...regions.filter(r => r.from < b && !(removes && a <= r.from && r.to <= b)).map(text),
			...inserted_blocks,
			...regions.filter(r => r.from >= b).map(text),
		];
		const found = blocks(res.next.toString());
		return found.length === expected.length && found.every((t, i) => t === expected[i]);
	}

	// 1
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
	const ws = !/\S/.test(inserted + doc.sliceString(from, to));
	if (ws && fences.some(f => f.at <= from && to <= f.end) && keeps(plain)) return plain;

	// 4
	const char = (pos: number) => doc.sliceString(pos, pos + 1);
	const helpers = (h1: string, h2: string) => [["", ""], [h1, ""], ["", h2], [h1, h2]];
	if (from === to) {
		const at_fence = fences.find(f => f.at <= from && from < f.marker_to);
		if (at_fence && at_fence.at === at_fence.region.close_from) {
			const insert = at_fence.prefix + inserted.replaceAll("\n", "\n" + at_fence.prefix) + "\n";
			const above = {
				changes: [{ from: at_fence.at, to: at_fence.at, insert }],
				cursor: at_fence.at + insert.length - 1,
			};
			return keeps(above) ? above : null;
		}
		const after = fences.find(f => f.at === f.region.close_from && f.region.to === from);
		const candidates: [GuardedEdit | undefined, number][] = [];
		const around = (edit: GuardedEdit | undefined, at: number, before: string, after: string) =>
			edit && {
				changes: [{ from: at, to: at, insert: before }, ...edit.changes, { from: at, to: at, insert: after }],
				cursor: edit.cursor + before.length,
			};
		if (at_fence && at_fence.at > 0)
			candidates.push([tracker.addition(at_fence.at - 1, "\n" + at_fence.prefix + inserted), at_fence.at]);
		if (after && from < doc.length) {
			// Indented as the block's container (a list item) where the line below is less so.
			const below = doc.lineAt(from + 1), prefix = /^[ \t>]*/.exec(below.text)![0], own = continuation(after.prefix);
			const indent = own.length > prefix.length && own.startsWith(prefix) ? own.slice(prefix.length) : "";
			const edit = tracker.addition(below.from + prefix.length, indent + inserted + "\n" + prefix);
			candidates.push([edit && { ...edit, cursor: edit.cursor - 1 - prefix.length }, from]);
		}
		const h = "\n" + continuation(doc.lineAt(from).text);
		for (const [i, [before, after_text]] of helpers(h, h).entries()) {
			const add = (at: number, text: string) => tracker.addition(at, before + text + after_text);
			candidates.push([add(from, inserted), from]);
			if (char(from - 1) === inserted.at(-1))
				candidates.push([add(from - 1, char(from - 1) + inserted.slice(0, -1)), from]);
			if (char(from) === inserted[0]) candidates.push([add(from + 1, inserted.slice(1) + char(from)), from]);
			if (i > 0) continue;
			const own_prefix = at_fence && continuation(at_fence.prefix);
			if (at_fence) candidates.push([around(add(at_fence.at, inserted), at_fence.at, own_prefix!, "\n"), at_fence.at]);
			if (after) candidates.push([around(add(from, inserted), from, "\n" + after.prefix, ""), from]);
			const end = tracker.rangeEnd(from);
			if (end !== undefined) candidates.push([tracker.addition(end, inserted), from]);
			if (at_fence) {
				const own = tracker.track({
					...change,
					from: at_fence.at,
					to: at_fence.at,
					inserted: at_fence.prefix + inserted + "\n",
				});
				candidates.push([own && { ...own, cursor: own.cursor - 1 }, at_fence.at]);
			}
		}
		return candidates.find(([edit, at]) => valid(edit, at, at))?.[0] ?? null;
	}

	// A deletion covering fence characters is widened to whole blocks.
	if (!fences.some(f => from < f.marker_to && f.marker_from < to)) return null;
	let a = from, b = to;
	for (const r of regions) {
		if (r.from < b && a < r.to) {
			a = Math.min(a, r.from);
			b = Math.max(b, r.to);
		}
	}
	// Widening would remove pending text (it isn't tracked) the user didn't select: refused.
	if (tracker.pending(a, from) || tracker.pending(to, b)) return null;
	const deletion = (s: number, e: number, inserted = "") =>
		tracker.track({ ...change, from: s, to: e, inserted, deleted: doc.sliceString(s, e), selection: true });
	const widened = deletion(a, b, inserted);
	if (valid(widened, a, b, tracker.ownText(a, b))) return widened;
	const inside = fences.filter(f => a <= f.at && f.at <= b);
	const prefix = inside[0].prefix;
	const wrap = (edit: GuardedEdit | undefined, before: string, after: string): GuardedEdit | undefined => {
		const c = edit?.changes[0];
		if (!c || (!before && !after)) return edit;
		if (edit!.changes.length !== 1 || c.start === undefined || c.end === undefined) return undefined;
		const start = c.start - c.from, end = c.end - c.from;
		const insert = c.insert.slice(0, start) + before + c.insert.slice(start, end) + after + c.insert.slice(end);
		return {
			changes: [{ from: c.from, to: c.to, insert }],
			cursor: edit!.cursor + (edit!.cursor > c.start ? before.length : 0),
		};
	};
	// Whole lines, without the final line break, or after the first fence line's prefix; each shifted by a character.
	const ends = regions.some(r => r.to === b) && char(b) === "\n" ?
		[b + 1, b] :
		regions.some(r => r.to === b - 1) && char(b - 1) === "\n" ?
		[b, b - 1] :
		[b];
	const windows: [number, number][] = [];
	for (const s of inside[0].at === a && prefix ? [a, a + prefix.length] : [a]) {
		for (const e of s === a ? ends : [b]) {
			windows.push([s, e]);
			const plain = (k: number) => !tracker.inRange(k);
			if (s > 0 && char(s - 1) === char(e - 1) && plain(s - 1) && plain(e - 1)) windows.push([s - 1, e - 1]);
			if (e < doc.length && char(s) === char(e) && plain(s) && plain(e)) windows.push([s + 1, e + 1]);
		}
	}
	const h1 = "\n" + continuation(prefix), h2 = "\n" + continuation(inside.at(-1)!.prefix);
	for (const [s, e] of windows) {
		// A line break inside the deletion only where its marker would start or end a fence line.
		const at_start = s === inside[0].at || s === inside[0].at + prefix.length, at_end = fences.some(f => f.end === e);
		for (const [before, after] of helpers(h1, h2)) {
			if ((before && !at_start) || (after && !at_end)) continue;
			const del = wrap(deletion(s, e), before, after);
			if (!del) continue;
			if (!inserted && valid(del, s, e)) return del;
			// Typed text goes on a line of its own, so Accept doesn't join it to the line before (whose line break the
			// deletion takes) or the one after (whose text it would precede), with that line's container prefix.
			const next = doc.lineAt(e), lead = /^[ \t>]*/.exec(next.text)![0];
			const glued = e === next.from && !!next.text.trim() && !inserted.endsWith("\n");
			const joined = s > 0 && char(s) === "\n" && !inserted.startsWith("\n");
			const [at, pre, post] = joined ?
				[e, "\n" + continuation(doc.lineAt(s).text), glued ? "\n" : ""] :
				glued ?
				[e + lead.length, "", "\n" + lead] :
				[e, "", ""];
			const added = inserted && del.changes.every(c => c.to <= e) ?
				tracker.addition(at, pre + inserted + post) :
				undefined;
			const add = added && { ...added, cursor: added.cursor - post.length };
			const delta = del.changes.reduce((n, c) => n + c.insert.length - (c.to - c.from), 0);
			const edit = add && { changes: [...del.changes, ...add.changes], cursor: add.cursor + delta };
			if (valid(edit, s, e)) return edit;
		}
	}
	return null;
}

const dmp = new DiffMatchPatch();

/** `changes` cut down to what changed (a character diff), so the other cursors keep their places in a re-emitted range. */
export function minimalChanges(doc: Text, changes: EditorChange[]): EditorChange[] {
	return changes.flatMap(change => {
		const out: EditorChange[] = [];
		let pos = change.from;
		for (const [op, text] of dmp.diff_main(doc.sliceString(change.from, change.to), change.insert)) {
			const last = out.at(-1), joined = last && last.to === pos;
			if (op === 0) pos += text.length;
			else if (op < 0) {
				if (joined) last.to += text.length;
				else out.push({ from: pos, to: pos + text.length, insert: "" });
				pos += text.length;
			} else if (joined) last.insert += text;
			else out.push({ from: pos, to: pos, insert: text });
		}
		return out;
	});
}
