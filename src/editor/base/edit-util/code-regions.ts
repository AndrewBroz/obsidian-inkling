import type { ChangeDesc, Text } from "@codemirror/state";

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

/** The text's lines, read on demand. */
interface Lines {
	count: number;
	/** Line `i`'s text, without its line break (or a carriage return before it). */
	line(i: number): string;
}

/**
 * Whether `closer` follows column `col` of line `i` (that line's rest is searched too) such that the opener just
 * before it, on a line that would close a block fenced with `length` times `char`, is a real range opener.
 * EXPL: The search stops (false) at a line that could itself close that block: the opener is then a code line's
 *       text and that later line is the block's real closer. A fence line that cannot close it (an info string, a
 *       different fence character) opens a nested block, typed inside the range: a closer inside a complete nested
 *       block is that block's code and is skipped, one on its fence lines counts. A nested block that is never
 *       closed runs to the end of the text, so a closer anywhere in it counts: the range's closer is typed in it
 *       (Enter after "```js" puts the range's own closer on its first code line).
 */
function closerFollows(lines: Lines, i: number, col: number, closer: string, char: string, length: number): boolean {
	if (lines.line(i).slice(col).includes(closer)) return true;
	let nested: { char: string; length: number } | null = null;
	let closer_in_nested = false;
	for (let j = i + 1; j < lines.count; j++) {
		const line = lines.line(j);
		const has_closer = line.includes(closer);
		const fence = maybeFence(line, 0, line.length);
		if (nested) {
			const m = fence && CLOSE_FENCE.exec(line);
			if (m && !m[2] && m[3][0] === nested.char && m[3].length >= nested.length) {
				if (has_closer) return true;
				nested = null;
				closer_in_nested = false;
			} else if (has_closer) {
				closer_in_nested = true;
			}
		} else {
			if (has_closer) return true;
			if (!fence) continue;
			const close = CLOSE_FENCE.exec(line);
			if (close && close[3][0] === char && close[3].length >= length) return false;
			const open = openFence(line);
			if (open) nested = { char: open[3][0], length: open[3].length };
		}
	}
	return nested !== null && closer_in_nested;
}

/**
 * Whether `text[from, to)` may be a fence line: after spaces and `>` quote markers, it starts with a fence character
 * or a range opener. Saves the fence patterns on the many lines that cannot match.
 */
function maybeFence(text: string, from: number, to: number): boolean {
	for (let k = from; k < to; k++) {
		const c = text.charCodeAt(k);
		if (c === 32 || c === 62) continue; // space, >
		return c === 96 || c === 126 || c === 123; // `, ~, {
	}
	return false;
}

/**
 * Finds fenced code blocks (``` / ~~~, including inside `>` quotes). Sorted, non-overlapping.
 * EXPL: A bare fence line closes a block as CommonMark says. A closing fence carrying CriticMarkup ("{--```--}",
 *       "```++}", "```{++") is Inkling's reading, not CommonMark's: it closes the block only if that leaves no fence
 *       unclosed, or if reading it as code content would leave one unclosed too. Otherwise it is code: a block that
 *       merely shows CriticMarkup ("```markdown\n{--```--}\n```") stays one block. Whether the rest of the text,
 *       from a fence line on, ends with every block closed is computed backwards for each open fence kind first.
 *       Only lines that may be fence lines are looked at; `text` may be a CodeMirror document, read line by line.
 */
