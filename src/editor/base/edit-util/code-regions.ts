import type { ChangeDesc } from "@codemirror/state";

export interface CodeRegion {
	/** Start of the opening fence line. */
	from: number;
	/**
	 * End of the closing fence line (excluding newline), or of the CriticMarkup closer that ends it
	 * ("```++} more" ends after "++}"), or the start of a CriticMarkup opener after it ("```{++" ends
	 * before "{++"), or before one in front of it ("{--```--}" ends before "{--"), or text.length if unclosed.
	 */
	to: number;
	/** End of the opening fence line (excluding newline). */
	head_end: number;
	/** Start of the line after the opening fence line, or `to` if there is none. */
	inner_from: number;
	/** Start of the closing fence line, or text.length if unclosed. */
	inner_to: number;
}

// Optional "{++" style CriticMarkup opener may precede the fence, so a fence
// wrapped by a range ("{++```") is still recognised as a code block. Each `>` quote marker may be
// followed by its optional space and up to 3 spaces of indent (CommonMark).
const OPEN_FENCE = /^( {0,3}(?:> {0,4})*)(\{(?:\+\+|--|==|~~))?(`{3,}|~{3,})(.*)$/;
// A closing fence may carry the closer of a range wrapping the block; text may follow that closer
// ("```++} {--d--}"), and is outside the region. It may instead carry the opener of a range that
// starts after it ("```{++" from pressing Enter at the fence's end in suggest mode); the opener and
// everything after it are outside the region. Like an opening fence, it may also be preceded by the opener
// of a range wrapping it ("{--```--}" from deleting the fence in suggest mode); the region then ends before
// that opener, so the range stays outside the code. Either opener only counts if its closer follows (see
// `closerFollows`), so a code line like "```{==" or "{==```" does not close.
// Groups: 1 indent/quote prefix, 2 opener before the fence, 3 fence, 4 text after a closer, 5 trailing opener
// and the rest of the line, 6 that opener's kind.
const CLOSE_FENCE =
	/^( {0,3}(?:> {0,4})*)(\{(?:\+\+|--|==|~~))?(`{3,}|~{3,})(?:(?:\+\+\}|--\}|==\}|~~\})(.*)|(\{(\+\+|--|~~|==|>>).*)|\s*)$/;

const CLOSER_OF: Record<string, string> = { "++": "++}", "--": "--}", "~~": "~~}", "==": "==}", ">>": "<<}" };

/**
 * The fence of a fence-shaped line (opening or closing): the indent and quote markers before it (and before a range
 * opener in front of it), and the offsets of its fence characters in the line.
 */
export function fenceMarker(line: string): { prefix: string; from: number; to: number } | undefined {
	const m = OPEN_FENCE.exec(line);
	if (!m) return undefined;
	const from = m[1].length + (m[2]?.length ?? 0);
	return { prefix: m[1], from, to: from + m[3].length };
}

/** Whether `line` is a fence line that opens a block (a backtick fence's info string may not hold a backtick). */
function openFence(line: string): RegExpExecArray | null {
	const m = OPEN_FENCE.exec(line);
	return m && !(m[3][0] === "`" && m[4].includes("`")) ? m : null;
}

/**
 * Whether `closer` follows `from` (inside a line; that line's rest is searched too) such that the opener just
 * before `from`, on a line that would close a block fenced with `length` times `char`, is a real range opener.
 * EXPL: The search stops (false) at a line that could itself close that block: the opener is then a code line's
 *       text and that later line is the block's real closer. A fence line that cannot close it (an info string, a
 *       different fence character) opens a nested block, typed inside the range: a closer inside a complete nested
 *       block is that block's code and is skipped, one on its fence lines counts. A nested block that is never
 *       closed runs to the end of the text, so a closer anywhere in it counts: the range's closer is typed in it
 *       (Enter after "```js" puts the range's own closer on its first code line).
 */
function closerFollows(text: string, from: number, closer: string, char: string, length: number): boolean {
	let nested: { char: string; length: number } | null = null;
	let closer_in_nested = false;
	for (let pos = from, first = true; pos < text.length; first = false) {
		let end = text.indexOf("\n", pos);
		if (end === -1) end = text.length;
		const line = text.slice(pos, end).replace(/\r$/, "");
		pos = end + 1;
		if (first) {
			if (line.includes(closer)) return true;
		} else if (nested) {
			const m = CLOSE_FENCE.exec(line);
			if (m && !m[2] && m[3][0] === nested.char && m[3].length >= nested.length) {
				if (line.includes(closer)) return true;
				nested = null;
				closer_in_nested = false;
			} else if (line.includes(closer)) { closer_in_nested = true; }
		} else {
			if (line.includes(closer)) return true;
			const close = CLOSE_FENCE.exec(line);
			if (close && close[3][0] === char && close[3].length >= length) return false;
			const open = openFence(line);
			if (open) nested = { char: open[3][0], length: open[3].length };
		}
	}
	return nested !== null && closer_in_nested;
}

/** Finds fenced code blocks (``` / ~~~, including inside `>` quotes). Sorted, non-overlapping. */
export function findCodeRegions(text: string): CodeRegion[] {
	const regions: CodeRegion[] = [];
	let open: { from: number; head_end: number; inner_from: number; char: string; length: number } | null = null;
	let pos = 0;

	while (pos < text.length) {
		let end = text.indexOf("\n", pos);
		if (end === -1) end = text.length;
		const line = text.slice(pos, end).replace(/\r$/, "");

		if (open) {
			const m = CLOSE_FENCE.exec(line);
			const { char, length } = open;
			if (
				m && m[3][0] === char && m[3].length >= length &&
				(!m[2] || closerFollows(text, pos + m[1].length + 3, CLOSER_OF[m[2].slice(1)], char, length)) &&
				(!m[5] || closerFollows(text, pos + line.length - m[5].length + 3, CLOSER_OF[m[6]], char, length))
			) {
				const outside = m[4]?.length ?? m[5]?.length ?? 0;
				regions.push({
					from: open.from,
					to: m[2] ? pos + m[1].length : pos + line.length - outside,
					head_end: open.head_end,
					inner_from: open.inner_from,
					inner_to: pos,
				});
				open = null;
			}
		} else {
			const m = openFence(line);
			if (m) {
				// A range prefix stays outside the region so the range remains valid.
				open = {
					from: m[2] ? pos + m[1].length + m[2].length : pos,
					head_end: pos + line.length,
					inner_from: Math.min(end + 1, text.length),
					char: m[3][0],
					length: m[3].length,
				};
			}
		}

		pos = end + 1;
	}

	if (open) {
		regions.push({
			from: open.from,
			to: text.length,
			head_end: open.head_end,
			inner_from: open.inner_from,
			inner_to: text.length,
		});
	}
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

/**
 * Whether `next` (the regions after `changes`) has the same fenced-code structure as `old` (the regions before):
 * as many regions, and each boundary of each one where `changes` maps it.
 * EXPL: A boundary at an insertion point may land anywhere from before to after the inserted text (between
 *       `mapPos` with either association): "X\n" typed at a region's start pushes the fence down, "js" typed at the
 *       opening line's end extends it, "a\n" typed there ends the opening line inside the inserted text. A boundary
 *       at the old end of the text may also move to the new end (text appended to an unclosed region). `inner_from`
 *       is not compared: it is the start of the line after `head_end`, so it follows from `head_end` and the text,
 *       and Enter at the opening line's end moves it to the new empty line, away from where `changes` maps it.
 *       Every other boundary moving means the edit changed the structure: a fence line added, removed, joined
 *       with another line or broken, or a different closer ending a region. Whether each region is closed is
 *       compared too (a closed region's closing line starts before the end of the text): deleting the closing fence
 *       of a block at the end of the text leaves every boundary where it maps.
 */
export function regionsPreserved(old: CodeRegion[], changes: ChangeDesc, next: CodeRegion[]): boolean {
	const maps = (before: number, after: number) =>
		(changes.mapPos(before, -1) <= after && after <= changes.mapPos(before, 1)) ||
		(before === changes.length && after === changes.newLength);
	return old.length === next.length &&
		old.every((r, i) =>
			(r.inner_to < changes.length) === (next[i].inner_to < changes.newLength) &&
			maps(r.from, next[i].from) && maps(r.to, next[i].to) && maps(r.head_end, next[i].head_end) &&
			maps(r.inner_to, next[i].inner_to)
		);
}
