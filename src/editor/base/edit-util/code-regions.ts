export interface CodeRegion {
	/** Start of the opening fence line. */
	from: number;
	/**
	 * End of the closing fence line (excluding newline), or of the CriticMarkup closer that ends it
	 * ("```++} more" ends after "++}"), or the start of a CriticMarkup opener after it ("```{++" ends
	 * before "{++"), or text.length if unclosed.
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
// everything after it are outside the region. Such an opener only counts if its closer follows
// before the next fence line (see `closerFollows`), so a code line like "```{==" does not close.
const CLOSE_FENCE = /^ {0,3}(?:> {0,4})*(`{3,}|~{3,})(?:(?:\+\+\}|--\}|==\}|~~\})(.*)|(\{(\+\+|--|~~|==|>>).*)|\s*)$/;

const CLOSER_OF: Record<string, string> = { "++": "++}", "--": "--}", "~~": "~~}", "==": "==}", ">>": "<<}" };

/**
 * Whether `closer` occurs in `text` from `from` on, before the next line that is itself a fence line.
 * `from` lies inside a line; that line's rest is searched too.
 */
function closerFollows(text: string, from: number, closer: string): boolean {
	let pos = from;
	while (pos < text.length) {
		let end = text.indexOf("\n", pos);
		if (end === -1) end = text.length;
		const line = text.slice(pos, end);
		if (pos !== from && OPEN_FENCE.test(line.replace(/\r$/, ""))) return false;
		if (line.includes(closer)) return true;
		pos = end + 1;
	}
	return false;
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
			if (
				m && m[1][0] === open.char && m[1].length >= open.length &&
				(!m[3] || closerFollows(text, pos + line.length - m[3].length + 3, CLOSER_OF[m[4]]))
			) {
				const outside = m[2]?.length ?? m[3]?.length ?? 0;
				regions.push({
					from: open.from,
					to: pos + line.length - outside,
					head_end: open.head_end,
					inner_from: open.inner_from,
					inner_to: pos,
				});
				open = null;
			}
		} else {
			const m = OPEN_FENCE.exec(line);
			if (m && !(m[3][0] === "`" && m[4].includes("`"))) {
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
 * Whether [from, to] lies wholly within some region's content, between its fence lines (an insertion
 * has from === to). Fence lines themselves are not content, except that an insertion may also sit at
 * the end of the opening fence line: Enter there adds a code line, and typing there edits the info
 * string, neither of which can open or close the block. (A backtick typed into a backtick fence's info
 * string does unmake it; that is accepted.)
 */
export function inCodeContent(regions: CodeRegion[], from: number, to: number): boolean {
	return regions.some(r => (from === to ? r.head_end : r.inner_from) <= from && to <= r.inner_to);
}

export function sameRegions(a: CodeRegion[], b: CodeRegion[]): boolean {
	return a.length === b.length &&
		a.every((r, i) =>
			r.from === b[i].from && r.to === b[i].to && r.head_end === b[i].head_end &&
			r.inner_from === b[i].inner_from && r.inner_to === b[i].inner_to
		);
}
