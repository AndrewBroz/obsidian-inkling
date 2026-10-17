# InklingMarkup metadata attributes: implementation plan (Release A)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inkling reads and (when told to) writes trailing attribute blocks, `{==some==}{>>note<<}{author="Andrew" time=1791819807}`, alongside the legacy `{json}@@` form. It applies the thread rules and offers per-note conversion. The default stays legacy (Release A).

**Architecture:** A pure `attributes.ts` module parses and serialises blocks. The range model replaces the `metadata` position with a `meta` location tagged by syntax, and a range's `to` includes its trailing block, so whole-range edits remove it for free. Effective `fields` become a getter over the written `own_fields`, which is where highlight-anchor inheritance and "`done` lives on the base" are applied. Every writer goes through syntax-aware functions driven by a new `metadata_syntax` setting, with touch-to-migrate.

**Tech stack:** TypeScript, CodeMirror 6 state, Lezer (`@fevol/lang-criticmarkup`, unchanged), Svelte 5 settings UI, Jest (`bun run test`, never bare `bun test`), dprint.

**Spec:** `docs/superpowers/specs/2026-10-12-inklingmarkup-metadata-attributes-design.md`. Read it before starting any task.

## Global constraints

- Release A only: `metadata_syntax` defaults to `"legacy"` for everyone. There is no "switch now" notice, and nothing in this plan flips the default. Release B is a separate change, gated on every CRI member being on A and `config/critic.py` reading the new form.
- Read both forms forever. No code path stops parsing `{json}@@`.
- Never rewrite in bulk without being asked: opening a note never changes it. Conversion happens only through the two per-note commands.
- Lossless or untouched: a range whose fields cannot round-trip stays legacy.
- Attribute grammar, verbatim from the spec:
  `attr-block := "{" attr (" "+ attr)* "}"`, `attr := key "=" value`, `key := [A-Za-z_][A-Za-z0-9_-]*`, `value := bare | quoted`, `bare := [A-Za-z0-9_.:+-]+`, `quoted := '"' ( [^"\\\n] | "\\" ["\\{}] )* '"'`.
- `{}` is never a block. A block containing `.class` or `#id` is rejected (reserved).
- Full keys on write (`author`, `time`, `done`, `style`, `color`). The shorthand `a`/`t`/`d`/`s`/`c` is accepted on read.
- Inherited keys are exactly `author` and `time`, and only a HIGHLIGHT inherits, only from its first comment.
- `api.version` stays `1`.
- Source files use **CRLF** line endings and tabs. Keep both (dprint enforces them). Run `bun run format` before each commit.
- Test runner: `bun run test` (Jest). Typecheck and build: `bun run build`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on branch `feat/metadata-attributes`, created from `docs/metadata-attributes-spec`. Never push or tag; the user releases.

## Decisions this plan makes that the spec left open

These are clarifications. The reviewer should check them against the spec's intent.

1. **Value typing.** Bare values are typed: a bare value that round-trips through `Number` (`String(Number(v)) === v`) is a number, and bare `true`/`false` is a boolean. Quoted values are always strings. The writer quotes any string that would otherwise read back as a number or boolean. This makes every string, finite-number and boolean field lossless, which the spec's lossless-conversion rule needs. `time=1791819807` and `done=true` read exactly as the spec says.
2. **Inheritance is a getter, not a parse-time pass.** The spec resolves inheritance in `cursorGenerateRanges` after `add_reply`. Threads are also reassembled incrementally in `range-state.ts`, so a getter on `HighlightRange` (and the `done` filter on reply `CommentRange`s) covers both paths with no stale state.
3. **A range with legacy metadata never takes a trailing block.** `{=={"a":"x"}@@t==}{author=y}` is a legacy range followed by literal text.
4. **Pre-fork hazard, closed for parsing.** When the grammar reports a node that starts inside the previous range's attribute block, the parser re-parses from the end of the block instead of trusting it. The spec's caveat (`author="{++x"`) therefore no longer produces bogus ranges.
5. **Comment-text escaping (spec §5).** No new rule. A comment body is already refused if it contains `<<}`, which is the only way typed text can end up after a closer. The remaining case, prose such as `{k=v}` sitting directly after a range, is documented and pinned by a test (Task 3), in the same spirit as the spec's `@`-in-value limitation.

## Review focus

The five failure modes most likely to bite a user that no single feature test covers. Each has a test in the task named.

1. **Editing in and around a block incrementally:** typing inside a block, deleting its `}`, typing right after it, or pasting a whole block. The incremental parse must equal a fresh parse every time (Task 3: incremental-versus-full oracle in `range_state_fuzz.test.ts`).
2. **Author names with spaces, non-ASCII, quotes, braces, backslashes or a leading `@`:** these must survive write and read unchanged (Task 1: `serialize → parse` round trip over hostile values).
3. **Cursor placement after Inkling writes a range in attributes mode:** the new empty comment's caret, and the caret after typing into a suggestion (Task 6: `add_comment` caret test; `mark_ranges` attributes cases).
4. **Accept All / Reject All / Remove comment in a note with blocks:** these must never leave a stray `{…}` (Task 6: fuzz segments with blocks; Task 3: accept/reject/unwrap tests).
5. **Mixed notes:** a legacy anchor with an attributes reply, and attributes anchors with legacy replies. Inheritance, resolve and conversion must behave per range (Task 4 and Task 9: mixed-form tests).

---

## File structure

| File | Responsibility |
|---|---|
| `src/editor/base/edit-util/attributes.ts` (new) | Pure grammar: `parseAttrBlock`, `serializeAttrBlock`, `unconvertibleReason`, `SHORTHAND_KEYS`. No imports beyond a type. |
| `src/types.ts` | `MetadataSyntax` type; `metadata_syntax` setting. |
| `src/constants.ts` | Default `metadata_syntax: "legacy"`. |
| `src/editor/base/ranges/base_range.ts` | `MetaLocation`, `own_fields`/`fields`, `closer_to`, syntax-aware metadata writers, `INHERITED_KEYS`. |
| `src/editor/base/ranges/types/*.ts` | Constructor signature `meta?: MetaLocation`; Highlight/Comment `fields` getters; Substitution closer arithmetic. |
| `src/editor/base/edit-util/range-parser.ts` | Read trailing blocks; re-parse after a block. |
| `src/editor/base/edit-util/range-state.ts` | Regenerate from the start of each invalidated range. |
| `src/editor/base/edit-util/metadata.ts` | `write_syntax`. |
| `src/editor/base/edit-util/range-create.ts` | Syntax-aware `construct_range`; `create_anchored_comment`. |
| `src/editor/base/edit-logic/resolve.ts` | Base-only resolve; reopen cleanup; `range_source_with_fields(…, syntax)`; `anchor_inheritance_changes`. |
| `src/editor/base/edit-logic/convert-metadata.ts` (new) | `convert_metadata(ranges, target)`. |
| `src/ui/modals/confirm-modal.ts` (new) | A small yes/no modal for the convert commands. |
| `src/editor/uix/commands.ts` | Two convert commands. |
| Renderers / UI call sites | Listed per task. |

---

### Task 1: Attribute block grammar (`attributes.ts`)

**Files:**
- Create: `src/editor/base/edit-util/attributes.ts`
- Test: `tests/attributes.test.ts`

**Interfaces:**
- Produces:
  - `parseAttrBlock(text: string, at: number): AttrBlock | undefined`
  - `serializeAttrBlock(fields: MetadataFields): string` (returns `""` when nothing is written)
  - `unconvertibleReason(fields: MetadataFields): string | undefined`
  - `SHORTHAND_KEYS: Record<string, string>`
  - `interface AttrBlock { from: number; to: number; fields: MetadataFields }`

- [ ] **Step 1: Create the branch.**

```bash
git checkout docs/metadata-attributes-spec && git checkout -b feat/metadata-attributes
```

- [ ] **Step 2: Write the failing tests.** Create `tests/attributes.test.ts` (CRLF):

```ts
import { parseAttrBlock, serializeAttrBlock, unconvertibleReason } from "../src/editor/base/edit-util/attributes";

describe("parseAttrBlock", () => {
	test("reads a block at the given position and reports its span", () => {
		const text = `{==x==}{author="Andrew" time=1791819807}tail`;
		expect(parseAttrBlock(text, 7)).toEqual({
			from: 7,
			to: text.indexOf("tail"),
			fields: { author: "Andrew", time: 1791819807 },
		});
	});

	test("types bare values: canonical numbers and true/false", () => {
		expect(parseAttrBlock(`{done=true n=-2.5 z=007 f=false}`, 0)!.fields)
			.toEqual({ done: true, n: -2.5, z: "007", f: false });
	});

	test("quoted values are always strings", () => {
		expect(parseAttrBlock(`{time="12" done="true"}`, 0)!.fields).toEqual({ time: "12", done: "true" });
	});

	test("unescapes \\\" \\\\ \\{ \\}", () => {
		expect(parseAttrBlock(String.raw`{author="a\"b\\c\{d\}"}`, 0)!.fields).toEqual({ author: `a"b\\c{d}` });
	});

	test("normalises shorthand keys", () => {
		expect(parseAttrBlock(`{a=Bea t=5 d=true s=x c=ff0000}`, 0)!.fields)
			.toEqual({ author: "Bea", time: 5, done: true, style: "x", color: "ff0000" });
	});

	test.each([
		["empty braces", "{}"],
		["not at a brace", " {a=1}"],
		["no value", "{a}"],
		["empty bare value", "{a=}"],
		["unterminated", "{a=1"],
		["trailing space", "{a=1 }"],
		["leading space", "{ a=1}"],
		["tab separator", "{a=1\tb=2}"],
		["reserved class", "{.note a=1}"],
		["reserved id", "{#a1 a=1}"],
		["bad escape", String.raw`{a="\n"}`],
		["newline in quotes", "{a=\"x\ny\"}"],
		["unclosed quote", `{a="x}`],
		["criticmarkup opener", "{>>c<<}"],
		["bad key start", "{1a=2}"],
	])("rejects %s", (_name, text) => {
		expect(parseAttrBlock(text, 0)).toBeUndefined();
	});

	test("accepts several spaces between attributes", () => {
		expect(parseAttrBlock("{a=1   b=2}", 0)!.fields).toEqual({ a: 1, b: 2 });
	});
});

describe("serializeAttrBlock", () => {
	test("writes bare when the value reads back unchanged, otherwise quoted", () => {
		expect(serializeAttrBlock({ author: "Andrew", time: 1791819807 })).toBe("{author=Andrew time=1791819807}");
		expect(serializeAttrBlock({ author: "Andrew Brož" })).toBe(`{author="Andrew Brož"}`);
		expect(serializeAttrBlock({ author: "7" })).toBe(`{author="7"}`);
		expect(serializeAttrBlock({ author: "true" })).toBe(`{author="true"}`);
		expect(serializeAttrBlock({ done: true })).toBe("{done=true}");
	});

	test("skips undefined values and writes nothing for no fields", () => {
		expect(serializeAttrBlock({ author: undefined, time: 3 })).toBe("{time=3}");
		expect(serializeAttrBlock({})).toBe("");
		expect(serializeAttrBlock({ author: undefined })).toBe("");
	});

	// EXPL: Review focus 2: hostile author names must survive a write and a read unchanged.
	test.each([
		"Andrew Brož",
		`Bea "B" O'Neil`,
		"braces {++x++} and }",
		"back\\slash",
		"@andrew",
		"a@b.com",
		"007",
		"-1",
		"1e+21",
		"true",
		"",
	])("round-trips %j", (author) => {
		const block = serializeAttrBlock({ author, time: 1 });
		expect(parseAttrBlock(block, 0)).toEqual({ from: 0, to: block.length, fields: { author, time: 1 } });
	});

	test("preserves field order", () => {
		const block = serializeAttrBlock({ time: 1, author: "x", done: true });
		expect(Object.keys(parseAttrBlock(block, 0)!.fields)).toEqual(["time", "author", "done"]);
	});
});

