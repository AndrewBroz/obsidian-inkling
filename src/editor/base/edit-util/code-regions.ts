import type { ChangeDesc } from "@codemirror/state";

/** A fenced code block, exactly as CommonMark reads it. */
export interface CodeRegion {
	/** Start of the opening fence line. */
	from: number;
	/** End of the closing fence line (excluding its line break), or the end of the text if the block is unclosed. */
	to: number;
	/** End of the opening fence line. */
	open_to: number;
	/** Start of the closing fence line, or `to` if the block is unclosed. */
	close_from: number;
}

// Up to 3 spaces of indent, inside any number of `>` quote markers (each with its optional space and indent).
const FENCE = /^( {0,3}(?:> {0,4})*)(`{3,}|~{3,})(.*)$/;

/** The fence of a fence-shaped line: its indent and quote markers, and the offsets of its fence characters. */
export function fenceMarker(line: string): { prefix: string; from: number; to: number } | undefined {
	const m = FENCE.exec(line);
	return m ? { prefix: m[1], from: m[1].length, to: m[1].length + m[2].length } : undefined;
}

/** Each line of `text` that may be a fence line (its first character after spaces and `>` is ` or ~), and its start. */
function* candidates(text: string): Generator<[number, string]> {
	for (let pos = 0; pos < text.length;) {
		let end = text.indexOf("\n", pos);
		if (end === -1) end = text.length;
		const line = text.slice(pos, text.charCodeAt(end - 1) === 13 ? end - 1 : end);
		if (/^[ >]*[`~]/.test(line)) yield [pos, line];
		pos = end + 1;
	}
}

/**
 * The fenced code blocks of `text`, sorted: ``` or ~~~ fences (a backtick fence's info string holds no backtick),
 * closed by a fence of the same character, at least as long, with nothing but spaces after it; an unclosed block runs
 * to the end of the text. A line carrying anything else (CriticMarkup included) is not a fence line.
 */
export function findCodeRegions(text: string): CodeRegion[] {
	const regions: CodeRegion[] = [];
	let open: { from: number; open_to: number; fence: string } | null = null;
	for (const [pos, line] of candidates(text)) {
		const m = FENCE.exec(line);
		if (!m) continue;
		const [, , fence, rest] = m;
		if (!open) {
			if (fence[0] !== "`" || !rest.includes("`")) open = { from: pos, open_to: pos + line.length, fence };
		} else if (fence[0] === open.fence[0] && fence.length >= open.fence.length && !rest.trim()) {
			regions.push({ from: open.from, to: pos + line.length, open_to: open.open_to, close_from: pos });
			open = null;
		}
	}
	if (open) regions.push({ from: open.from, to: text.length, open_to: open.open_to, close_from: text.length });
	return regions;
}

/** Returns the region containing `pos` (from <= pos < to), if any. */
export function inCodeRegion(regions: CodeRegion[], pos: number): CodeRegion | undefined {
	let lo = 0;
	let hi = regions.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const r = regions[mid];
		if (pos < r.from) hi = mid - 1;
		else if (pos >= r.to) lo = mid + 1;
		else return r;
	}
	return undefined;
}

/** `text` with every character inside a code region (line breaks excepted) replaced by a space. */
export function maskCode(text: string, regions: CodeRegion[]): string {
	let out = "", pos = 0;
	for (const r of regions) {
		out += text.slice(pos, r.from) + text.slice(r.from, r.to).replace(/[^\n]/g, " ");
		pos = r.to;
	}
	return out + text.slice(pos);
}

/**
 * Whether `next` (the regions after `changes`) has the same block structure as `old`: as many regions, each closed or
 * not as before, and each fence-line boundary where `changes` maps it. A boundary at an insertion point may land on
 * either side of the inserted text; one at the end of the text may follow it (text appended to an unclosed block).
 */
export function regionsPreserved(old: CodeRegion[], changes: ChangeDesc, next: CodeRegion[]): boolean {
	const maps = (before: number, after: number) =>
		(changes.mapPos(before, -1) <= after && after <= changes.mapPos(before, 1)) ||
		(before === changes.length && after === changes.newLength);
	return old.length === next.length && old.every((r, i) => {
		const n = next[i];
		return (r.close_from < r.to) === (n.close_from < n.to) && maps(r.from, n.from) && maps(r.to, n.to) &&
			maps(r.open_to, n.open_to) && maps(r.close_from, n.close_from);
	});
}
