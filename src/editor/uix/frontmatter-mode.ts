import { EditMode } from "../../types";

export const FRONTMATTER_MODE_KEY = "commentator";
export const FRONTMATTER_AUTHORS_KEY = "commentator-authors";

const MODE_NAMES: Record<string, EditMode> = {
	suggest: EditMode.SUGGEST,
	comment: EditMode.COMMENT,
	off: EditMode.OFF,
};

/**
 * Resolve a note's enforced edit mode from its frontmatter.
 * `commentator: suggest | comment | off` enforces that mode; the optional
 * `commentator-authors: [...]` list EXEMPTS the named authors (the note's owners
 * write freely; everyone else is held to the declared mode).
 * Returns null when nothing is enforced for this user.
 */
export function resolveFrontmatterMode(
	frontmatter: Record<string, unknown> | undefined,
	author: string,
): EditMode | null {
	if (!frontmatter)
		return null;
	const raw = frontmatter[FRONTMATTER_MODE_KEY];
	if (typeof raw !== "string")
		return null;
	const mode = MODE_NAMES[raw.toLowerCase()];
	if (mode === undefined)
		return null;
	const authors = frontmatter[FRONTMATTER_AUTHORS_KEY];
	if (Array.isArray(authors) && author && authors.map(String).includes(author))
		return null;
	return mode;
}