describe("unconvertibleReason", () => {
	test("accepts strings, finite numbers and booleans", () => {
		expect(unconvertibleReason({ author: "a", time: 1, done: false, author_note: "x" })).toBeUndefined();
	});

	test.each([
		[{ note: "a\nb" }, "line break"],
		[{ n: Infinity }, "finite"],
		[{ o: { x: 1 } }, "string, number or true/false"],
		[{ l: [1] }, "string, number or true/false"],
		[{ z: null }, "string, number or true/false"],
		[{ "bad key": "x" }, "field name"],
	])("rejects %j", (fields, reason) => {
		expect(unconvertibleReason(fields as any)).toContain(reason);
	});
});
```

- [ ] **Step 3: Run the tests to confirm they fail.**

Run: `bun run test -- tests/attributes.test.ts`
Expected: FAIL with "Cannot find module '../src/editor/base/edit-util/attributes'".

- [ ] **Step 4: Write the implementation.** Create `src/editor/base/edit-util/attributes.ts` (CRLF):

```ts
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

		fields[SHORTHAND_KEYS[key[0]] ?? key[0]] = value;
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
		if (!KEY_FULL.test(key)) return `field name "${key}" cannot be written as an attribute`;
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
```

- [ ] **Step 5: Run the tests to confirm they pass.**

Run: `bun run test -- tests/attributes.test.ts`
Expected: PASS (every test).

- [ ] **Step 6: Commit.**

```bash
bun run format
git add src/editor/base/edit-util/attributes.ts tests/attributes.test.ts
git commit -m "feat(metadata): attribute block grammar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Range model location refactor (legacy only, no behaviour change except `length`/`empty`)

The model change, with only the legacy syntax wired up, so that the 1,439 existing tests prove the refactor before attributes exist.

**Files:**
- Modify: `src/types.ts` (add `MetadataSyntax`)
- Modify: `src/editor/base/ranges/base_range.ts`
- Modify: `src/editor/base/ranges/types/{addition,deletion,highlight,comment,substitution}_range.ts`
- Modify: `src/editor/base/edit-util/range-parser.ts:16-35,122-145`
- Modify: the closer sites `src/editor/renderers/live-preview/markup-renderer.ts:39,52-54`, `src/editor/uix/extensions/range-correcter.ts:53`, `src/editor/uix/extensions/editing-modes/comment-mode.ts:33`, `src/editor/uix/extensions/editing-modes/edit-mode.ts:78`
- Modify: `src/editor/renderers/gutters/annotations-gutter/marker.ts:84`, `src/editor/renderers/live-preview/comment-widget.ts:153`
- Test: `tests/range_metadata.test.ts`, `tests/resolve_rendering.test.ts:71`, new `tests/range_model.test.ts`

**Interfaces:**
- Produces:
  - `type MetadataSyntax = "legacy" | "attributes"` (in `src/types.ts`)
  - `type MetaLocation = { syntax: MetadataSyntax; from: number; to: number }` (exported from `base_range.ts` and re-exported via `ranges/index.ts` if that file uses `export *`; check)
  - `CriticMarkupRange.meta?: MetaLocation`. Legacy: `from` = after the opener, `to` = after `@@`. Attributes: the block's span.
  - `CriticMarkupRange.own_fields: MetadataFields` (written fields)
  - `get fields(): MetadataFields` (effective; equals `own_fields` until Task 4)
  - `get closer_to(): number` (end of the closing bracket)
  - `constructRange(from, to, type, text, middle?, meta?: MetaLocation)`

- [ ] **Step 1: Write the failing tests.** Create `tests/range_model.test.ts`:

```ts
import { DEFAULT_SETTINGS } from "../src/constants";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import type { SubstitutionRange } from "../src/editor/base/ranges";

const parse = (doc: string) => getRangesInText(doc, { ...DEFAULT_SETTINGS, enable_metadata: true });

describe("range model (legacy metadata)", () => {
	test("meta covers the JSON and its @@", () => {
		const doc = `x{++{"author":"A"}@@ab++}y`;
		const [range] = parse(doc);
		expect(range.meta).toEqual({ syntax: "legacy", from: 4, to: doc.indexOf("ab") });
		expect(range.own_fields).toEqual({ author: "A" });
		expect(range.fields).toEqual({ author: "A" });
		expect(range.closer_to).toBe(range.to);
	});

	test("length and empty() ignore metadata", () => {
		const [filled] = parse(`{++{"author":"A"}@@ab++}`);
		expect(filled.length).toBe(2);
		expect(filled.empty()).toBe(false);
		const [empty] = parse(`{>>{"author":"A"}@@<<}`);
		expect(empty.length).toBe(0);
		expect(empty.empty()).toBe(true);
	});

	test("an empty substitution with metadata is empty", () => {
		const [range] = parse(`{~~{"author":"A"}@@~>~~}`) as SubstitutionRange[];
		expect(range.empty()).toBe(true);
		expect(range.part_is_empty(true)).toBe(true);
		expect(range.part_is_empty(false)).toBe(true);
	});

	test("apply_offset moves meta without touching a copy", () => {
		const [range] = parse(`{++{"author":"A"}@@ab++}`);
		const copy = range.copy();
		range.apply_offset(5);
		expect(range.meta!.from).toBe(copy.meta!.from + 5);
		expect(copy.meta!.from).toBe(3);
	});
});
```

- [ ] **Step 2: Run them to confirm they fail.**

Run: `bun run test -- tests/range_model.test.ts`
Expected: FAIL (`meta` undefined; `length` 2 + JSON length).

- [ ] **Step 3: Add `MetadataSyntax` to `src/types.ts`** near the other exported types:

```ts
/** How range metadata is written: `{json}@@` inside the opener, or a trailing `{key=value}` attribute block. */
export type MetadataSyntax = "legacy" | "attributes";
```

- [ ] **Step 4: Rework `base_range.ts`.** The changes:

1. Import: `import { type MetadataSyntax, PreviewMode, RANGE_CURSOR_MOVEMENT_OPTION } from "../../../types";` and `import { SHORTHAND_KEYS } from "../edit-util/attributes";`. Delete the local `shortHandMapping`, and replace its two uses with `SHORTHAND_KEYS`.
2. Add, after `MetadataFields`:

```ts
/**
 * Where a range's metadata is written. Legacy: `{json}@@` just inside the opener (`from` is after the opener,
 * `to` after `@@`). Attributes: the `{key=value}` block just after the closer.
 */
export type MetaLocation = { syntax: MetadataSyntax; from: number; to: number };
```

3. Replace the field `fields: MetadataFields = {};` with:

```ts
	/** The metadata this range's own markup states. The only thing writers serialise. */
	own_fields: MetadataFields = {};
```

and add a getter beside `base_range`:

```ts
	/** The metadata in effect for this range: its own, plus anything the thread rules let it inherit. */
	get fields(): MetadataFields {
		return this.own_fields;
	}
```

4. Constructor: replace the parameter `public metadata?: number` with `public meta?: MetaLocation`, and replace the body with:

```ts
		if (meta?.syntax === "legacy") {
			const json = text.slice(3, meta.to - 2 - from);
			this.text = text.slice(0, 3) + text.slice(meta.to - from);
			try {
				// TODO: JS can be injected here, possible security risk
				this.own_fields = JSON.parse(json);
				for (const key in this.own_fields) {
					if (key in SHORTHAND_KEYS) {
						this.own_fields[SHORTHAND_KEYS[key]] = this.own_fields[key];
						delete this.own_fields[key];
					}
				}
			} catch (e) {
				// TODO: Mark as invalid markdown (this can happen when separator @@ exists, but {} is not given
				this.own_fields = {};
			}
		}
```

(The attributes branch arrives in Task 3.)

5. Add `closer_to` beside `length`, and fix `length`:

```ts
	/** End of the closing bracket: `to`, minus a trailing attribute block if there is one. */
	get closer_to(): number {
		return this.meta?.syntax === "attributes" ? this.meta.from : this.to;
	}

	/** Length of the content, without brackets or metadata of either syntax. */
	get length() {
		return this.closer_to - 3 - this.range_start;
	}
```

6. `range_start` → `return this.meta?.syntax === "legacy" ? this.meta.to : this.from + 3;`
   `range_front` → `return this.meta?.syntax === "legacy" ? this.meta.to - 3 : this.from;`
   Update both doc comments to mention that the legacy case is the only one with metadata ahead of the content.
7. `remove_metadata()`:

```ts
	remove_metadata(): EditorChange[] {
		if (!this.meta) return [];
		return [{ from: this.meta.from, to: this.meta.to, insert: "" }];
	}
```

8. `delete_metadata` and `add_metadata`: replace every `this.fields` with `this.own_fields`.
9. `set_metadata` (legacy only for now; Task 5 adds attributes):

```ts
	set_metadata(fields: MetadataFields): EditorChange[] {
		this.own_fields = fields;
		const blob = JSON.stringify(fields) + "@@";
		if (this.meta) return [{ from: this.meta.from, to: this.meta.to, insert: blob }];
		return [{ from: this.from + 3, to: this.from + 3, insert: blob }];
	}
```

10. `empty()` → `return this.range_start === this.closer_to - 3;`
11. `cursor_move_inside`: `Math.max(skip_metadata ? this.range_start : this.from + 3, cursor)` and `this.closer_to - 3`.
12. `cursor_pass_syntax`: `cursor = skip_metadata ? this.range_start : this.from + 3;` and `cursor = this.closer_to - 3;`.
13. `touches_left_bracket`: `((include_metadata && this.meta) ? this.range_start : this.from + 3)`.
14. `touches_right_bracket`: `cursor - (inside_loose ? 0 : 1) >= this.closer_to - 3 && …`. Leave the upper bound `this.to`, so a trailing block counts as part of the closing bracket zone.
15. `apply_offset`: **replace the object, never mutate it.** `copy()` is shallow, so copies share `meta`:

```ts
		if (this.meta) this.meta = { ...this.meta, from: this.meta.from + offset, to: this.meta.to + offset };
```

16. `split_range`:

```ts
		return [
			this.text.slice(-3),
			this.text.slice(0, 3) + (this.meta?.syntax === "legacy" ? JSON.stringify(this.own_fields) + "@@" : ""),
		];
```

- [ ] **Step 5: Subclasses.** In `addition_range.ts`, `deletion_range.ts`, `highlight_range.ts` and `comment_range.ts`, change the constructor parameter `metadata?: number` to `meta?: MetaLocation` (importing `type MetaLocation` from `../base_range`) and pass `meta` to `super`. In `substitution_range.ts`:
- the constructor the same way;
- `length` → `return this.closer_to - 3 - this.range_start - 2;`
- `cursor_pass_syntax`: `cursor = skip_metadata ? this.range_start : this.from + 3;` and `cursor = this.closer_to - 3;`
- `empty()` → `return this.range_start === this.middle && this.middle + 2 === this.closer_to - 3;`
- `part_is_empty` → `return left ? this.range_start === this.middle : this.middle + 2 === this.closer_to - 3;`
- `apply_offset`: the same object-replacing line as base.

- [ ] **Step 6: Parser.** In `range-parser.ts`:

```ts
function constructRangeFromSyntaxNode(
	settings: PluginSettings,
	range: SyntaxNode,
	text: string,
	offset = 0,
	to = range.to + offset,
) {
	const from = range.from + offset;
	const legacy = settings.enable_metadata && !!range.firstChild?.type.name.startsWith("MDSep");
	// EXPL: The MDSep node starts at the `@@`, so the JSON lies between the opener and it.
	const meta: MetaLocation | undefined = legacy ?
		{ syntax: "legacy", from: from + 3, to: range.firstChild!.from + offset + 2 } :
		undefined;
	let middle = undefined;
	if (range.type.name === "Substitution") {
		const child = legacy ? range.firstChild?.nextSibling : range.firstChild;
		if (!child || child.type.name !== "MSub") return;
		middle = child.from + offset;
	}

	return constructRange(from, to, range.type.name, text.slice(from, to), middle, meta);
}
```

Then change `constructRange`'s last parameter to `meta?: MetaLocation` and pass it through every `new …Range(…)`. Import `type MetaLocation` from `../ranges`.

- [ ] **Step 7: Closer and metadata call sites.**
- `markup-renderer.ts:39`: `hideMarkupDecoration.range(range.closer_to - 3, range.closer_to)`.
- `markup-renderer.ts:52-54`:

```ts
	if (!range.meta || show_metadata) return;

	decorations.push(hideMarkupDecoration.range(range.meta.from, range.meta.to));
```

- `range-correcter.ts:53`: `to: start_range.closer_to - 3,`
- `comment-mode.ts:33`: `range.range_start <= fromA && toA <= range.closer_to - 3)`
- `edit-mode.ts:78`: `if (cursor !== range.closer_to - 3)`
- `marker.ts:84` and `comment-widget.ts:153`: `range.metadata` → `range.meta`.
- Run `grep -rn "\.metadata\b" src | grep -v "settings\.\|_metadata"`. Expected output: nothing.

