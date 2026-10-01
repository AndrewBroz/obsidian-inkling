interface Loc {
	line: number;
	offset: number;
}

export interface HeadingLike {
	level: number;
	position: { start: Loc };
}

export interface ListItemLike {
	/** Line of the parent list item; negative for top-level items. */
	parent: number;
	position: { start: Loc; end: Loc };
}

export type EmbedTarget =
	| { kind: "note"; frontmatter_end: number | null }
	| { kind: "heading"; headings: HeadingLike[]; index: number }
	| { kind: "block"; start: number; end: number; list_items?: ListItemLike[]; list_line?: number };

/** The part of a note's source that Obsidian shows for a transclusion of `target`. */
export function embedSlice(text: string, target: EmbedTarget): string {
	switch (target.kind) {
		case "note":
			return target.frontmatter_end === null ? text : text.slice(target.frontmatter_end).replace(/^\r?\n/, "");
		case "heading": {
			const { headings, index } = target;
			const level = headings[index].level;
			let end = text.length;
			for (let j = index + 1; j < headings.length; j++) {
				if (headings[j].level <= level) {
					end = headings[j].position.start.offset;
					break;
				}
			}
			return text.slice(headings[index].position.start.offset, end);
		}
		case "block": {
			let end = target.end;
			if (target.list_items && target.list_line !== undefined)
				end = Math.max(end, listItemEnd(target.list_items, target.list_line));
			return text.slice(target.start, end);
		}
	}
}

function listItemEnd(items: ListItemLike[], root_line: number): number {
	const members = new Set([root_line]);
	let end = -1;
	for (const item of [...items].sort((a, b) => a.position.start.line - b.position.start.line)) {
		const line = item.position.start.line;
		if (line === root_line || (line > root_line && members.has(item.parent))) {
			members.add(line);
			end = Math.max(end, item.position.end.offset);
		}
	}
	return end;
}
