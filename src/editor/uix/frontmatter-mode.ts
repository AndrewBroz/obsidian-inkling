import { EditMode } from "../../types";

// EXPL: "inkling" is the primary key; "commentator" is kept as a legacy alias so
//       notes authored under the pre-rename plugin id keep working. First match
//       wins, so `inkling` takes precedence over a coexisting `commentator` key.
//       FRONTMATTER_AUTHORS_KEYS is index-aligned with FRONTMATTER_MODE_KEYS: the
//       authors list is looked up by the SAME family as the matched mode key,
//       falling back to the other family only if the matched family has no
//       authors entry at all.
export const FRONTMATTER_MODE_KEYS = ["inkling", "commentator"];
export const FRONTMATTER_AUTHORS_KEYS = ["inkling-authors", "commentator-authors"];

const MODE_NAMES: Record<string, EditMode> = {
	suggest: EditMode.SUGGEST,
	comment: EditMode.COMMENT,
	off: EditMode.OFF,
};

/**
 * Resolve a note's enforced edit mode from its frontmatter.
 * `inkling: suggest | comment | off` (or the legacy `commentator: ...`) enforces
 * that mode; the optional `inkling-authors: [...]` (or `commentator-authors: [...]`)
 * list EXEMPTS the named authors (the note's owners write freely; everyone else is
 * held to the declared mode).
 * Returns null when nothing is enforced for this user.
 */
export function resolveFrontmatterMode(
	frontmatter: Record<string, unknown> | undefined,
	author: string,
): EditMode | null {
	if (!frontmatter)
		return null;

	let mode: EditMode | undefined;
	let matched_index = -1;
	for (let i = 0; i < FRONTMATTER_MODE_KEYS.length; i++) {
		const raw = frontmatter[FRONTMATTER_MODE_KEYS[i]];
		if (typeof raw !== "string")
			continue;
		const resolved = MODE_NAMES[raw.toLowerCase()];
		if (resolved !== undefined) {
			mode = resolved;
			matched_index = i;
			break;
		}
	}
	if (mode === undefined)
		return null;

	// EXPL: Check the matched key's own authors family first, only falling back to
	//       the other family when the matched family has no authors entry at all.
	const authors_keys = [
		FRONTMATTER_AUTHORS_KEYS[matched_index],
		...FRONTMATTER_AUTHORS_KEYS.filter((_, i) => i !== matched_index),
	];
	for (const key of authors_keys) {
		const authors = frontmatter[key];
		if (authors === undefined)
			continue;
		if (Array.isArray(authors) && author && authors.map(String).includes(author))
			return null;
		break;
	}

	return mode;
}