- [ ] **Step 8: Update existing tests that read `.metadata`.**
- `tests/range_metadata.test.ts:18`: `expect(changes).toEqual([{ from: range.meta!.from, to: range.meta!.to, insert: "" }]);`
- `tests/range_metadata.test.ts:25`: `set_metadata` now replaces the whole blob:
  `expect(changes).toEqual([{ from: range.meta!.from, to: range.meta!.to, insert: `{"author":"A"}@@` }]);`
- `tests/resolve_rendering.test.ts:71`: read the surrounding test, then express the same expectation through `meta`. A whole-blob replacement is now `{ from: highlight.meta!.from, to: highlight.meta!.to, insert: <json>+"@@" }`.

- [ ] **Step 9: Run the full suite and the build.**

Run: `bun run test && bun run build`
Expected: all tests pass, including the 4 new ones, and tsc is clean. If a test fails because it asserted a legacy range's `length` or `empty()` *including* the JSON, that assertion encoded the latent bug the spec fixes. Update it and say so in the commit body.

- [ ] **Step 10: Commit.**

```bash
bun run format
git add -A src tests
git commit -m "refactor(ranges): meta location, own_fields/fields, closer_to

length and empty() no longer count legacy metadata (latent bug).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Read trailing attribute blocks

**Files:**
- Modify: `src/editor/base/ranges/base_range.ts` (constructor attributes branch)
- Modify: `src/editor/base/edit-util/range-parser.ts` (`constructRangeFromSyntaxNode`, `cursorGenerateRanges`)
- Modify: `src/editor/base/edit-util/range-state.ts:68-84`
- Test: `tests/range_parser.test.ts`, `tests/original_text.test.ts`, `tests/copy_strip.test.ts`, `tests/range_state_fuzz.test.ts`

**Interfaces:**
- Consumes: `parseAttrBlock` (Task 1); `MetaLocation`, `closer_to` (Task 2)
- Produces: ranges whose `to` includes a trailing block; `meta.syntax === "attributes"`

- [ ] **Step 1: Write the failing parser tests.** Append to `tests/range_parser.test.ts`:

```ts
describe("trailing attribute blocks", () => {
	const meta = (doc: string) => rangesOf(doc, true);

	test("extend the range and become its fields", () => {
		const doc = `a {++new++}{author="Bea" time=5} b`;
		const [range] = meta(doc);
		expect([range.from, range.closer_to, range.to]).toEqual([2, 11, doc.indexOf(" b")]);
		expect(range.meta).toEqual({ syntax: "attributes", from: 11, to: doc.indexOf(" b") });
		expect(range.fields).toEqual({ author: "Bea", time: 5 });
		expect(range.unwrap()).toBe("new");
		expect(range.text).toBe("{++new++}");
	});

	test("are not read when metadata is disabled", () => {
		const [range] = rangesOf(`{++new++}{author=Bea}`, false);
		expect(range.to).toBe(9);
		expect(range.meta).toBeUndefined();
	});

	test("keep a highlight and its comment adjacent, so the comment is a reply", () => {
		const doc = `{==some==}{>>note<<}{author=Andrew time=1}`;
		const [highlight, comment] = meta(doc);
		expect(comment.base_range).toBe(highlight);
		expect(highlight.replies).toEqual([comment]);
	});

	test("chain through a thread", () => {
		const doc = `{==x==}{done=true}{>>c<<}{author=A}{>>r<<}{author=B}`;
		const ranges = meta(doc);
		expect(ranges.map(r => r.type)).toEqual([
			SuggestionType.HIGHLIGHT,
			SuggestionType.COMMENT,
			SuggestionType.COMMENT,
		]);
		expect(ranges[0].replies.length).toBe(2);
		expect(ranges[0].own_fields).toEqual({ done: true });
	});

	test("a substitution keeps its separator", () => {
		const [range] = meta(`{~~old~>new~~}{author=A}`) as SubstitutionRange[];
		expect(range.unwrap_parts()).toEqual(["old", "new"]);
		expect(range.closer_to).toBe(14);
	});

	test("a range with legacy metadata does not take a trailing block", () => {
		const doc = `{=={"author":"A"}@@t==}{author=B}`;
		const [range] = meta(doc);
		expect(range.meta!.syntax).toBe("legacy");
		expect(range.to).toBe(doc.indexOf("{author=B}"));
	});

	test("an invalid block is ordinary text", () => {
		for (const doc of ["{++a++}{}", "{++a++}{author}", "{++a++}{.c a=1}", "{++a++} {a=1}"]) {
			const [range] = meta(doc);
			expect(range.to).toBe(7);
			expect(range.meta).toBeUndefined();
		}
	});

	// EXPL: Spec pre-fork caveat. The grammar scans the block's text and can open a range inside a quoted value;
	//       the parser re-parses after the block instead of trusting that node.
	test("an opener inside a quoted value is not a range", () => {
		const doc = `{++a++}{author="{++x"} after {--gone--}`;
		const ranges = meta(doc);
		expect(ranges.map(r => [r.type, r.from])).toEqual([
			[SuggestionType.ADDITION, 0],
			[SuggestionType.DELETION, doc.indexOf("{--")],
		]);
		expect(ranges[0].fields).toEqual({ author: "{++x" });
	});

	// EXPL: Decision 5 in the plan. Literal `{k=v}` prose directly after a range reads as that range's metadata.
	//       Documented limitation, pinned so a change to it is deliberate.
	test("literal {k=v} right after a range is read as metadata", () => {
		const [range] = meta(`{++a++}{width=3} px`);
		expect(range.fields).toEqual({ width: 3 });
	});
});
```

- [ ] **Step 2: Run them to confirm they fail.**

Run: `bun run test -- tests/range_parser.test.ts`
Expected: the new tests FAIL (`to` stops at the closer).

- [ ] **Step 3: Constructor attributes branch.** In `base_range.ts`, add `parseAttrBlock` to the `../edit-util/attributes` import, and add after the legacy branch:

```ts
		else if (meta?.syntax === "attributes") {
			this.own_fields = parseAttrBlock(text, meta.from - from)?.fields ?? {};
			this.text = text.slice(0, meta.from - from);
		}
```

- [ ] **Step 4: Parser reads the block.** In `constructRangeFromSyntaxNode`, after computing `meta` for legacy, add:

```ts
	let end = to;
	let location = meta;
	// EXPL: A trailing attribute block sits outside the grammar's node, right after the closer. A range with legacy
	//       metadata never takes one (one range, one syntax).
	if (settings.enable_metadata && !legacy) {
		const block = parseAttrBlock(text, to);
		if (block) {
			location = { syntax: "attributes", from: block.from, to: block.to };
			end = block.to;
		}
	}
```

and return `constructRange(from, end, range.type.name, text.slice(from, end), middle, location);`. Import `parseAttrBlock` from `./attributes`.

- [ ] **Step 5: `cursorGenerateRanges`.** Inside the `do { … }` loop, right after the `"⚠"` check:

```ts
			// EXPL: The grammar does not know attribute blocks and scans their text, so a quoted value such as
			//       `author="{++x"` can open a node inside the previous range's block. Such a node is not a range;
			//       re-parse from the end of the block instead of trusting the grammar past it.
			if (previous_range?.meta?.syntax === "attributes" && range.from + offset < previous_range.to) {
				resume = previous_range.to;
				break;
			}
```

and change the malformed-node resume so that it lands after a block: `resume = new_range ? new_range.to : range.from + offset + 3;`.

- [ ] **Step 6: Run the parser tests.**

Run: `bun run test -- tests/range_parser.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing incremental test.** In `tests/range_state_fuzz.test.ts`:
- add to `SEGMENTS`: `"{++added++}{author=A time=1}"`, `"{==x==}{>>c<<}{author=\"B b\" time=2}"`, `"{~~o~>n~~}{done=true}"`;
- add `"}"`, `"{a=1}"` and `"="` to `INSERTS`;
- append a second `describe`. Import `getRangesInText` from `../src/editor/base/edit-util/range-parser` and `DEFAULT_SETTINGS` from `../src/constants`.

```ts
// EXPL: Review focus 1. The incremental parser must agree with a fresh parse after every edit, including edits
//       inside, at the edge of, and right after an attribute block, which lies past the grammar node.
describe("fuzz: incremental parse equals a full parse", () => {
	test("for random edits over documents with attribute blocks", () => {
		const rng = mulberry32(0xB10C);
		const pick = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
		const spans = (doc: string, ranges: { from: number; to: number; type: unknown }[]) =>
			JSON.stringify(ranges.map(r => [r.type, r.from, r.to]));
		const failures: string[] = [];
		for (let seq = 0; seq < 500 && failures.length < 3; seq++) {
			let doc = Array.from({ length: 6 + Math.floor(rng() * 6) }, () => pick(SEGMENTS)).join("");
			let state = createRangeState(doc);
			const edits: unknown[] = [];
			for (let i = 0; i < EDITS_PER_SEQUENCE; i++) {
				const from = Math.floor(rng() * (state.doc.length + 1));
				const is_insert = rng() < 0.7;
				const to = is_insert ? from : Math.min(state.doc.length, from + 1 + Math.floor(rng() * 4));
				const insert = is_insert ? pick(INSERTS) : "";
				edits.push({ from, to, insert });
				state = state.update({ changes: { from, to, insert } }).state;
				doc = state.doc.toString();
				const incremental = spans(doc, state.field(rangeParser).ranges.ranges);
				const full = spans(doc, getRangesInText(doc, { ...DEFAULT_SETTINGS }));
				if (incremental !== full) {
					failures.push(`doc=${JSON.stringify(doc)} edits=${JSON.stringify(edits)}`);
					break;
				}
			}
		}
		expect(failures).toEqual([]);
	});
});
```

- [ ] **Step 8: Run it to confirm it fails.**

Run: `bun run test -- tests/range_state_fuzz.test.ts`
Expected: FAIL with an example whose edit lands inside a block. (If the first failure has **no** attribute block in its doc, it is a pre-existing divergence. Stop and report it rather than widening this task.)

- [ ] **Step 9: Regenerate from each invalidated range's start.** In `range-state.ts`, inside `for (const changed_range of changed_ranges)`:

```ts
			// EXPL: A trailing attribute block lies past the grammar node that ends at the range's closer, so an
			//       edit inside the block is not reached by regenerating from `fromB`. Regenerate from the start of
			//       every range the edit invalidated instead.
			let regenerate_from = changed_range.fromB;
			value.ranges.tree
				.search([changed_range.fromA, changed_range.toA], (range: CriticMarkupRange, key: Interval) => {
					value.ranges.tree.remove(key, range);
					deleted_ranges.add(range);
					for (const reply of range.base_range.thread)
						dangling_comments.set(reply.from, reply);
					regenerate_from = Math.min(regenerate_from, tr.changes.mapPos(range.from, -1));
					return true;
				});

			for (const range of cursorGenerateRanges(tree, text, settings, regenerate_from, changed_range.toB))
				inserted_set.set(range.from, range);
```

- [ ] **Step 10: Run the fuzz tests.**

Run: `bun run test -- tests/range_state_fuzz.test.ts`
Expected: PASS, with both describes clean.

- [ ] **Step 11: Whole-range operations.** Append to `tests/original_text.test.ts`:

```ts
describe("attribute blocks", () => {
	test("toOriginalText strips them with their ranges", () => {
		expect(toOriginalText(`This is {==some==}{>>note<<}{author=Andrew time=1} text`)).toBe("This is some text");
		expect(toOriginalText(`a {++b++}{author=A} c{--d--}{author=B}`)).toBe("a cd");
		expect(toOriginalText(`x{~~old~>new~~}{author=A}y`)).toBe("xoldy");
	});

	test("hasCriticMarkup sees ranges with blocks", () => {
		expect(hasCriticMarkup(`{++b++}{author=A}`)).toBe(true);
	});
});
```

Append to `tests/copy_strip.test.ts`:

```ts
	test("drops attribute blocks with their ranges", () => {
		expect(copy(`This is {==some==}{>>note<<}{author=Andrew time=1} text`)).toBe("This is some text");
		expect(copy(`a{++b++}{author=A}c`)).toBe("abc");
	});
```

Also add accept and reject to `tests/range_parser.test.ts` inside the new describe:

```ts
	test("accept and reject replace the whole span, block included", () => {
		const doc = `a{++b++}{author=A}c{--d--}{author=B}e{~~f~>g~~}{author=C}h`;
		const ranges = meta(doc);
		const apply = (fn: (r: typeof ranges[0]) => string) => applyToText(doc, fn, ranges);
		expect(apply(r => r.accept())).toBe("abceg" + "h");
		expect(apply(r => r.reject())).toBe("acdefh");
	});
```

