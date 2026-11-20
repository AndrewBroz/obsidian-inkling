export interface CodeRegion {
	/** Start of the opening fence line. */
	from: number;
	/**
	 * End of the closing fence line (excluding newline), or of the CriticMarkup closer that ends it
	 * ("```++} more" ends after "++}"), or text.length if unclosed.
	 */
	to: number;
}

// Optional "{++" style CriticMarkup opener may precede the fence, so a fence
// wrapped by a range ("{++```") is still recognised as a code block.
const OPEN_FENCE = /^( {0,3}(?:> ?)*)(\{(?:\+\+|--|==|~~))?(`{3,}|~{3,})(.*)$/;
// A closing fence may carry the closer of a range wrapping the block; text may follow that closer
// ("```++} {--d--}"), and is outside the region.
const CLOSE_FENCE = /^ {0,3}(?:> ?)*(`{3,}|~{3,})(?:(?:\+\+\}|--\}|==\}|~~\})(.*)|\s*)$/;

/** Finds fenced code blocks (``` / ~~~, including inside `>` quotes). Sorted, non-overlapping. */
export function findCodeRegions(text: string): CodeRegion[] {
	const regions: CodeRegion[] = [];
	let open: { from: number; char: string; length: number } | null = null;
	let pos = 0;

	while (pos <= text.length) {
		let end = text.indexOf("\n", pos);
		if (end === -1) end = text.length;
		const line = text.slice(pos, end).replace(/\r$/, "");

		if (open) {
			const m = CLOSE_FENCE.exec(line);
			if (m && m[1][0] === open.char && m[1].length >= open.length) {
				regions.push({ from: open.from, to: pos + line.length - (m[2]?.length ?? 0) });
				open = null;
			}
		} else {
			const m = OPEN_FENCE.exec(line);
			if (m && !(m[3][0] === "`" && m[4].includes("`"))) {
				// A range prefix stays outside the region so the range remains valid.
				open = { from: m[2] ? pos + m[1].length + m[2].length : pos, char: m[3][0], length: m[3].length };
			}
		}

		pos = end + 1;
	}

	if (open) regions.push({ from: open.from, to: text.length });
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

export function sameRegions(a: CodeRegion[], b: CodeRegion[]): boolean {
	return a.length === b.length && a.every((r, i) => r.from === b[i].from && r.to === b[i].to);
}
