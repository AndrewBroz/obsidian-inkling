import type { ChangeDesc } from "@codemirror/state";

/** A fenced code block: its opening line's start and end, and its closing line's start and end (both `to` if open). */
export interface CodeRegion {
	from: number;
	to: number;
	open_to: number;
	close_from: number;
}

export const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/** `line` with its tabs expanded to the next multiple of 4 columns. */
const expand = (line: string) =>
	line.includes("\t") ?
		line.replace(/[^\t]*\t/g, part => part.slice(0, -1) + " ".repeat(4 - (part.length - 1) % 4)) :
		line;

/**
 * The fenced code blocks of `text`, as CommonMark reads them, inside `>` quotes and list items (tracked per line; a
 * block left open ends with its container or the text). A line with anything else on it is not a fence line, and no
 * fence opens inside an HTML block.
 */
export function findCodeRegions(text: string): CodeRegion[] {
	const regions: CodeRegion[] = [];
	// Quotes, and list items with their content indent (`empty` while one that began blank has no content yet).
	let stack: { quote: boolean; indent: number; empty: boolean }[] = [];
	let open: { from: number; open_to: number; fence: string; depth: number } | null = null;
	let html: { end: RegExp | undefined; depth: number } | null = null;
	let prev_end = 0, paragraph = false;
	for (let pos = 0; pos <= text.length;) {
		let end = text.indexOf("\n", pos);
		if (end === -1) end = text.length;
		const raw = text.slice(pos, text.charCodeAt(end - 1) === 13 ? end - 1 : end), line = expand(raw);
		let p = 0, matched = 0;
		for (const container of stack) {
			const quote = container.quote && / {0,3}> ?/y;
			if (quote) {
				quote.lastIndex = p;
				if (!quote.test(line)) break;
				p = quote.lastIndex;
			} else if (line.slice(p).trim()) {
				if (!line.startsWith(" ".repeat(container.indent), p)) break;
				p += container.indent;
			} else if (container.empty) { break; }
			matched++;
		}
		const lazy = !open && !html && paragraph && matched < stack.length && !BLOCK_START.test(line.slice(p)) &&
			!THEMATIC.test(line.slice(p)) && !htmlStart(line.slice(p), false);
		if (open && matched < open.depth) {
			regions.push({ from: open.from, to: prev_end, open_to: open.open_to, close_from: prev_end });
			open = null;
		}
		if (html && matched < html.depth) html = null;
		if (open) {
			const m = FENCE.exec(line.slice(p));
			if (m && m[2][0] === open.fence[0] && m[2].length >= open.fence.length && !m[3].trim()) {
				regions.push({ from: open.from, to: pos + raw.length, open_to: open.open_to, close_from: pos });
				open = null;
			}
		} else if (html) {
			if (html.end ? html.end.test(line.slice(p)) : !line.slice(p).trim()) html = null;
		} else if (!lazy) {
			if (matched < stack.length) paragraph = false;
			stack = stack.slice(0, matched);
			if (line.trim()) { for (const container of stack) container.empty = false; }
			// A setext underline ends the paragraph above as a heading.
			const setext: boolean = paragraph && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line.slice(p));
			for (let m; !setext && (m = / {0,3}> ?/y.exec(line.slice(p)) ?? LIST_ITEM.exec(line.slice(p)));) {
				if (m[0].includes(">")) stack.push({ quote: true, indent: 0, empty: false });
				else {
					const marker = m[1].length + m[2].length, spaces = m[3].length, blank = p + m[0].length === line.length;
					// A paragraph is interrupted only by a list item with content that is a bullet or starts at 1.
					if (THEMATIC.test(line.slice(p)) || (paragraph && (blank || !/^([-+*]|0*1[.)])$/.test(m[2])))) break;
					const width = spaces > 4 || blank ? 1 : spaces;
					stack.push({ quote: false, indent: marker + width, empty: blank });
					p += marker + Math.min(width, spaces);
				}
				if (m[0].includes(">")) p += m[0].length;
				paragraph = false;
			}
			const rest = line.slice(p), m = FENCE.exec(rest);
			if (m && (m[2][0] !== "`" || !m[3].includes("`")))
				open = { from: pos, open_to: pos + raw.length, fence: m[2], depth: stack.length };
			else if (htmlStart(rest, !paragraph)) {
				const end = HTML_BLOCKS.find(([start]) => start.test(rest))?.[1];
				if (!end?.test(rest)) html = { end, depth: stack.length };
			}
			paragraph = !setext && !open && !html && !!rest.trim() && !THEMATIC.test(rest) &&
				!/^ {0,3}#{1,6}( |$)/.test(rest) &&
				(paragraph || !/^ {4}/.test(rest)) && !htmlStart(rest, !paragraph);
		}
		if (open || html) paragraph = false;
		prev_end = pos + raw.length;
		pos = end + 1;
	}
	if (open) regions.push({ from: open.from, to: text.length, open_to: open.open_to, close_from: text.length });
	return regions;
}

const LIST_ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])(?= |$)( *)/;
const THEMATIC = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BLOCK_START = /^\s*$|^ {0,3}(>|([-+*]|\d{1,9}[.)])( |$)|#{1,6}( |$)|`{3,}|~{3,})/;
const BLOCK_TAGS =
	"address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|" +
	"dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|" +
	"link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|" +
	"thead|title|tr|track|ul";
const ATTRIBUTE = String.raw`\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>\x60]+|'[^']*'|"[^"]*"))?`;
// HTML block starts (CommonMark types 1-7) and the line that ends each (undefined: a blank line).
const HTML_BLOCKS: [RegExp, RegExp | undefined][] = [
	[/^ {0,3}<(?:script|pre|style|textarea)(?:\s|>|$)/i, /<\/(?:script|pre|style|textarea)>/i],
	[/^ {0,3}<!--/, /-->/],
	[/^ {0,3}<\?/, /\?>/],
	[/^ {0,3}<![A-Za-z]/, />/],
	[/^ {0,3}<!\[CDATA\[/, /\]\]>/],
	[new RegExp(String.raw`^ {0,3}<\/?(?:${BLOCK_TAGS})(?:\s|\/?>|$)`, "i"), undefined],
	[
		new RegExp(String.raw`^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:${ATTRIBUTE})*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$`),
		undefined,
	],
];
/** Whether `line` starts an HTML block; the last kind only where no paragraph would be interrupted. */
const htmlStart = (line: string, uninterrupting: boolean) =>
	HTML_BLOCKS.some(([start], i) => (i < 6 || uninterrupting) && start.test(line));

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