(Add `import { applyToText } from "../src/editor/base/edit-util/range-operations";` at the top.)

- [ ] **Step 12: Run the suite.**

Run: `bun run test && bun run build`
Expected: PASS. If the `copy_strip` case fails, open `src/editor/base/edit-handler/copy.ts`; any `to - 3` or metadata arithmetic there must move to `closer_to`/`meta`. Note the site in the commit body.

- [ ] **Step 13: Commit.**

```bash
bun run format
git add -A src tests
git commit -m "feat(metadata): read trailing attribute blocks

Ranges include their block; the parser re-parses after a block the grammar
misread, and incremental regeneration starts at each invalidated range.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Thread rules on read

**Files:**
- Modify: `src/editor/base/ranges/base_range.ts` (export `INHERITED_KEYS`; `postprocess` comment)
- Modify: `src/editor/base/ranges/types/highlight_range.ts`, `comment_range.ts`
- Modify: `src/ui/pages/annotations-view/AnnotationThread.svelte:64`
- Test: new `tests/thread_rules.test.ts`

**Interfaces:**
- Produces:
  - `INHERITED_KEYS: readonly ["author", "time"]`
  - `HighlightRange.fields`: `own_fields` plus the first comment's `author`/`time` for keys the anchor does not state
  - reply `CommentRange.fields`: `own_fields` minus `done`

- [ ] **Step 1: Write the failing tests.** Create `tests/thread_rules.test.ts`:

```ts
import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { thread_resolved } from "../src/editor/base/edit-logic/resolve";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import { createRangeState } from "./helpers";

const parse = (doc: string) => getRangesInText(doc, { ...DEFAULT_SETTINGS, enable_metadata: true });

describe("a highlight anchor inherits authorship from its first comment", () => {
	test("attributes: an anchor with no block takes author and time", () => {
		const [anchor, comment] = parse(`{==some==}{>>note<<}{author=Andrew time=1}`);
		expect(anchor.own_fields).toEqual({});
		expect(anchor.fields).toEqual({ author: "Andrew", time: 1 });
		expect(comment.fields).toEqual({ author: "Andrew", time: 1 });
	});

	test("stated fields win, and only author/time inherit", () => {
		const [anchor] = parse(`{==x==}{author=Bea done=true}{>>c<<}{author=A time=1 style=s}`);
		expect(anchor.fields).toEqual({ time: 1, author: "Bea", done: true });
	});

	test("legacy: an anchor that states nothing now shows its first comment's author (spec compatibility note)", () => {
		const [anchor] = parse(`{==x==}{>>{"author":"A","time":1}@@c<<}`);
		expect(anchor.fields).toEqual({ author: "A", time: 1 });
	});

	test("mixed: a legacy anchor inherits from an attributes comment", () => {
		const [anchor] = parse(`{=={"done":true}@@x==}{>>c<<}{author=A}`);
		expect(anchor.fields).toEqual({ author: "A", done: true });
	});

	test("only the first comment counts, and replies never inherit", () => {
		const [anchor, first, reply] = parse(`{==x==}{>>c<<}{author=A}{>>r<<}`);
		expect(anchor.fields.author).toBe("A");
		expect(reply.fields).toEqual({});
		expect(first.fields).toEqual({ author: "A" });
	});

	test("suggestion anchors and lone highlights do not inherit", () => {
		expect(parse(`{++x++}{>>c<<}{author=A}`)[0].fields).toEqual({});
		expect(parse(`{==x==}`)[0].fields).toEqual({});
	});

	test("inheritance follows incremental thread reconstruction", () => {
		let state = createRangeState(`{==x==}{>>c<<}{author=A}`);
		// EXPL: Position 10 is just before `c`, inside the comment's content.
		state = state.update({ changes: { from: 10, insert: "z" } }).state;
		const [anchor] = state.field(rangeParser).ranges.ranges;
		expect(anchor.fields.author).toBe("A");
	});
});

describe("thread state lives on the base", () => {
	test("done on a reply is ignored", () => {
		const [anchor, , reply] = parse(`{==x==}{>>c<<}{author=A}{>>r<<}{author=B done=true}`);
		expect(reply.own_fields.done).toBe(true);
		expect(reply.fields.done).toBeUndefined();
		expect(thread_resolved(anchor)).toBe(false);
	});

	test("done on an unanchored thread's first comment is kept", () => {
		const [base] = parse(`{>>c<<}{done=true}{>>r<<}`);
		expect(base.fields.done).toBe(true);
		expect(thread_resolved(base)).toBe(true);
	});
});
```

- [ ] **Step 2: Run them to confirm they fail.**

Run: `bun run test -- tests/thread_rules.test.ts`
Expected: FAIL (anchor `fields` is `{}`; the reply still shows `done`).

- [ ] **Step 3: Implement.** In `base_range.ts`, export:

```ts
// EXPL: Thread rule 2: the only fields a HIGHLIGHT anchor takes from its first comment.
export const INHERITED_KEYS = ["author", "time"] as const;
```

In `highlight_range.ts`:

```ts
import { CriticMarkupRange, INHERITED_KEYS, type MetadataFields, type MetaLocation } from "../base_range";
// …
	// EXPL: Thread rule 2 (spec "Thread rules"): an anchor that does not state author/time takes its first
	//       comment's. Computed on read so it holds however the thread was assembled (full or incremental parse).
	get fields(): MetadataFields {
		const first = this.replies[0];
		if (!first) return this.own_fields;
		const inherited: MetadataFields = {};
		for (const key of INHERITED_KEYS) {
			if (!(key in this.own_fields) && first.own_fields[key] !== undefined)
				inherited[key] = first.own_fields[key];
		}
		return Object.keys(inherited).length ? { ...inherited, ...this.own_fields } : this.own_fields;
	}
```

In `comment_range.ts`:

```ts
	// EXPL: Thread rule 1: `done` lives on the thread's base. A reply's copy (written by older versions) is ignored.
	get fields(): MetadataFields {
		if (!this.attached_comment || !("done" in this.own_fields)) return this.own_fields;
		const { done: _, ...rest } = this.own_fields;
		return rest;
	}
```

In `base_range.ts`'s `postprocess`, rewrite the EXPL comment so that it no longer says "resolve writes `done` to every thread member". A highlight is always its thread's base, so its own `fields.done` is the thread's state.

In `AnnotationThread.svelte:64`, replace `row.range.fields.done` with `thread_resolvable(row.range) && thread_resolved(row.range)`, importing both from the same module the file's siblings use (`../../../editor/base`, or check `filter-ranges.ts`'s import path).

- [ ] **Step 4: Run the suite.**

Run: `bun run test && bun run build`
Expected: PASS. Any existing test that asserted `done` on a reply's `fields` encoded rule 1's opposite. Update it to read `own_fields` and mention it in the commit.

- [ ] **Step 5: Commit.**

```bash
bun run format
git add -A src tests
git commit -m "feat(metadata): thread rules on read (anchor inherits authorship, done on base)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Syntax-aware writers and the `metadata_syntax` setting

**Files:**
- Modify: `src/types.ts`, `src/constants.ts` (setting)
- Modify: `src/editor/base/edit-util/metadata.ts` (`write_syntax`)
- Modify: `src/editor/base/ranges/base_range.ts` (`set_metadata`, `add_metadata`, `delete_metadata`, `split_range`)
- Modify: `src/editor/base/edit-util/range-create.ts`
- Modify: `src/editor/base/edit-logic/resolve.ts` (`range_source_with_fields`)
- Test: `tests/range_metadata.test.ts`, new `tests/range_create.test.ts`, `tests/resolve.test.ts`

**Interfaces:**
- Consumes: `serializeAttrBlock` (Task 1); `meta`, `closer_to`, `own_fields` (Task 2)
- Produces:
  - `PluginSettings.metadata_syntax: MetadataSyntax`, default `"legacy"`
  - `write_syntax(setting: MetadataSyntax, ...ranges: (CriticMarkupRange | undefined)[]): MetadataSyntax`: `"attributes"` if the setting or any given range is attributes, else `"legacy"`
  - `set_metadata(fields, syntax?: MetadataSyntax)`, `add_metadata(key, value, syntax?)`, `delete_metadata(key, syntax?)`. `syntax` defaults to the range's current syntax, else `"legacy"`.
  - `construct_range(inserted, deleted, type, metadata_fields?, start_offset = 0, end_offset = 0, syntax: MetadataSyntax = "legacy")`; `construct_suggestion(…, syntax = "legacy")`, same order
  - `create_range` / `create_suggestion` write in `settings.metadata_syntax`
  - `range_source_with_fields(range, fields, syntax: MetadataSyntax = range.meta?.syntax ?? "legacy")`

- [ ] **Step 1: Write the failing tests.** Append to `tests/range_metadata.test.ts`:

