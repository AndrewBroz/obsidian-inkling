import type { PluginSettings } from "../../../types";
import { parseAttrBlock, parseLegacyMetadata, SHORTHAND_KEYS } from "../edit-util/attributes";
import { findCodeRegions } from "../edit-util/code-regions";
import { getRangesInText } from "../edit-util/range-parser";
import type { MetadataFields } from "../ranges";

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

// EXPL: One sweep for every candidate: openers, closers, any `{` (a possible attribute block) and `}@@` (the end of
//       a possible legacy metadata blob). Openers and closers come first so `{++` is not read as a bare `{`.
const CANDIDATE = /\{(?:\+\+|--|~~|==|>>)|(?:\+\+|--|~~|==|<<)\}|\}@@|\{/g;

const INKLING_KEYS = new Set(["author", "time", "done", "style", "color", ...Object.keys(SHORTHAND_KEYS)]);
const IDENTIFYING_KEYS = ["author", "time", "a", "t"];

// EXPL: A closer-shaped token (`--}`, also `>>}`) sharing characters with an opener: `{---}` is not a broken `{--`.
const OVERLAPPING_CLOSER = /^([+\-~=<>])\1\}/;

/**
 * Whether metadata left outside any range is Inkling's: every key is an Inkling key and one names an author or a
 * time. A lone `{style=…}` or `{color=red}` may be another plugin's attribute syntax, and unknown JSON before `@@`
 * may be anything, so both stay.
 */
function inklingMetadata(fields: MetadataFields): boolean {
	const keys = Object.keys(fields);
	return keys.every(key => INKLING_KEYS.has(key)) && IDENTIFYING_KEYS.some(key => keys.includes(key));
}

/**
 * The span of the candidate at `match`, or undefined if it is not debris by its own shape. Range and code
 * coverage are checked by the caller.
 */
function candidateAt(text: string, match: RegExpExecArray): Debris | undefined {
	const token = match[0];
	const at = match.index;
	if (token.length === 3 && token[0] === "{") {
		if (OVERLAPPING_CLOSER.test(text.slice(at + 1, at + 4)) || OVERLAPPING_CLOSER.test(text.slice(at + 2, at + 5)))
			return undefined;
		return { from: at, to: at + 3, kind: "opener" };
	}
	if (token === "}@@") {
		// EXPL: Walk back on the same line to the nearest `{` whose slice is a JSON object.
		const line_start = text.lastIndexOf("\n", at) + 1;
		for (let start = text.lastIndexOf("{", at); start >= line_start; start = text.lastIndexOf("{", start - 1)) {
			const fields = parseLegacyMetadata(text.slice(start, at + 1));
			if (fields) return inklingMetadata(fields) ? { from: start, to: at + 3, kind: "legacy" } : undefined;
			if (start === 0) break;
		}
		return undefined;
	}
	if (token.length === 3) return { from: at, to: at + 3, kind: "closer" };

	const block = parseAttrBlock(text, at);
	if (!block || !inklingMetadata(block.fields)) return undefined;
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

/** The ranges (unfiltered, metadata always on) and fenced regions that cleanup must leave intact. */
function structure(text: string, settings: PluginSettings): string[] {
	return [
		...getRangesInText(text, { ...settings, enable_metadata: true }, false).map(r => `${r.type}:${r.from}:${r.to}`),
		...findCodeRegions(text).map(r => `code:${r.from}:${r.to}`),
	];
}

function remove(text: string, spans: Debris[]): string {
	let out = "";
	let last = 0;
	for (const span of spans) {
		out += text.slice(last, span.from);
		last = span.to;
	}
	return out + text.slice(last);
}

/** Whether removing `spans` leaves every range and fenced region exactly as it was, only shifted. */
function preserves(text: string, settings: PluginSettings, before: string[], spans: Debris[]): boolean {
	const shift = (pos: number) => {
		let removed = 0;
		for (const span of spans) if (span.to <= pos) removed += span.to - span.from;
		return pos - removed;
	};
	const expected = before.map(entry => {
		const [kind, from, to] = entry.split(":");
		return `${kind}:${shift(Number(from))}:${shift(Number(to))}`;
	});
	const after = structure(remove(text, spans), settings);
	return after.length === expected.length && after.every((entry, i) => entry === expected[i]);
}

// EXPL: The per-fragment fallback re-parses the whole note once per fragment: about 10 s at 1000 fragments.
const FALLBACK_LIMIT = 50;

/**
 * Changes that remove the debris from `text`. One pass only, and validated: removing a fragment can change how the
 * grammar pairs what remains (`{+{--+ x {==y++} z==}` without its `{--` turns `{++ x {==y++}` into an addition) or
 * where a fence opens, so the removals are kept only if every range and fenced region survives unchanged. Failing
 * that, each removal that is safe on its own is kept if they are still safe together; otherwise nothing changes.
 * Past `FALLBACK_LIMIT` fragments the fallback is skipped (it re-parses once per fragment) and nothing changes.
 * Adjacent removals are merged into one change; `count` is the number of fragments removed.
 */
export function cleanupChanges(
	text: string,
	settings: PluginSettings,
): { changes: { from: number; to: number; insert: "" }[]; count: number } {
	let debris = findDebris(text, settings);
	if (debris.length) {
		const before = structure(text, settings);
		if (!preserves(text, settings, before, debris)) {
			if (debris.length > FALLBACK_LIMIT) return { changes: [], count: 0 };
			debris = debris.filter(span => preserves(text, settings, before, [span]));
			if (!preserves(text, settings, before, debris)) debris = [];
		}
	}

	const changes: { from: number; to: number; insert: "" }[] = [];
	for (const span of debris) {
		const previous = changes[changes.length - 1];
		if (previous && previous.to === span.from) previous.to = span.to;
		else changes.push({ from: span.from, to: span.to, insert: "" });
	}
	return { changes, count: debris.length };
}
