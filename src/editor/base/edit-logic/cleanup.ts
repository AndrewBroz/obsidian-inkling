import type { PluginSettings } from "../../../types";
import { parseAttrBlock, parseLegacyMetadata } from "../edit-util/attributes";
import { findCodeRegions } from "../edit-util/code-regions";
import { getRangesInText } from "../edit-util/range-parser";

// EXPL: Sync can leave half a range behind (`{++new text` with no closer). Only Inkling writes CriticMarkup, so a
//       delimiter the grammar cannot pair is debris. Cleanup removes exactly the delimiter characters, never the
//       words between them, and never anything inside fenced code or inside a range as the grammar pairs it
//       *without* the code filter, so a range the code rule hides is never mistaken for debris. See "G4" in
//       docs/superpowers/specs/2026-11-20-0.13.0-stable-design.md.

export type DebrisKind = "opener" | "closer" | "attributes" | "legacy";

export interface Debris {
	from: number;
	to: number;
	kind: DebrisKind;
}

const MAX_PASSES = 3;

// EXPL: One sweep for every candidate: openers, closers, any `{` (a possible attribute block) and `}@@` (the end of
//       a possible legacy metadata blob). Openers and closers come first so `{++` is not read as a bare `{`.
const CANDIDATE = /\{(?:\+\+|--|~~|==|>>)|(?:\+\+|--|~~|==|<<)\}|\}@@|\{/g;

const INKLING_KEYS = new Set(["author", "time", "done", "style", "color"]);

/**
 * The span of the candidate at `match`, or undefined if it is not debris by its own shape. Range and code
 * coverage are checked by the caller.
 */
function candidateAt(text: string, match: RegExpExecArray): Debris | undefined {
	const token = match[0];
	const at = match.index;
	if (token.length === 3 && token[0] === "{") return { from: at, to: at + 3, kind: "opener" };
	if (token === "}@@") {
		// EXPL: Walk back on the same line to the nearest `{` whose slice is a JSON object.
		const line_start = text.lastIndexOf("\n", at) + 1;
		for (let start = text.lastIndexOf("{", at); start >= line_start; start = text.lastIndexOf("{", start - 1)) {
			if (parseLegacyMetadata(text.slice(start, at + 1))) return { from: start, to: at + 3, kind: "legacy" };
			if (start === 0) break;
		}
		return undefined;
	}
	if (token.length === 3) return { from: at, to: at + 3, kind: "closer" };

	// EXPL: A lone `{style=…}` or `{color=red}` may be another plugin's attribute syntax: only a block of Inkling
	//       keys that names an author or time is ours. `parseAttrBlock` has already expanded `a`/`t` shorthands.
	const block = parseAttrBlock(text, at);
	if (!block) return undefined;
	const keys = Object.keys(block.fields);
	if (!keys.every(key => INKLING_KEYS.has(key))) return undefined;
	if (!("author" in block.fields) && !("time" in block.fields)) return undefined;
	return { from: block.from, to: block.to, kind: "attributes" };
}

/**
 * Whether `span` overlaps any of the sorted, non-overlapping `areas`.
 * @remark Binary search, not a moving pointer: a legacy span starts at the `{` before its `}@@`, so spans do not
 *         arrive in order of their start.
 */
function intersects(areas: { from: number; to: number }[], span: Debris): boolean {
	let lo = 0;
	let hi = areas.length;
	// EXPL: First area that ends after the span starts.
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (areas[mid].to <= span.from) lo = mid + 1;
		else hi = mid;
	}
	return lo < areas.length && areas[lo].from < span.to;
}

/**
 * Broken CriticMarkup fragments in `text`: sorted, non-overlapping spans whose removal deletes only delimiters
 * (or Inkling metadata) left outside every range and every fenced code block.
 */
export function findDebris(text: string, settings: PluginSettings): Debris[] {
	// EXPL: Metadata is always parsed: with it off, a range's trailing `{author=…}` would not attach and would
	//       look orphaned. The code filter is off for the same reason (see the module comment).
	const ranges = getRangesInText(text, { ...settings, enable_metadata: true }, false);
	const regions = findCodeRegions(text);
	const debris: Debris[] = [];

	CANDIDATE.lastIndex = 0;
	for (let match; (match = CANDIDATE.exec(text));) {
		const span = candidateAt(text, match);
		if (!span) continue;

		// EXPL: Template syntax (`{{-- note --}}`, `{{!-- x --}}`) is not ours.
		if (text[span.from - 1] === "{" || text[span.to] === "}") continue;

		if (intersects(ranges, span) || intersects(regions, span)) continue;

		// EXPL: A legacy blob is only recognised at its `}@@`, after any opener quoted in its JSON was already
		//       taken; the blob replaces those, so it is removed as one fragment.
		let first_inside = debris.length;
		while (first_inside && debris[first_inside - 1].from >= span.from) first_inside--;
		if (first_inside && debris[first_inside - 1].to > span.from) continue;

		debris.splice(first_inside, debris.length - first_inside, span);
		// EXPL: A whole block or blob is one fragment; do not rescan an opener quoted inside it.
		CANDIDATE.lastIndex = Math.max(CANDIDATE.lastIndex, span.to);
	}
	return debris;
}

/**
 * Changes that remove all debris from `text`, expressed against `text` itself. Removing a fragment can expose
 * another (`{+{+++` loses its inner `{++` and becomes `{++`), so this re-parses and repeats, up to three passes.
 * `count` is the number of fragments removed over all passes.
 */
export function cleanupChanges(
	text: string,
	settings: PluginSettings,
): { changes: { from: number; to: number; insert: "" }[]; count: number } {
	const removed = new Uint8Array(text.length);
	// EXPL: `origin[i]` is the position in `text` of the current text's character `i`; null while they coincide.
	let origin: number[] | null = null;
	let current = text;
	let count = 0;

	for (let pass = 0; pass < MAX_PASSES; pass++) {
		const debris = findDebris(current, settings);
		if (!debris.length) break;
		count += debris.length;

		const next_origin: number[] = [];
		let pos = 0;
		for (const span of debris) {
			for (; pos < span.from; pos++) next_origin.push(origin ? origin[pos] : pos);
			for (; pos < span.to; pos++) removed[origin ? origin[pos] : pos] = 1;
		}
		for (; pos < current.length; pos++) next_origin.push(origin ? origin[pos] : pos);
		origin = next_origin;
		current = origin.map(i => text[i]).join("");
	}

	const changes: { from: number; to: number; insert: "" }[] = [];
	for (let i = 0; i < text.length; i++) {
		if (!removed[i]) continue;
		const from = i;
		while (i < text.length && removed[i]) i++;
		changes.push({ from, to: i, insert: "" });
	}
	return { changes, count };
}