```ts
describe("set_metadata by syntax", () => {
	const apply = (doc: string, changes: { from: number; to: number; insert: string }[]) =>
		[...changes].sort((a, b) => b.from - a.from)
			.reduce((out, c) => out.slice(0, c.from) + c.insert + out.slice(c.to), doc);

	test("attributes range rewrites its block in place", () => {
		const doc = `x{++a++}{author=A}y`;
		const range = parseFirstRange(doc);
		expect(apply(doc, range.add_metadata("done", true))).toBe(`x{++a++}{author=A done=true}y`);
	});

	test("a range without metadata gets a block after its closer when asked", () => {
		const doc = `x{~~a~>b~~}y`;
		const range = parseFirstRange(doc);
		expect(apply(doc, range.set_metadata({ author: "A" }, "attributes"))).toBe(`x{~~a~>b~~}{author=A}y`);
	});

	test("touch-to-migrate: a legacy range rewritten as attributes loses its JSON", () => {
		const doc = `x{++{"author":"A"}@@a++}y`;
		const range = parseFirstRange(doc);
		expect(apply(doc, range.add_metadata("done", true, "attributes"))).toBe(`x{++a++}{author=A done=true}y`);
	});

	test("an attributes range never silently reverts to legacy", () => {
		const doc = `x{++a++}{author=A}y`;
		const range = parseFirstRange(doc);
		expect(apply(doc, range.add_metadata("done", true))).toBe(`x{++a++}{author=A done=true}y`);
	});

	test("deleting the last attribute removes the block", () => {
		const doc = `x{++a++}{author=A}y`;
		const range = parseFirstRange(doc);
		expect(apply(doc, range.delete_metadata("author"))).toBe(`x{++a++}y`);
	});

	test("split_range puts the block after each half", () => {
		const range = parseFirstRange(`{++ab++}{author=A}`);
		expect(range.split_range(4)).toEqual([`++}{author=A}`, `{++`]);
	});
});
```

Create `tests/range_create.test.ts`:

```ts
import { DEFAULT_SETTINGS } from "../src/constants";
import { write_syntax } from "../src/editor/base/edit-util/metadata";
import { construct_range, create_range } from "../src/editor/base/edit-util/range-create";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import { SuggestionType } from "../src/editor/base/ranges";

const parse = (doc: string) => getRangesInText(doc, { ...DEFAULT_SETTINGS, enable_metadata: true });

describe("construct_range by syntax", () => {
	test("legacy puts the JSON after the opener and counts it in start_offset", () => {
		const { insert, start_offset } = construct_range("new", "", SuggestionType.ADDITION, { author: "A" });
		expect(insert).toBe(`{++{"author":"A"}@@new++}`);
		expect(start_offset).toBe(3 + `{"author":"A"}@@`.length);
	});

	test("attributes put the block after the closer and leave start_offset at the opener", () => {
		const { insert, start_offset, end_offset } = construct_range(
			"new",
			"old",
			SuggestionType.SUBSTITUTION,
			{ author: "A" },
			0,
			0,
			"attributes",
		);
		expect(insert).toBe(`{~~old~>new~~}{author=A}`);
		expect(start_offset).toBe(3);
		expect(end_offset).toBe(2);
	});

	test("no fields writes no block in either syntax", () => {
		expect(construct_range("x", "", SuggestionType.ADDITION, {}, 0, 0, "attributes").insert).toBe("{++x++}");
		expect(construct_range("x", "", SuggestionType.ADDITION, undefined, 0, 0, "attributes").insert).toBe("{++x++}");
	});

	test("create_range follows the setting and its output parses back", () => {
		const settings = { ...DEFAULT_SETTINGS, author: "Bea", metadata_syntax: "attributes" as const };
		const insert = create_range(settings, SuggestionType.COMMENT, "hi");
		expect(insert).toMatch(/^\{>>hi<<\}\{author=Bea time=\d+\}$/);
		const [range] = parse(insert);
		expect(range.to).toBe(insert.length);
		expect(range.fields.author).toBe("Bea");
	});
});

describe("write_syntax", () => {
	test("attributes if the setting or any range is attributes", () => {
		const [legacy] = parse(`{++{"author":"A"}@@a++}`);
		const [attrs] = parse(`{++a++}{author=A}`);
		expect(write_syntax("legacy")).toBe("legacy");
		expect(write_syntax("legacy", legacy)).toBe("legacy");
		expect(write_syntax("legacy", legacy, attrs)).toBe("attributes");
		expect(write_syntax("attributes", legacy)).toBe("attributes");
		expect(write_syntax("legacy", undefined)).toBe("legacy");
	});
});
```

Append to `tests/resolve.test.ts`:

```ts
describe("range_source_with_fields by syntax", () => {
	test("keeps an attributes range's syntax", () => {
		const [range] = topRanges(`{==x==}{author=A}`);
		expect(range_source_with_fields(range, { author: "A", done: true })).toBe(`{==x==}{author=A done=true}`);
	});

	test("writes the requested syntax", () => {
		const [range] = topRanges(`{=={"author":"A"}@@x==}`);
		expect(range_source_with_fields(range, { author: "A" }, "attributes")).toBe(`{==x==}{author=A}`);
		expect(range_source_with_fields(range, {}, "attributes")).toBe(`{==x==}`);
	});
});
```

- [ ] **Step 2: Run them to confirm they fail.**

Run: `bun run test -- tests/range_metadata.test.ts tests/range_create.test.ts tests/resolve.test.ts`
Expected: FAIL (`metadata_syntax` missing from settings, no syntax parameters).

- [ ] **Step 3: Setting.** In `src/types.ts`, inside `PluginSettings` after `add_color_metadata`:

```ts
	/**
	 * How Inkling writes metadata: legacy `{json}@@` inside the opener, or a trailing attribute block.
	 * Governs new ranges and ranges Inkling rewrites anyway (touch-to-migrate). Both are always read.
	 */
	metadata_syntax: MetadataSyntax;
```

In `src/constants.ts` `DEFAULT_SETTINGS`, after `add_color_metadata: false,`, add `metadata_syntax: "legacy",`.

- [ ] **Step 4: `write_syntax`** in `src/editor/base/edit-util/metadata.ts`:

```ts
/**
 * The syntax to write a range in: the setting's, except that a range already written with attribute blocks
 * stays that way. Converting back to legacy is an explicit command, never a side effect.
 */
export function write_syntax(setting: MetadataSyntax, ...ranges: (CriticMarkupRange | undefined)[]): MetadataSyntax {
	return setting === "attributes" || ranges.some(range => range?.meta?.syntax === "attributes") ?
		"attributes" :
		"legacy";
}
```

(Import `type MetadataSyntax` from `../../../types`.)

- [ ] **Step 5: Range writers.** In `base_range.ts`, import `serializeAttrBlock`, then:

```ts
	delete_metadata(key: string, syntax?: MetadataSyntax): EditorChange[] {
		if (key in SHORTHAND_KEYS) key = SHORTHAND_KEYS[key];
		if (!(key in this.own_fields))
			return [];
		const fields = { ...this.own_fields };
		delete fields[key];
		return this.set_metadata(fields, syntax);
	}

	add_metadata(key: string, value: unknown, syntax?: MetadataSyntax): EditorChange[] {
		return this.set_metadata({ ...this.own_fields, [key]: value }, syntax);
	}

	/**
	 * Rewrite this range's metadata as `fields` in `syntax` (default: its current syntax, else legacy). Moving between
	 * syntaxes removes the old form. Empty `fields` writes no metadata at all. The changes never overlap: the legacy
	 * blob lies inside the opener and the block after the closer.
	 */
	set_metadata(fields: MetadataFields, syntax: MetadataSyntax = this.meta?.syntax ?? "legacy"): EditorChange[] {
		this.own_fields = fields;
		const has_fields = Object.values(fields).some(value => value !== undefined);
		const legacy = this.meta?.syntax === "legacy" ? this.meta : undefined;
		const attributes = this.meta?.syntax === "attributes" ? this.meta : undefined;
		const changes: EditorChange[] = [];
		if (syntax === "legacy") {
			const blob = has_fields ? JSON.stringify(fields) + "@@" : "";
			if (legacy) changes.push({ from: legacy.from, to: legacy.to, insert: blob });
			else if (blob) changes.push({ from: this.from + 3, to: this.from + 3, insert: blob });
			if (attributes) changes.push({ from: attributes.from, to: attributes.to, insert: "" });
		} else {
			if (legacy) changes.push({ from: legacy.from, to: legacy.to, insert: "" });
			const block = has_fields ? serializeAttrBlock(fields) : "";
			if (attributes) changes.push({ from: attributes.from, to: attributes.to, insert: block });
			else if (block) changes.push({ from: this.closer_to, to: this.closer_to, insert: block });
		}
		return changes;
	}
```

Note: `delete_metadata` no longer calls `remove_metadata` for the last key. `set_metadata({})` produces the same removal, so the Task 2 test at `range_metadata.test.ts:18` must still pass. Run it.

`split_range`:

```ts
	split_range(cursor: number): [string, string] {
		const legacy = this.meta?.syntax === "legacy" ? JSON.stringify(this.own_fields) + "@@" : "";
		const block = this.meta?.syntax === "attributes" ? serializeAttrBlock(this.own_fields) : "";
		return [this.text.slice(-3) + block, this.text.slice(0, 3) + legacy];
	}
```

**Check `substitution_range.ts` `split_range`:** it prefixes `range[0]` (the closer side) with `~>`. With a block, `range[0]` is `~~}{…}`, and prefixing `~>` still yields `~>~~}{…}`. Correct, no change.

- [ ] **Step 6: `construct_range`.** In `range-create.ts`:

```ts
export function construct_range(
	inserted: string,
	deleted: string,
	type: SuggestionType,
	metadata_fields?: MetadataFields,
	start_offset = 0,
	end_offset = 0,
	syntax: MetadataSyntax = "legacy",
) {
	if (!type)
		return { insert: deleted + inserted, start_offset, end_offset };

	const brackets = CM_All_Brackets[type];
	const has_fields = !!metadata_fields && Object.values(metadata_fields).some(value => value !== undefined);
	// EXPL: Legacy metadata sits between the opener and the content, so it shifts every offset into the range.
	//       An attribute block sits after the closer and shifts nothing the caller measures.
	const prefix = has_fields && syntax === "legacy" ? JSON.stringify(metadata_fields) + "@@" : "";
	const suffix = has_fields && syntax === "attributes" ? serializeAttrBlock(metadata_fields!) : "";
	const output = brackets[0] + prefix +
		(type === SuggestionType.SUBSTITUTION ?
			deleted + brackets[1] + inserted + brackets[2] :
			deleted + inserted + brackets[1]) +
		suffix;
	start_offset += brackets[0].length + prefix.length;
	// FIXME: end may not be offset if the bracket appears after the end
	end_offset += type === SuggestionType.SUBSTITUTION ? brackets[1].length : 0;

	return { insert: output, start_offset, end_offset };
}
```

`construct_suggestion` gains a trailing `syntax: MetadataSyntax = "legacy"` and passes it on. `create_suggestion` and `create_range` pass `settings.metadata_syntax` as the `syntax` argument (with `0, 0` for the offsets). Behaviour change to note: legacy no longer writes `{"author":undefined}`-only blobs as `{}@@`, because `has_fields` ignores undefined values. Previously `JSON.stringify` gave `{}` and `Object.keys` counted the key, so `{}@@` was written. That was a bug.

- [ ] **Step 7: `range_source_with_fields`** in `resolve.ts`:

```ts
export function range_source_with_fields(
	range: CriticMarkupRange,
	fields: MetadataFields,
	syntax: MetadataSyntax = range.meta?.syntax ?? "legacy",
): string {
	if (!Object.values(fields).some(value => value !== undefined))
		return range.text;
	if (syntax === "attributes")
		return range.text + serializeAttrBlock(fields);
	return range.text.slice(0, 3) + JSON.stringify(fields) + "@@" + range.text.slice(3);
}
```

Update its doc comment: the source now covers the full range, block included, which matches the `from..to` it replaces.

- [ ] **Step 8: Run the suite.**

Run: `bun run test && bun run build`
Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
bun run format
git add -A src tests
git commit -m "feat(metadata): syntax-aware writers and metadata_syntax setting (default legacy)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: New ranges honour the setting (comment pairs, suggestion engine)

**Files:**
- Modify: `src/editor/base/edit-util/range-create.ts` (`create_anchored_comment`)
- Modify: `src/editor/base/edit-logic/add-comment.ts:78-82,294`
- Modify: `src/editor/base/edit-logic/mark.ts` (`mark_range`, `mark_ranges`, `mark_editor_ranges`)
- Modify: `src/editor/uix/extensions/editing-modes/suggestion-mode.ts:124` and the `mark_ranges` call it feeds
- Test: `tests/range_create.test.ts`, `tests/add_comment.test.ts`, `tests/mark_ranges.test.ts`, `tests/mark_ranges_fuzz.test.ts`

**Interfaces:**
- Consumes: `construct_range(…, syntax)`, `write_syntax` (Task 5)
- Produces:
  - `create_anchored_comment(settings: PluginSettings, anchor_text: string, comment_text: string): string`. Generates metadata once. Legacy: both ranges carry it. Attributes: only the comment does (rule 2).
  - `mark_ranges(ranges, text, from, to, inserted, type, metadata_fields?, force = false, syntax: MetadataSyntax = "legacy")`
  - `mark_range(…, metadata_fields?, syntax: MetadataSyntax = "legacy")`

- [ ] **Step 1: Write the failing tests.** Append to `tests/range_create.test.ts`:

```ts
describe("create_anchored_comment", () => {
	const at = (metadata_syntax: "legacy" | "attributes") => ({ ...DEFAULT_SETTINGS, author: "A", metadata_syntax });

	test("attributes: the anchor states nothing and inherits from the comment", () => {
		const insert = create_anchored_comment(at("attributes"), "sel", "hi");
		expect(insert).toMatch(/^\{==sel==\}\{>>hi<<\}\{author=A time=\d+\}$/);
		const [anchor, comment] = parse(insert);
		expect(anchor.own_fields).toEqual({});
		expect(anchor.fields).toEqual(comment.fields);
	});

	test("legacy: both carry the same fields (rule 2 is attributes-only)", () => {
		const insert = create_anchored_comment(at("legacy"), "sel", "");
		const [anchor, comment] = parse(insert);
		expect(anchor.own_fields).toEqual(comment.own_fields);
		expect(anchor.own_fields.author).toBe("A");
	});
});
```

(Add `create_anchored_comment` to the import.)

In `tests/add_comment.test.ts`, find the existing test for the anchored "add comment" flow (the `addCommentToView` path that writes `{==sel==}{>><<}` and places the caret). Copy it as a new test with settings `{ metadata_syntax: "attributes" }`, and assert that the caret sits immediately before the comment's `<<}`:

```ts
	// EXPL: Review focus 3. The caret used to be `insert.length - 3`, which lands inside the attribute block.
	expect(state.selection.main.head).toBe(state.doc.toString().lastIndexOf("<<}"));
```

Follow the file's existing helper for building the editor and dispatching the command. Do not invent a new harness.

In `tests/mark_ranges.test.ts`, find the existing helper (`mark(…)`, which applies changes in descending order) and the tests that type into an empty document and that extend an existing addition. Add attributes counterparts that pass `syntax: "attributes"` through to `mark_ranges` (extending the helper with an optional parameter if needed):

```ts
describe("attributes syntax", () => {
	test("typing creates an addition with a trailing block and the caret after the typed text", () => {
		// doc "ab", insert "X" at 1, ADDITION, fields { author: "A" }, syntax "attributes"
		// expect doc `a{++X++}{author=A}b` and selection head at 1 + 3 + 1
	});
	test("typing at the end of an attributes addition extends it, keeping one block", () => {
		// doc `a{++X++}{author=A}b`, insert "Y" at the end of the content (closer_to - 3)
		// expect `a{++XY++}{author=A}b`
	});
	test("typing after an attributes addition's block by the same author extends it", () => {
		// doc `a{++X++}{author=A}b`, insert "Y" at range.to (after the block)
		// expect `a{++XY++}{author=A}b`
	});
	test("a legacy-setting edit merging into an attributes range keeps attributes", () => {
		// syntax "legacy", same doc as above; expect the block form, not {"author":"A"}@@
	});
});
```

Write each body with the helper's concrete calls and `expect`s, filling in the values given in the comments. Match the file's existing tests; the comments state exactly what to assert.

In `tests/mark_ranges_fuzz.test.ts`, add `"{==b==}{color=red}"`, `"{++added++}{author=A}"` and `"{>>c<<}{author=A}"` to `SEGMENTS`. The existing oracle then covers Accept/Reject over blocks (review focus 4).

- [ ] **Step 2: Run them to confirm they fail.**

Run: `bun run test -- tests/range_create.test.ts tests/add_comment.test.ts tests/mark_ranges.test.ts tests/mark_ranges_fuzz.test.ts`
Expected: FAIL (`create_anchored_comment` missing; caret inside the block; the legacy form written).

- [ ] **Step 3: `create_anchored_comment`** in `range-create.ts`:

```ts
/**
 * A highlight with its first comment, written in one action. Metadata is generated once, so the pair can never
 * straddle a second boundary. Attributes syntax applies thread rule 2: the anchor states nothing and inherits from
 * the comment. Legacy writes both, so older versions and Commentator still see the anchor's author.
 */
export function create_anchored_comment(settings: PluginSettings, anchor_text: string, comment_text: string) {
	const fields = generate_metadata(settings);
	const syntax = settings.metadata_syntax;
	return construct_range(anchor_text, "", SuggestionType.HIGHLIGHT, syntax === "attributes" ? undefined : fields, 0, 0, syntax)
		.insert +
		construct_range(comment_text, "", SuggestionType.COMMENT, fields, 0, 0, syntax).insert;
}
```

- [ ] **Step 4: `add-comment.ts`.**
- Lines 78-79: `const insert = create_anchored_comment(settings, anchor_text, "");`
- Line 82: `selection: EditorSelection.cursor(selection.from + insert.lastIndexOf("<<}")),`. Add an EXPL: the comment's closer is the last `<<}` because a block escapes `}`, so `<<}` cannot occur inside one.
- Line 294 (`commitCommentDraft`): `const insert = create_anchored_comment(settings, anchor_text, text);`. The unanchored fallback above it keeps `create_range(settings, COMMENT, text)`.
- Update the comments at lines 71 and 196 that say `@@` "is eaten as the highlight's own metadata terminator" so they say this applies to legacy metadata.

- [ ] **Step 5: Thread `syntax` through `mark.ts`.**
- `mark_ranges`: add the trailing parameter `syntax: MetadataSyntax = "legacy"` and pass it to every `mark_range` call inside it.
- `mark_range`: add the trailing parameter `syntax: MetadataSyntax = "legacy"`.
- Rule for every `construct_range`/`construct_suggestion` call in `mark_range` (lines ~137, 164, 215, 271, 292, 314, 351, 384, 455):
  - If the call passes an **existing range's** fields (`left_range.fields`, `right_range.fields`), pass `0, 0`-style offsets as today and `write_syntax(syntax, thatRange)` as the last argument, and change `.fields` to `.own_fields` (suggestions never inherit, but writers serialise own fields only).
  - If it passes `metadata_fields` that came from a **merge** (`metadata_fields = merged_metadata` after merging with `left_range`/`right_range`), pass `write_syntax(syntax, left_range, right_range)`. Only the ranges actually merged matter. If the code distinguishes them, pass just those.
  - Otherwise (a brand-new range from the caller's `metadata_fields`), pass `syntax`.
- `mark_editor_ranges` (line ~606): pass `settings.metadata_syntax` as the new last argument (after `force`; check the call's existing arguments and supply `false` for `force` if it is omitted).
- `suggestion-mode.ts`: find the `mark_ranges(…)` call that receives the `metadata` generated at line 124 and pass `settings.metadata_syntax` as the last argument.
- `range_metadata_compatible` (`metadata.ts`) and `should_ignore_range` (`mark.ts`) compare `range.fields`. Leave them reading `fields`: for suggestions, effective equals own.

- [ ] **Step 6: Run the suite.**

Run: `bun run test && bun run build`
Expected: PASS, including both fuzz suites with zero genuine-corruption failures. If the fuzz harness's class-(a) count is non-zero only for docs containing blocks, a `construct_*` call got the wrong syntax or offsets. Bisect with the printed example.

- [ ] **Step 7: Commit.**

```bash
bun run format
git add -A src tests
git commit -m "feat(metadata): new ranges and comment pairs write the configured syntax

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Thread-rule edits (resolve on base, reopen cleanup, explicit inheritance)

**Files:**
- Modify: `src/editor/base/edit-logic/resolve.ts`
- Modify: `src/editor/renderers/gutters/annotations-gutter/marker.ts:253-257,336,387,610`
- Modify: `src/editor/renderers/live-preview/comment-widget.ts:111-115,290`
- Modify: `src/editor/uix/context-menu.ts:112,121`
- Modify: `src/ui/pages/annotations-view/context-menu.ts:102,116-118`, `src/ui/pages/annotations-view/AnnotationThreadQuickActions.svelte:108-110,124`
- Test: `tests/resolve.test.ts`, `tests/thread_rules.test.ts`

**Interfaces:**
- Consumes: `set_metadata(…, syntax)`, `write_syntax`, `range_source_with_fields(…, syntax)` (Task 5); `INHERITED_KEYS` (Task 4)
- Produces:
  - `resolve_thread(range, setting: MetadataSyntax = "legacy"): EditorChange[]` (base only)
  - `reopen_thread(range, setting: MetadataSyntax = "legacy"): EditorChange[]` (base, plus `done` removed from every reply that carries it)
  - `anchor_inheritance_changes(comment: CriticMarkupRange, next_first: MetadataFields | undefined, setting: MetadataSyntax): EditorChange[]`
  - `remove_comment(comment: CriticMarkupRange, setting: MetadataSyntax): EditorChange[]`

- [ ] **Step 1: Write the failing tests.** Append to `tests/resolve.test.ts` (it already has `apply` and `topRanges`):

```ts
describe("thread rule 1: done is written on the base only", () => {
	test("resolve writes done on the anchor and nowhere else", () => {
		const doc = `{==x==}{>>c<<}{author=A}{>>r<<}{author=B}`;
		const out = apply(doc, resolve_thread(topRanges(doc)[0]));
		expect(out).toBe(`{==x==}{done=true}{>>c<<}{author=A}{>>r<<}{author=B}`);
	});

	test("legacy resolve also touches only the base", () => {
		const doc = `{=={"author":"A"}@@x==}{>>{"author":"A"}@@c<<}`;
		const out = apply(doc, resolve_thread(topRanges(doc)[0]));
		expect(out).toBe(`{=={"author":"A","done":true}@@x==}{>>{"author":"A"}@@c<<}`);
	});

	test("reopen removes done from the base and cleans legacy copies on replies", () => {
		const doc = `{=={"done":true}@@x==}{>>{"author":"A","done":true}@@c<<}`;
		const out = apply(doc, reopen_thread(topRanges(doc)[0]));
		expect(out).toBe(`{==x==}{>>{"author":"A"}@@c<<}`);
	});

	test("resolve with the attributes setting migrates the base it touches", () => {
		const doc = `{=={"author":"A"}@@x==}{>>{"author":"A"}@@c<<}`;
		const out = apply(doc, resolve_thread(topRanges(doc)[0], "attributes"));
		expect(out).toBe(`{==x==}{author=A done=true}{>>{"author":"A"}@@c<<}`);
	});
});

describe("thread rule 2 edits: inheritance is made explicit before it would change", () => {
	test("removing the first comment writes the anchor's inherited fields", () => {
		const doc = `{==x==}{>>c<<}{author=A time=1}{>>r<<}{author=B time=2}`;
		const [anchor] = topRanges(doc);
		const out = apply(doc, remove_comment(anchor.replies[0], "legacy"));
		expect(out).toBe(`{==x==}{author=A time=1}{>>r<<}{author=B time=2}`);
	});

	test("no write when the new first comment has the same values", () => {
		const doc = `{==x==}{>>c<<}{author=A time=1}{>>r<<}{author=A time=1}`;
		const [anchor] = topRanges(doc);
		expect(apply(doc, remove_comment(anchor.replies[0], "legacy"))).toBe(`{==x==}{>>r<<}{author=A time=1}`);
	});

	test("removing the only comment keeps the anchor's authorship", () => {
		const doc = `{==x==}{>>c<<}{author=A}`;
		const [anchor] = topRanges(doc);
		expect(apply(doc, remove_comment(anchor.replies[0], "legacy"))).toBe(`{==x==}{author=A}`);
	});

	test("removing a later reply never touches the anchor", () => {
		const doc = `{==x==}{>>c<<}{author=A}{>>r<<}{author=B}`;
		const [anchor] = topRanges(doc);
		expect(apply(doc, remove_comment(anchor.replies[1], "legacy"))).toBe(`{==x==}{>>c<<}{author=A}`);
	});

	test("an anchor that states its own fields is left alone", () => {
		const doc = `{==x==}{author=Z}{>>c<<}{author=A}{>>r<<}{author=B}`;
		const [anchor] = topRanges(doc);
		expect(apply(doc, anchor_inheritance_changes(anchor.replies[0], anchor.replies[1].own_fields, "legacy")))
			.toBe(doc);
	});

	test("rewriting the first comment (next_first unknown) writes the inherited fields", () => {
		const doc = `{==x==}{>>c<<}{author=A time=1}`;
		const [anchor] = topRanges(doc);
		expect(apply(doc, anchor_inheritance_changes(anchor.replies[0], undefined, "legacy")))
			.toBe(`{==x==}{author=A time=1}{>>c<<}{author=A time=1}`);
	});
});
```

(Import `anchor_inheritance_changes` and `remove_comment`.)

- [ ] **Step 2: Run them to confirm they fail.**

Run: `bun run test -- tests/resolve.test.ts`
Expected: FAIL (resolve writes on replies; the helpers are missing).

- [ ] **Step 3: Implement in `resolve.ts`.**

```ts
/**
 * Marks the thread resolved. Thread rule 1: `done` is written on the base only, which is the only place
 * `thread_resolved` (and every older version) reads it. Reversible: only metadata changes.
 */
export function resolve_thread(range: CriticMarkupRange, setting: MetadataSyntax = "legacy"): EditorChange[] {
	const base = range.base_range;
	// EXPL: An attributes-era anchor usually has no block of its own (it inherits), so its first comment's syntax
	//       says which form the thread is in.
	return base.add_metadata("done", true, write_syntax(setting, base, base.replies[0]));
}

/**
 * Reopens the thread: removes `done` from the base, and from any reply still carrying a copy written by an older
 * version, so legacy threads are cleaned up when reopened. Each member edits its own metadata, so the changes never
 * overlap.
 */
export function reopen_thread(range: CriticMarkupRange, setting: MetadataSyntax = "legacy"): EditorChange[] {
	return range.base_range.full_thread.flatMap(member =>
		"done" in member.own_fields ? member.delete_metadata("done", write_syntax(setting, member)) : []
	);
}

/**
 * Changes that write a HIGHLIGHT anchor's inherited author/time into its own metadata, needed when `comment`
 * (its first comment) is about to be removed or rewritten. `next_first` is the fields of whatever will be the first
 * comment afterwards (undefined if unknown or none). A key is written only if the anchor does not state it and
 * the new first comment would give it a different value. Otherwise the anchor would silently change author.
 */
export function anchor_inheritance_changes(
	comment: CriticMarkupRange,
	next_first: MetadataFields | undefined,
	setting: MetadataSyntax,
): EditorChange[] {
	const base = comment.base_range;
	if (base.type !== SuggestionType.HIGHLIGHT || base.replies[0] !== comment) return [];
	const missing: MetadataFields = {};
	for (const key of INHERITED_KEYS) {
		if (key in base.own_fields) continue;
		const inherited = comment.own_fields[key];
		if (inherited === undefined || next_first?.[key] === inherited) continue;
		missing[key] = inherited;
	}
	if (!Object.keys(missing).length) return [];
	return base.set_metadata({ ...missing, ...base.own_fields }, write_syntax(setting, base, comment));
}

/** Removes one comment, keeping its anchor's authorship if the comment was the one it inherited from. */
export function remove_comment(comment: CriticMarkupRange, setting: MetadataSyntax): EditorChange[] {
	const next = comment.base_range.replies[1];
	return [
		...anchor_inheritance_changes(comment, next?.own_fields, setting),
		{ from: comment.from, to: comment.to, insert: "" },
	];
}
```

`cancel_empty_comment`: in its non-only-reply branch, return `remove_comment(range, "legacy")` instead of the bare removal. Do not try to work out the setting here: the empty comment it cancels was just created, so it can only carry the fields the anchor already inherits, and `anchor_inheritance_changes` writes in the anchor's own syntax via `write_syntax`.

Rewrite the doc comment on `thread_resolved`. Imports: `write_syntax` from `../edit-util/metadata`, `INHERITED_KEYS` from `../ranges`, and `type MetadataSyntax` from `../../../types`.

- [ ] **Step 4: Route the callers.** Each one reads the setting from where its file already gets settings (`pluginSettingsField` in editor code, `plugin.settings` in the annotations view):
- `marker.ts:387`, `marker.ts:610`: `resolve_thread(range, settings.metadata_syntax)`.
- `uix/context-menu.ts:112,121`: pass `settings.metadata_syntax` to `reopen_thread` / `resolve_thread`. If the file has no settings in scope, read `editor.cm.state.field(pluginSettingsField)`.
- `marker.ts:336` ("Remove comment"): `changes: remove_comment(this.range, settings.metadata_syntax)`.
- `comment-widget.ts:290` ("Remove comment"): `changes: remove_comment(range, settings.metadata_syntax)`.
- `marker.ts:253-257` and `comment-widget.ts:111-115` (comment text rewrites): changes become `[...anchor_inheritance_changes(range, undefined, settings.metadata_syntax), { from, to, insert: create_range(…) }]`. Keep each site's existing ordering of the snapshot and dispatch. The `marker.ts` EXPL about a synchronous dispatch still applies.
- Annotations view, `context-menu.ts:102` and `AnnotationThreadQuickActions.svelte:124` (resolve):
  `range_source_with_fields(range, { ...range.own_fields, done: true }, write_syntax(plugin.settings.metadata_syntax, range))`.
- Same files, `:116-118` and `:108-110` (reopen): `const fields = { ...range.own_fields }; delete fields.done; return range_source_with_fields(range, fields, write_syntax(plugin.settings.metadata_syntax, range));`. Reading `own_fields` stops a resolve from writing the inherited author into an elided anchor. These entries are thread bases (see `context-menu.ts:32`), so replies are not touched. That is rule 1.

- [ ] **Step 5: Run the suite.**

Run: `bun run test && bun run build`
Expected: PASS. `tests/resolve_rendering.test.ts` and the gutter tests may assert `done` on every member after resolve. Update those to the base-only expectation and name them in the commit body.

- [ ] **Step 6: Commit.**

```bash
bun run format
git add -A src tests
git commit -m "feat(metadata): resolve writes done on the base; reopen cleans replies; keep anchor authorship

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Display (live preview hide/reveal, reading view)

**Files:**
- Modify (if the tests show it): `src/editor/renderers/live-preview/markup-renderer.ts`, `src/editor/renderers/post-process/renderer.ts`
- Test: `tests/postprocess_obsidian_html.test.ts`, new `tests/markup_hide.test.ts`

**Interfaces:**
- Consumes: `meta`, `closer_to` (Tasks 2-3)

- [ ] **Step 1: Write the failing reading-view tests.** Append to `tests/postprocess_obsidian_html.test.ts`:

```ts
describe("trailing attribute blocks in reading view", () => {
	const ATTR_SOURCE = `This is {==some==}{>>This is a comment on the text<<}{author="Andrew B" time=1791819807} text`;
	const attrRendered = (mark: string) =>
		`<p dir="auto">This is {${mark}some</mark>}{&gt;&gt;This is a comment on the text&lt;&lt;}{author="Andrew B" time=1791819807} text</p>`;

	test.each([
		["bare <mark>", "<mark>"],
		["Obsidian 1.13 <mark data-highlight>", `<mark data-highlight="">`],
	])("highlight + comment + block renders cleanly with %s", async (_name, mark) => {
		const el = await render(attrRendered(mark), ATTR_SOURCE);
		expect(el.textContent).toBe("This is some text");
		expect(el.querySelector(".cmtr-highlight")?.textContent).toBe("some");
		expect(el.querySelector(".cmtr-comment-icon")).not.toBeNull();
		expect(el.innerHTML).not.toContain("author=");
	});

	test("a suggestion's block is not rendered", async () => {
		const source = `a {++b++}{author=A} c`;
		const el = await render(`<p dir="auto">a {++b++}{author=A} c</p>`, source);
		expect(el.innerHTML).not.toContain("author=");
		expect(el.querySelector(".cmtr-addition")?.textContent).toBe("b");
	});
});
```

- [ ] **Step 2: Write the failing live-preview test.** Create `tests/markup_hide.test.ts`. Find how the existing live-preview tests build decorations (grep `tests/` for `markupRenderer`, `rangeRenderer` or the exported function in `markup-renderer.ts` that returns a `DecorationSet`; `tests/focus_nesting.test.ts` or `tests/comment_pill.test.ts` are likely). Reuse that setup for `{++new++}{author=A}` with the cursor outside the range, and assert:
- a replace decoration covers exactly `[range.closer_to - 3, range.closer_to]` (the closer);
- a replace decoration covers exactly `[range.meta.from, range.meta.to]` (the block);
- no replace decoration covers `[3, 6]` (the content stays visible);
- with `show_metadata` on and the cursor inside the range, no decoration hides `[meta.from, meta.to]`.

- [ ] **Step 3: Run them.**

Run: `bun run test -- tests/postprocess_obsidian_html.test.ts tests/markup_hide.test.ts`
Expected: if Tasks 2-3 already made these pass, record that in the commit (the tests still pin the behaviour). Otherwise they FAIL. Fix the renderer at the failing point:
- In `post-process/renderer.ts`, ranges come from `getRangesInText` on source text and on element text; a range's `to` now includes the block, so any slice of rendered HTML by `range.to` already drops it. If the block leaks, look for an `unwrap`/`postprocess` path that uses `range.text.length` or `to - 3` instead of `closer_to`.
- In `markup-renderer.ts`, check the comment/highlight widget placement: anything positioned at `range.to` that should sit at the closer moves to `closer_to`.

- [ ] **Step 4: Run the suite, then commit.**

Run: `bun run test && bun run build`

```bash
bun run format
git add -A src tests
git commit -m "test(metadata): reading view and live preview hide attribute blocks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Per-note conversion commands

**Files:**
- Create: `src/editor/base/edit-logic/convert-metadata.ts`
- Modify: `src/editor/base/edit-logic/index.ts` (export it)
- Create: `src/ui/modals/confirm-modal.ts`; modify `src/ui/modals/index.ts`
- Modify: `src/editor/uix/commands.ts` (two commands in `editor_commands`)
- Test: new `tests/convert_metadata.test.ts`

**Interfaces:**
- Consumes: `unconvertibleReason` (Task 1); `set_metadata(…, syntax)` (Task 5); `INHERITED_KEYS`, `fields` getters (Task 4)
- Produces:
  - `convert_metadata(ranges: CriticMarkupRange[], target: MetadataSyntax): MetadataConversion`
  - `interface MetadataConversion { changes: EditorChange[]; converted: number; skipped: { range: CriticMarkupRange; reason: string }[] }`
  - `class ConfirmModal extends Modal`: `new ConfirmModal(app, { title, body, confirm: string, onConfirm: () => void }).open()`

- [ ] **Step 1: Write the failing tests.** Create `tests/convert_metadata.test.ts`:

```ts
import { DEFAULT_SETTINGS } from "../src/constants";
import { convert_metadata } from "../src/editor/base/edit-logic/convert-metadata";
import type { EditorChange } from "../src/editor/base/edit-handler";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";

const parse = (doc: string) => getRangesInText(doc, { ...DEFAULT_SETTINGS, enable_metadata: true });

function apply(doc: string, changes: EditorChange[]) {
	const ordered = [...changes].sort((a, b) => a.from - b.from);
	for (let i = 1; i < ordered.length; i++) expect(ordered[i].from).toBeGreaterThanOrEqual(ordered[i - 1].to);
	return [...ordered].reverse().reduce((out, c) => out.slice(0, c.from) + c.insert + out.slice(c.to), doc);
}
const convert = (doc: string, target: "legacy" | "attributes") => apply(doc, convert_metadata(parse(doc), target).changes);
const effective = (doc: string) => parse(doc).map(r => r.fields);

// EXPL: What Inkling itself writes in legacy: anchor and first comment carry identical fields; done only on the base.
const INKLING_SHAPED = [
	`This is {=={"author":"Andrew","time":1791819807}@@some==}{>>{"author":"Andrew","time":1791819807}@@note<<} text`,
	`{=={"author":"A","time":1,"done":true}@@x==}{>>{"author":"A","time":1}@@c<<}{>>{"author":"B","time":2}@@r<<}`,
	`a {++{"author":"Bea","time":5}@@new++}{>>{"author":"A","time":6}@@why?<<} b`,
	`{~~{"author":"A"}@@o~>n~~} {--{"author":"A"}@@d--} {>>{"author":"A"}@@lone<<}{>>{"author":"B"}@@reply<<}`,
];

describe("legacy → attributes", () => {
	test("applies the thread rules", () => {
		expect(convert(INKLING_SHAPED[0], "attributes"))
			.toBe(`This is {==some==}{>>note<<}{author=Andrew time=1791819807} text`);
		expect(convert(INKLING_SHAPED[1], "attributes"))
			.toBe(`{==x==}{done=true}{>>c<<}{author=A time=1}{>>r<<}{author=B time=2}`);
	});

	test("drops done on replies", () => {
		expect(convert(`{=={"done":true}@@x==}{>>{"author":"A","done":true}@@c<<}`, "attributes"))
			.toBe(`{==x==}{done=true}{>>c<<}{author=A}`);
	});

	test("suggestion anchors keep their own fields", () => {
		expect(convert(INKLING_SHAPED[2], "attributes")).toBe(`a {++new++}{author=Bea time=5}{>>why?<<}{author=A time=6} b`);
	});

	test("unconvertible ranges stay legacy, with a reason", () => {
		const doc = `{++{"author":"A","note":{"x":1}}@@a++} {++{"author":"B"}@@b++}`;
		const result = convert_metadata(parse(doc), "attributes");
		expect(result.converted).toBe(1);
		expect(result.skipped.map(s => s.reason)).toEqual([expect.stringContaining("note")]);
		expect(apply(doc, result.changes)).toBe(`{++{"author":"A","note":{"x":1}}@@a++} {++b++}{author=B}`);
	});

	test("an anchor keeps fields that differ from its first comment", () => {
		expect(convert(`{=={"author":"Z","time":1}@@x==}{>>{"author":"A","time":1}@@c<<}`, "attributes"))
			.toBe(`{==x==}{author=Z}{>>c<<}{author=A time=1}`);
	});
});

describe("round trip (spec: lossless conversion)", () => {
	test.each(INKLING_SHAPED)("is byte-identical for Inkling-shaped input: %s", (doc) => {
		expect(convert(convert(doc, "attributes"), "legacy")).toBe(doc);
	});

	test.each([
		...INKLING_SHAPED,
		`{==x==}{>>{"author":"A","time":1}@@c<<}`, // anchor states nothing
		`{=={"done":true}@@x==}{>>{"author":"A","done":true}@@c<<}`, // done on a reply
		`{=={"author":"Z"}@@x==}{>>{"author":"A","time":1}@@c<<}`, // anchor differs
	])("preserves every range's effective fields: %s", (doc) => {
		// EXPL: Replies' `fields` already drop `done` (Task 4), so effective fields compare directly.
		expect(effective(convert(convert(doc, "attributes"), "legacy"))).toEqual(effective(doc));
	});

	test("a legacy anchor that stated nothing gains its inherited fields on the way back (spec)", () => {
		const doc = `{==x==}{>>{"author":"A","time":1}@@c<<}`;
		expect(convert(convert(doc, "attributes"), "legacy"))
			.toBe(`{=={"author":"A","time":1}@@x==}{>>{"author":"A","time":1}@@c<<}`);
	});

	test("converting an all-legacy note back is a no-op", () => {
		for (const doc of INKLING_SHAPED) expect(convert_metadata(parse(doc), "legacy").changes).toEqual([]);
	});
});

describe("mixed notes", () => {
	test("only ranges in the other syntax are converted", () => {
		const doc = `{++{"author":"A"}@@a++} {++b++}{author=B}`;
		expect(convert(doc, "attributes")).toBe(`{++a++}{author=A} {++b++}{author=B}`);
		expect(convert(doc, "legacy")).toBe(`{++{"author":"A"}@@a++} {++{"author":"B"}@@b++}`);
	});
});
```

- [ ] **Step 2: Run them to confirm they fail.**

Run: `bun run test -- tests/convert_metadata.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `convert-metadata.ts`.**

```ts
import type { MetadataSyntax } from "../../../types";
import type { EditorChange } from "../edit-handler";
import { unconvertibleReason } from "../edit-util/attributes";
import { type CriticMarkupRange, INHERITED_KEYS, type MetadataFields, SuggestionType } from "../ranges";

export interface MetadataConversion {
	changes: EditorChange[];
	converted: number;
	skipped: { range: CriticMarkupRange; reason: string }[];
}

const is_reply = (range: CriticMarkupRange) => range.type === SuggestionType.COMMENT && range.base_range !== range;
const is_anchor = (range: CriticMarkupRange) => range.type === SuggestionType.HIGHLIGHT && range.replies.length > 0;

// EXPL: What a range writes in the attributes syntax: its own fields, minus `done` on a reply (rule 1) and minus an
//       anchor's author/time where they equal its first comment's (rule 2).
function attribute_fields(range: CriticMarkupRange): MetadataFields {
	const fields = { ...range.own_fields };
	if (is_reply(range)) delete fields.done;
	if (is_anchor(range)) {
		const first = range.replies[0].own_fields;
		for (const key of INHERITED_KEYS)
			if (key in fields && fields[key] === first[key]) delete fields[key];
	}
	return fields;
}

/**
 * The changes that rewrite every range's metadata in `target` syntax, per the spec's lossless-conversion rules.
 * Ranges already in `target`, or that cannot round-trip, are left as they are. Each range only edits its own span,
 * so the changes never overlap.
 */
export function convert_metadata(ranges: CriticMarkupRange[], target: MetadataSyntax): MetadataConversion {
	const result: MetadataConversion = { changes: [], converted: 0, skipped: [] };
	for (const range of ranges) {
		if (target === "attributes") {
			if (range.meta?.syntax !== "legacy") continue;
			const reason = unconvertibleReason(range.own_fields);
			if (reason) {
				result.skipped.push({ range, reason });
				continue;
			}
			result.changes.push(...range.set_metadata(attribute_fields(range), "attributes"));
			result.converted++;
		} else {
			// EXPL: An anchor whose first comment is in attributes syntax may be relying on inheritance; legacy has no
			//       inheritance (older versions read the anchor alone), so its inherited fields are written out in full.
			const relies_on_inheritance = is_anchor(range) && range.replies[0].meta?.syntax === "attributes";
			if (range.meta?.syntax !== "attributes" && !relies_on_inheritance) continue;
			const fields = relies_on_inheritance ? { ...range.fields } : { ...range.own_fields };
			if (range.meta?.syntax !== "attributes" && Object.keys(fields).length === Object.keys(range.own_fields).length)
				continue;
			result.changes.push(...range.set_metadata(fields, "legacy"));
			result.converted++;
		}
	}
	return result;
}
```

Two details to check while making the tests pass:
- `range.fields` on an anchor puts inherited keys first. For Inkling-shaped input that matches the original order (`author`, `time`, then `done`), which is what makes the byte-identical test pass.
- `set_metadata` for an anchor whose `attribute_fields` come out empty yields only the legacy-blob removal, which is correct: absent means inherits.

- [ ] **Step 4: Run them.**

Run: `bun run test -- tests/convert_metadata.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm modal.** Create `src/ui/modals/confirm-modal.ts`, modelled on `author-modal.ts`'s structure (read it first and match its imports and `onOpen`/`onClose` shape):

```ts
import { type App, Modal, Setting } from "obsidian";

export interface ConfirmOptions {
	title: string;
	body: string;
	confirm: string;
	onConfirm: () => void;
}

export class ConfirmModal extends Modal {
	constructor(app: App, private options: ConfirmOptions) {
		super(app);
	}

	onOpen() {
		this.setTitle(this.options.title);
		this.contentEl.createEl("p", { text: this.options.body });
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(button =>
				button.setButtonText(this.options.confirm).setCta().onClick(() => {
					this.close();
					this.options.onConfirm();
				})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}
```

If `Modal.setTitle` is not in the installed `obsidian` typings (check `node_modules/obsidian/obsidian.d.ts`), use `this.titleEl.setText(...)`. Export from `src/ui/modals/index.ts`.

- [ ] **Step 6: Commands.** In `src/editor/uix/commands.ts`, add to `editor_commands` (import `convert_metadata`, `ConfirmModal`, `Notice` is already imported):

```ts
	...([
		["attributes", "convert-metadata-to-attributes", "Convert metadata in this note to attribute blocks"],
		["legacy", "convert-metadata-to-legacy", "Convert metadata in this note back to legacy"],
	] as const).map(([target, id, name]) => ({
		id,
		name,
		icon: "replace-all",
		editor_context: true,
		regular_callback: (editor: Editor, _: MarkdownView) => {
			const ranges = editor.cm.state.field(rangeParser).ranges.ranges;
			const { changes, converted, skipped } = convert_metadata(ranges, target);
			const left = skipped.length ? ` ${skipped.length} will stay legacy: ${skipped[0].reason}.` : "";
			if (!converted) {
				new Notice(`Inkling: nothing to convert.${left}`);
				return;
			}
			new ConfirmModal(plugin.app, {
				title: name,
				body: `${converted} range${converted === 1 ? "" : "s"} will be rewritten.${left}` +
					(target === "attributes" ?
						" Collaborators on Inkling older than 0.13 or on Commentator will see stray metadata." :
						""),
				confirm: "Convert",
				onConfirm: () =>
					editor.cm.dispatch(editor.cm.state.update({ changes, annotations: [pluginEditAnnotation.of(true)] })),
			}).open();
		},
	})),
```

Check the version number in the warning against `manifest.json` when Release A is cut. The first version that reads attribute blocks is the one this branch ships in.

- [ ] **Step 7: Run the suite, then commit.**

Run: `bun run test && bun run build`

```bash
bun run format
git add -A src tests
git commit -m "feat(metadata): per-note convert to attribute blocks and back

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Settings UI, the `@` warning, docs

**Files:**
- Modify: `src/ui/pages/settings/tabs/MetadataSettings.svelte`
- Modify: `README.md` (a metadata format section and an upgrade note)
- Test: new `tests/author_at_warning.test.ts`

**Interfaces:**
- Produces: `author_at_warning(author: string | undefined): string | undefined`, exported from `src/editor/base/edit-util/attributes.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/author_at_warning.test.ts`:

```ts
import { author_at_warning } from "../src/editor/base/edit-util/attributes";

describe("author_at_warning (spec: @ inside a value)", () => {
	test.each(["@andrew", "Bea (@bea)", "x @y"])("warns for %j", (author) => {
		expect(author_at_warning(author)).toContain("citation");
	});
	test.each(["Andrew", "a@b.com", "", undefined])("is quiet for %j", (author) => {
		expect(author_at_warning(author)).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run it to confirm it fails, then implement** in `attributes.ts`:

```ts
/**
 * A warning when `author` would put an `@` after a non-alphanumeric character in an attribute block, which
 * Pandoc-grammar tools (ZotLit, Pandoc) read as a citation. `a@b.com` is fine.
 */
export function author_at_warning(author: string | undefined): string | undefined {
	if (!author || !/(^|[^\p{L}\p{N}])@/u.test(author)) return undefined;
	return "An @ at the start of a word is read as a citation by Pandoc and ZotLit when written in attribute blocks.";
}
```

Run: `bun run test -- tests/author_at_warning.test.ts`. Expected: PASS.

- [ ] **Step 3: Settings UI.** In `MetadataSettings.svelte`, import `Dropdown` alongside `Input, SettingItem, Toggle`, and `author_at_warning` from `../../../../editor/base/edit-util/attributes`. After the "Name" `SettingItem`, add (inside the same `{#if}` block) a warning shown under the name when `author_at_warning(plugin.settings.author)` returns text. Use a `SettingItem` with `description={warning}` and no control if `SettingItem` supports that; otherwise a `<div class="setting-item-description mod-warning">`. Check `src/ui/components` for the existing pattern before choosing.

After the "Add Metadata" `SettingItem` at the top, add:

```svelte
<SettingItem
	name="Metadata format"
	description="How Inkling writes author, time and resolution. Both formats are always read. Attribute blocks avoid ZotLit citation false positives, but collaborators need Inkling 0.13 or later, and Commentator does not read them."
>
	{#snippet control()}
		<Dropdown
			value={plugin.settings.metadata_syntax}
			options={[
				{ value: "legacy", text: "Legacy ({json}@@)" },
				{ value: "attributes", text: "Attribute blocks" },
			]}
			onChange={(value) => {
				plugin.settings.metadata_syntax = value;
				plugin.saveSettings();
			}}
		/>
	{/snippet}
</SettingItem>
```

Match the `Dropdown` usage in `AdvancedSettings.svelte:43-50` exactly. The setting does not need a reload: writers read it on each call.

- [ ] **Step 4: README.** Under the existing metadata or usage section, add a "Metadata format" subsection: show both forms with the example from the spec's opening, state that both are always read, explain the setting and touch-to-migrate, the two convert commands, the thread rules in two sentences, and the collaborator requirement (everyone on the Release A version before anyone writes attribute blocks). Add an upgrade note listing who must update first: collaborators, plus `config/critic.py` for the CRI build.

- [ ] **Step 5: Run the full suite and the build, then commit.**

Run: `bun run test && bun run build && bun run lint`
Expected: all pass. Any lint findings in touched files must be fixed. The directory review blocks unexplained `eslint-disable` comments.

```bash
bun run format
git add -A src tests README.md
git commit -m "feat(metadata): metadata format setting, @ warning, docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Run the existing `@@` fixtures over both syntaxes

The spec asks for the existing legacy fixtures to be parametrised rather than duplicated. This task does that for the suites whose behaviour must be syntax-independent.

**Files:**
- Modify: `tests/helpers.ts` (add `withSyntax`)
- Modify: `tests/resolve_rendering.test.ts`, `tests/annotations_filter.test.ts`, `tests/original_text.test.ts`, `tests/copy_strip.test.ts`, `tests/comment_draft.test.ts`, `tests/gutter_annotation_dispatch.test.ts`

**Interfaces:**
- Produces: `withSyntax(doc: string, syntax: MetadataSyntax): string`. It rewrites every legacy range in `doc` to `syntax` via `convert_metadata` (identity for `"legacy"`).

- [ ] **Step 1: Add the helper** to `tests/helpers.ts`:

```ts
import { convert_metadata } from "../src/editor/base/edit-logic/convert-metadata";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import type { MetadataSyntax } from "../src/types";

/** The same document with every legacy range rewritten in `syntax`, so a legacy fixture can run over both forms. */
export function withSyntax(doc: string, syntax: MetadataSyntax): string {
	if (syntax === "legacy") return doc;
	const { changes } = convert_metadata(getRangesInText(doc, { ...DEFAULT_SETTINGS, enable_metadata: true }), syntax);
	return [...changes].sort((a, b) => b.from - a.from)
		.reduce((out, c) => out.slice(0, c.from) + c.insert + out.slice(c.to), doc);
}
```

- [ ] **Step 2: Parametrise.** In each listed file, wrap the describes whose fixtures contain `@@` in `describe.each(["legacy", "attributes"] as const)("%s metadata", (syntax) => { … })`, and pass each fixture doc through `withSyntax(doc, syntax)`. Leave assertions that inspect raw metadata bytes (`{"author"`, `@@` positions) legacy-only. Move them into a `describe("legacy bytes", …)` with a one-line EXPL saying why. Do not change what any test asserts about behaviour.

- [ ] **Step 3: Run the suite.**

Run: `bun run test`
Expected: PASS, with roughly double the test count in those files. A failure under `attributes` only is a real bug in Tasks 2-8. Fix it in the owning code, not the test, and note it in the commit.

- [ ] **Step 4: Commit.**

```bash
bun run format
git add -A tests src
git commit -m "test(metadata): run legacy fixtures over both syntaxes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the plan

- Release A is a `bun run release-beta --type minor` (to `0.13.0-beta.0`) for the user to try through the beta channel with `metadata_syntax: attributes` on a test vault. A stable `0.13.0` follows once they are satisfied. Both are the user's call, and nothing here pushes or tags.
- Not in this plan: the Release B default flip and notice; `config/critic.py` (in the vault, not this repo); a ZotLit brackets-only request.
