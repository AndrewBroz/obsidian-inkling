import type { ChangeDesc } from "@codemirror/state";

/** A fenced code block: its opening line's start and end, and its closing line's start and end (both `to` if open). */
export interface CodeRegion {
	from: number;
	to: number;
	open_to: number;
	close_from: number;
}

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/** The fence of a fence line: everything before its fence characters, and their offsets. */
export function fenceMarker(line: string): { prefix: string; from: number; to: number } {
	const m = /^(.*?)(`{3,}|~{3,})/.exec(line)!;
	return { prefix: m[1], from: m[1].length, to: m[1].length + m[2].length };
}

/** `line` with its tabs expanded to the next multiple of 4 columns. */
const expand = (line: string) =>
	line.includes("\t") ?
		line.replace(/[^\t]*\t/g, part => part.slice(0, -1) + " ".repeat(4 - (part.length - 1) % 4)) :
		line;

/**
 * The fenced code blocks of `text`, as CommonMark reads them, inside `>` quotes and list items (tracked per line; a
 * block left open ends with its container or the text). A line with anything else on it is not a fence line.
 */
export function findCodeRegions(text: string): CodeRegion[] {
	const regions: CodeRegion[] = [];
	let stack: number[] = []; // -1: a quote; otherwise a list item's content indent
	let open: { from: number; open_to: number; fence: string; depth: number } | null = null;
	let prev_end = 0, paragraph = false;
	for (let pos = 0; pos <= text.length;) {
		let end = text.indexOf("\n", pos);
		if (end === -1) end = text.length;
		const raw = text.slice(pos, text.charCodeAt(end - 1) === 13 ? end - 1 : end), line = expand(raw);
		let p = 0, matched = 0;
		for (const container of stack) {
			const quote = container < 0 && / {0,3}> ?/y;
			if (quote) {
				quote.lastIndex = p;
				if (!quote.test(line)) break;
				p = quote.lastIndex;
			} else if (line.slice(p).trim()) {
				if (!line.startsWith(" ".repeat(container), p)) break;
				p += container;
			}
			matched++;
		}
		const lazy = !open && paragraph && matched < stack.length && !BLOCK_START.test(line.slice(p)) &&
			!THEMATIC.test(line.slice(p));
		if (open && matched < open.depth) {
			regions.push({ from: open.from, to: prev_end, open_to: open.open_to, close_from: prev_end });
			open = null;
		}
		if (open) {
			const m = FENCE.exec(line.slice(p));
			if (m && m[2][0] === open.fence[0] && m[2].length >= open.fence.length && !m[3].trim()) {
				regions.push({ from: open.from, to: pos + raw.length, open_to: open.open_to, close_from: pos });
				open = null;
			}
		} else if (!lazy) {
			stack = stack.slice(0, matched);
			for (let m; (m = / {0,3}> ?/y.exec(line.slice(p)) ?? LIST_ITEM.exec(line.slice(p)));) {
				if (m[0].includes(">")) stack.push(-1);
				else if (THEMATIC.test(line.slice(p))) break;
				else {
					const marker = m[1].length + m[2].length, spaces = m[3].length;
					const width = spaces > 4 || p + m[0].length === line.length ? 1 : spaces;
					stack.push(marker + width);
					p += marker + Math.min(width, spaces);
					continue;
				}
				p += m[0].length;
			}
			const rest = line.slice(p), m = FENCE.exec(rest);
			if (m && (m[2][0] !== "`" || !m[3].includes("`")))
				open = { from: pos, open_to: pos + raw.length, fence: m[2], depth: stack.length };
			paragraph = !open && !!rest.trim() && !THEMATIC.test(rest) && !/^ {0,3}#{1,6}( |$)/.test(rest) &&
				(paragraph || !/^ {4}/.test(rest));
		}
		if (open) paragraph = false;
		prev_end = pos + raw.length;
		pos = end + 1;
	}
	if (open) regions.push({ from: open.from, to: text.length, open_to: open.open_to, close_from: text.length });
	return regions;
}

const LIST_ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])(?= |$)( *)/;
const THEMATIC = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BLOCK_START = /^\s*$|^ {0,3}(>|([-+*]|\d{1,9}[.)])( |$)|#{1,6}( |$)|`{3,}|~{3,})/;

/** `text` with every character inside a code region (line breaks excepted) replaced by a space. */
export function maskCode(text: string, regions: { from: number; to: number }[]): string {
	let out = "", pos = 0;
	for (const r of regions) {
		out += text.slice(pos, r.from) + text.slice(r.from, r.to).replace(/[^\n]/g, " ");
		pos = r.to;
	}
	return out + text.slice(pos);
}

/** Whether `next` (after `changes`) has the blocks of `old`, each boundary where `changes` maps it. */
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