export function findCodeRegions(text: string | Text): CodeRegion[] {
	/** The lines that may be fence lines: line number, start, text, and whether a carriage return ends it. */
	const cand: { no: number; pos: number; line: string; cr: boolean }[] = [];
	let lines: Lines;
	const length = text.length;
	if (typeof text === "string") {
		const starts: number[] = [];
		for (let pos = 0, no = 0; pos < length; no++) {
			let end = text.indexOf("\n", pos);
			if (end === -1) end = length;
			starts.push(pos);
			const cr = text.charCodeAt(end - 1) === 13 && end > pos;
			if (maybeFence(text, pos, end)) cand.push({ no, pos, line: text.slice(pos, cr ? end - 1 : end), cr });
			pos = end + 1;
		}
		lines = {
			count: starts.length,
			line: i => {
				const end = i + 1 < starts.length ? starts[i + 1] - 1 : length;
				return text.slice(starts[i], text.charCodeAt(end - 1) === 13 && end > starts[i] ? end - 1 : end);
			},
		};
	} else {
		let pos = 0, no = 0;
		for (const iter = text.iterLines(); length && !iter.next().done; no++) {
			const line = iter.value;
			if (maybeFence(line, 0, line.length)) cand.push({ no, pos, line, cr: false });
			pos += line.length + 1;
		}
		lines = { count: length ? text.lines : 0, line: i => text.line(i + 1).text };
	}
	const n = cand.length;
	const opens = cand.map(c => openFence(c.line));
	const closes = cand.map(c => CLOSE_FENCE.exec(c.line));
	const bare = (m: RegExpExecArray) => m[2] === undefined && m[4] === undefined && m[5] === undefined;

	/** 0: candidate `i` does not close a block fenced with `length` x `char`; 1: it does (bare); 2: it may (markup). */
	function closes_block(i: number, char: string, length: number): 0 | 1 | 2 {
		const m = closes[i];
		if (!m || m[3][0] !== char || m[3].length < length) return 0;
		if (bare(m)) return 1;
		const { no, line } = cand[i];
		if (m[2] && !closerFollows(lines, no, m[1].length + 3, CLOSER_OF[m[2].slice(1)], char, length)) return 0;
		if (m[5] && !closerFollows(lines, no, line.length - m[5].length + 3, CLOSER_OF[m[6]], char, length)) return 0;
		return 2;
	}

	// closed[k][i]: from candidate i on, with a block of fence kind k open (0: none), every block ends closed.
	let closed: Uint8Array[] | undefined;
	const kinds = new Map<string, number>();
	const kind_of: [string, number][] = [["", 0]];
	if (closes.some(m => m && !bare(m))) {
		for (const m of opens) {
			const key = m && m[3][0] + m[3].length;
			if (key && !kinds.has(key)) {
				kinds.set(key, kind_of.length);
				kind_of.push([m[3][0], m[3].length]);
			}
		}
		closed = kind_of.map(() => new Uint8Array(n + 1));
		closed[0][n] = 1;
		for (let i = n - 1; i >= 0; i--) {
			const m = opens[i];
			closed[0][i] = m ? closed[kinds.get(m[3][0] + m[3].length)!][i + 1] : closed[0][i + 1];
			for (let k = 1; k < kind_of.length; k++) {
				const how = closes[i] ? closes_block(i, ...kind_of[k]) : 0;
				const as_close = closed[0][i + 1], as_content = closed[k][i + 1];
				closed[k][i] = how === 1 || (how === 2 && (as_close || !as_content)) ? as_close : as_content;
			}
		}
	}

	const regions: CodeRegion[] = [];
	let open: { from: number; head_end: number; inner_from: number; char: string; length: number } | null = null;
	for (let i = 0; i < n; i++) {
		const { pos, line, cr } = cand[i];
		if (open) {
			const { char, length: fence_length } = open;
			const how = closes_block(i, char, fence_length);
			const k = closed && kinds.get(char + fence_length)!;
			if (how === 1 || (how === 2 && (!closed || closed[0][i + 1] || !closed[k!][i + 1]))) {
				const m = closes[i]!;
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
			const m = opens[i];
			if (m) {
				// A range prefix stays outside the region so the range remains valid.
				open = {
					from: m[2] ? pos + m[1].length + m[2].length : pos,
					head_end: pos + line.length,
					inner_from: Math.min(pos + line.length + (cr ? 2 : 1), length),
					char: m[3][0],
					length: m[3].length,
				};
			}
		}
	}

	if (open) {
		regions.push({
			from: open.from,
			to: length,
			head_end: open.head_end,
			inner_from: open.inner_from,
			inner_to: length,
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
 *       With `exact_end` false, each block only keeps its fence lines: `to` is not compared and `from` may move
 *       within the opening line (a tracked deletion wrapping a fence, `{--```--}`, starts an opening line's block
 *       after the opener and ends a closing line's block before it).
 */
export function regionsPreserved(
	old: CodeRegion[],
	changes: ChangeDesc,
	next: CodeRegion[],
	exact_end = true,
): boolean {
	const maps = (before: number, after: number) =>
		(changes.mapPos(before, -1) <= after && after <= changes.mapPos(before, 1)) ||
		(before === changes.length && after === changes.newLength);
	return old.length === next.length &&
		old.every((r, i) =>
			(r.inner_to < changes.length) === (next[i].inner_to < changes.newLength) &&
			(exact_end ?
				maps(r.from, next[i].from) && maps(r.to, next[i].to) :
				changes.mapPos(r.from, -1) <= next[i].from && next[i].from <= changes.mapPos(r.head_end, 1)) &&
			maps(r.head_end, next[i].head_end) &&
			maps(r.inner_to, next[i].inner_to)
		);
}
