import type { MetadataFields } from "../ranges/base_range";

// EXPL: Pandoc-style trailing attribute blocks, `{author="Andrew" time=1791819807}`, written after a range's
//       closer. Recognition is all-or-nothing: a `{` starts a block only if the whole thing parses, so literal
//       braces in prose and every CriticMarkup opener stay text. See
//       docs/superpowers/specs/2026-10-12-inklingmarkup-metadata-attributes-design.md.

export const SHORTHAND_KEYS: Record<string, string> = {
	a: "author",
	t: "time",
	d: "done",
	s: "style",
	c: "color",
};

export interface AttrBlock {
	from: number;
	to: number;
	fields: MetadataFields;
}

const KEY = /[A-Za-z_][A-Za-z0-9_-]*/y;
const KEY_FULL = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const BARE = /[A-Za-z0-9_.:+-]+/y;
const BARE_FULL = /^[A-Za-z0-9_.:+-]+$/;
const ESCAPABLE = new Set(["\"", "\\", "{", "}"]);

// EXPL: `__proto__` cannot be a field: assigning it to a plain object sets the prototype and drops the value.
const RESERVED_KEY = "__proto__";

function isShorthand(key: string): boolean {
	return Object.prototype.hasOwnProperty.call(SHORTHAND_KEYS, key);
}

// EXPL: Bare values are typed so that strings, numbers and booleans all survive a legacy → attributes → legacy
//       round trip: a bare value is a number only if `Number` gives it back unchanged (so `007` stays a string),
//       and `true`/`false` are booleans. Quoted values are always strings; the writer quotes any string that would
//       otherwise read back as something else.
function readBare(value: string): string | number | boolean {
	if (value === "true") return true;
	if (value === "false") return false;
	const number = Number(value);
	if (Number.isFinite(number) && String(number) === value) return number;
	return value;
}

/**
 * The attribute block starting exactly at `at`, or undefined if the text there is not one.
 */
export function parseAttrBlock(text: string, at: number): AttrBlock | undefined {
	if (text[at] !== "{") return undefined;
	const fields: MetadataFields = {};
	let pos = at + 1;
	for (let first = true;; first = false) {
		if (!first) {
			if (text[pos] === "}") break;
			if (text[pos] !== " ") return undefined;
			while (text[pos] === " ") pos++;
		}

		KEY.lastIndex = pos;
		const key = KEY.exec(text);
		if (!key) return undefined;
		pos += key[0].length;
		if (text[pos] !== "=") return undefined;
		pos++;

		let value: string | number | boolean;
		if (text[pos] === "\"") {
			let str = "";
			pos++;
			for (;;) {
				const ch = text[pos];
				if (ch === undefined || ch === "\n") return undefined;
				if (ch === "\"") {
					pos++;
					break;
				}
				if (ch === "\\") {
					const next = text[pos + 1];
					if (!ESCAPABLE.has(next)) return undefined;
					str += next;
					pos += 2;
					continue;
				}
				str += ch;
				pos++;
			}
			value = str;
		} else {
			BARE.lastIndex = pos;
			const bare = BARE.exec(text);
			if (!bare) return undefined;
			pos += bare[0].length;
			value = readBare(bare[0]);
		}

		const name = isShorthand(key[0]) ? SHORTHAND_KEYS[key[0]] : key[0];
		if (name === RESERVED_KEY) return undefined;
		fields[name] = value;
	}
	return { from: at, to: pos + 1, fields };
}

function serializeValue(value: unknown): string {
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	const str = String(value);
	if (BARE_FULL.test(str) && readBare(str) === str) return str;
	return `"${str.replace(/["\\{}]/g, ch => "\\" + ch)}"`;
}

/**
 * The block for `fields`, or "" when there is nothing to write: "no metadata" has exactly one spelling, no block.
 * @remark Callers must check `unconvertibleReason` first; values it rejects would not read back unchanged.
 */
export function serializeAttrBlock(fields: MetadataFields): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		parts.push(`${key}=${serializeValue(value)}`);
	}
	return parts.length ? `{${parts.join(" ")}}` : "";
}

/**
 * Why `fields` cannot be written as an attribute block and read back unchanged, or undefined if it can.
 */
export function unconvertibleReason(fields: MetadataFields): string | undefined {
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		if (!KEY_FULL.test(key) || key === RESERVED_KEY) return `field name "${key}" cannot be written as an attribute`;
		if (isShorthand(key)) return `"${key}" is an attribute shorthand and would read back as "${SHORTHAND_KEYS[key]}"`;
		if (typeof value === "string") {
			if (value.includes("\n")) return `"${key}" contains a line break`;
		} else if (typeof value === "number") {
			if (!Number.isFinite(value)) return `"${key}" is not a finite number`;
		} else if (typeof value !== "boolean") {
			return `"${key}" is not a string, number or true/false`;
		}
	}
	return undefined;
}

/**
 * The fields of a legacy `{json}@@` blob, given the text between the opener and the `@@`, or undefined if that text
 * is not legacy metadata. Only a JSON object is: the grammar marks the first `@@` in any range as a separator, so
 * for any other text the `@@` is content. `{}` is an (empty) object, so `{}@@` is metadata.
 */
export function parseLegacyMetadata(json: string): MetadataFields | undefined {
	let value: unknown;
	try {
		// TODO: JS can be injected here, possible security risk
		value = JSON.parse(json);
	} catch {
		return undefined;
	}
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as MetadataFields : undefined;
}

/**
 * Why a range with this text (opener included, metadata excluded) cannot carry an attribute block, or undefined if
 * it can. Content whose text before its first `@@` is a JSON object would read back as legacy metadata, and the
 * block would be left behind.
 */
export function unconvertibleContent(text: string): string | undefined {
	const separator = text.indexOf("@@", 3);
	return separator !== -1 && parseLegacyMetadata(text.slice(3, separator)) ?
		"its text starts with a JSON object followed by @@, which reads back as legacy metadata" :
		undefined;
}

/**
 * A warning when `author` would put an `@` after a non-alphanumeric character in an attribute block, which
 * Pandoc-grammar tools (ZotLit, Pandoc) read as a citation. `a@b.com` is fine.
 */
export function author_at_warning(author: string | undefined): string | undefined {
	if (!author || !/(^|[^\p{L}\p{N}])@/u.test(author)) return undefined;
	return "An @ at the start of a word is read as a citation by Pandoc and ZotLit when written in attribute blocks.";
}
