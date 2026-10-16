# InklingMarkup metadata: trailing attribute blocks — Design

**Status:** draft for review, 2026-10-12. Part of Phase 2 of `2026-07-14-road-to-1.0-roadmap.md`.

Inkling stores author, time and resolution state inside each range, ahead of its content, as JSON
ended by `@@`:

```
{=={"author":"Andrew","time":1791819807}@@some==}{>>{"author":"Andrew","time":1791819807}@@note<<}
```

This spec replaces that with a Pandoc-style attribute block written **after** the range's closer:

```
{==some==}{>>note<<}{author="Andrew" time=1791819807}
```

and, in the same change, stops writing the same fact twice: thread state is written once on the
thread's base, and a highlight anchor takes its authorship from its first comment.

It covers the syntax, the changes to Inkling, and how existing notes, older Inkling installs and other
tools keep working.

---

## Why

1. **`@@` reads as a Pandoc citation.** Pandoc parses `…}@@some` as the citation `@some` (verified
   with Pandoc 3.7.0.2), and so does every tool that follows its grammar. ZotLit, which the CRI team
   requires, decorates the `@` and the first word of every commented passage in live preview and
   reports "matches no item in your Zotero library". Nothing on Inkling's side can suppress another
   plugin's decorations, and asking Pandoc-faithful tools to special-case a dialect used by roughly
   two Obsidian plugins is a hard sell. The dialect is ours, so the fix belongs in the dialect.
2. **The JSON leaks into other tools' output.** It sits *inside* the content, so MultiMarkdown,
   PyMdown, Commentator and any plain CriticMarkup reader render `{"author":…}@@some` as the
   highlighted text. A trailing block degrades to a correct range followed by stray `{…}` text.
3. **It aligns with Pandoc's model.** `{author="Andrew"}` is Pandoc attribute syntax, and Pandoc's
   own track-changes representation (`[x]{.insertion author="…" date="…"}`, `comment-start` /
   `comment-end`) round-trips to Word revisions and comments. A future export to that form is a
   direct mapping rather than a translation.

### Alternatives considered

- **Pandoc spans as the storage format** (`[x]{.insertion author=…}`). Zero-conversion Word export
  and comments that can cross blocks, but it abandons CriticMarkup compatibility, needs explicit
  comment ids, and means a full rewrite of every note. Kept as an **export target**, not storage.
- **Djot-like delimiters** (`{=x=}`, `{-x-}`, `{+x+}`, plus an invented `{>note<}`). Saves two
  characters per delimiter and costs:
  - every legacy range gains a second reading (`{==x==}` is also a Djot highlight of `=x=`), so the
    reader needs precedence rules, and those rules break valid new-form content (deleting `-1`
    writes `{--1-}`, which opens as CriticMarkup `{--`);
  - template collisions (`{{- name -}}` in Liquid, Jinja and Nunjucks, including ZotLit's own templates,
    contains a deletion) and earlier closes, since `-}`, `+}` and `=}` are common in content and code;
  - no substitution or anchored-comment syntax in Djot, so both would be invented anyway. Substitution
    by adjacency (`{-a-}{+b+}`) would mean rewriting `substitution_range.ts` and couldn't tell a
    substitution from two independent edits;
  - no tool support gained (the vault is Markdown, and Pandoc's Djot reader doesn't match its own Word
    writer), the loss of Obsidian's `==`/`~~` rendering for teammates without Inkling, and the loss of
    every existing CriticMarkup reader;
  - two overlapping delimiter families in the Phase 2 grammar.
  The trailing attribute block is the part of Djot worth borrowing, and it is the core of this spec.
- **A guard in ZotLit** (`@` after `@` is not a citation). Fixes one consumer, departs from Pandoc,
  and leaves the dialect clashing with every other Pandoc-faithful tool. Still worth requesting a
  brackets-only recognition option from ZotLit independently.
- **HTML `<ins>`/`<del>`/`<mark>`.** Pandoc's Markdown reader keeps them as raw HTML and drops them
  from every non-HTML output; its HTML reader maps them to presentational `Underline`/`Strikeout`.

---

## Syntax

### The attribute block

```
range       := criticmarkup-range attr-block?
attr-block  := "{" attr (" "+ attr)* "}"
attr        := key "=" value
key         := [A-Za-z_][A-Za-z0-9_-]*
value       := bare | quoted
bare        := [A-Za-z0-9_.:+-]+
quoted      := '"' ( [^"\\\n] | "\\" ["\\{}] )* '"'
```

Rules:

- **Placement.** The block follows the range's closer (`++}`, `--}`, `~~}`, `==}`, `<<}`) with no
  whitespace between. A thread is a chain: `{==x==}{…}{>>c<<}{…}{>>reply<<}{…}`.
- **Recognition is all-or-nothing.** A `{` after a closer starts a block only if the whole thing
  parses as `attr-block`. Otherwise it is ordinary text. No CriticMarkup opener (`{++ {-- {~~ {== {>>`)
  can parse as a key, so `{==x==}{>>c<<}` is unambiguous.
- **At least one attribute.** `{}` is never a block. That keeps the reader from consuming literal
  braces and means "no metadata" has exactly one spelling: no block.
- **Reserved forms.** `.class` and `#id` (Pandoc's other attribute forms) are **reserved**: the reader
  rejects a block containing them in this version, so a later phase can give them meaning (see
  *Overlap ids*) without a format break.
- **Keys** are written in full: `author`, `time`, `done`, `style`, `color`. The legacy JSON shorthand
  (`a`, `t`, `d`, `s`, `c`) is accepted on read and normalised, exactly as today.
- **Value types.** Attribute values are strings. The reader restores Inkling's known types: `time`
  as an integer (epoch seconds, unchanged from today), `done` as a boolean (`true`/`false`). Unknown
  keys round-trip as strings.
- **Writing values.** The writer emits a value bare when it matches `bare`, otherwise quoted, escaping
  `"`, `\`, `{` and `}`. Newlines in values are not representable; see *Lossless conversion*.

### Thread rules: each fact written once

Today a single comment on a highlight writes identical author/time metadata twice, and resolving a
thread writes `done: true` onto every member although `thread_resolved` (`resolve.ts:9`) only reads
the base. Two rules remove the duplication:

1. **Thread state lives on the base only.** `done` is written on the thread's base (the highlight
   anchor, or the first comment of an unanchored thread) and nowhere else. The reader ignores `done`
   on replies, which legacy files carry.
2. **A highlight anchor inherits authorship from its first comment.** A field a highlight anchor does
   not state takes the first comment's value. The writer omits the anchor's `author`/`time` when they
   equal the first comment's, which is always the case when Inkling creates the pair in one action.

What does **not** inherit:

- **Replies.** Each reply is its own act, often by someone else, and carries its own block. Comments
  never inherit from each other; a chain would change meaning whenever a middle reply was deleted.
- **Suggestion anchors.** A comment on `{++x++}` is often by someone other than the suggester, so
  additions, deletions and substitutions always state their own fields.
- **A highlight with no comments.** Nothing to inherit from; it keeps its own block.

```
{==some==}{>>note<<}{author="Andrew" time=1791819807}
{==some==}{done=true}{>>note<<}{author="Andrew" time=1791819807}{>>reply<<}{author="Bea" time=1791823000}
{++new++}{author="Bea" time=1791820000}{>>why?<<}{author="Andrew" time=1791821000}
```

Authorship sits on comments; thread state sits on the anchor.

**Scope by syntax.** Rule 1 applies to both syntaxes: it only stops writing copies nobody reads, so
every Inkling version still sees the same resolution state. Rule 2 applies only to the attributes
syntax; the legacy writer keeps writing the anchor's own fields, so older Inkling installs and
Commentator never see an anchor lose its author.

### Known limitation: `@` inside a value

A quoted value that starts with `@` (`author="@andrew"`) puts an `@` after `"`, which Pandoc-grammar
tools treat as a citation start. Ordinary names and email addresses (`a@b.com`) are unaffected. The
settings page should warn when the configured author name contains `@` after a non-alphanumeric
character. Not worth an escaping scheme.

---

## Changes to Inkling

### 1. Parsing

The shipped grammar (`@fevol/lang-criticmarkup`) only knows the legacy form, through its `MDSep`
child node. Attribute blocks sit **outside** the grammar's range node, so they can be recognised in
TypeScript without the grammar fork:

- `cursorGenerateRanges` (`src/editor/base/edit-util/range-parser.ts`), after `rangeEnd` fixes a
  range's end, tries to read an attribute block at that position and, if one parses, extends the
  range's end past it.
- A new module `src/editor/base/edit-util/attributes.ts` owns `parseAttrBlock(text, at)` and
  `serializeAttrBlock(fields)`, both pure and unit-tested in isolation.

Pre-fork caveat: the grammar still scans the block's text, so a quoted value containing a
CriticMarkup opener (`author="{++x"`) could start a bogus range inside it. The writer's `{`/`}`
escaping does not help, because the grammar sees the brace character either way. This is accepted
until the Phase 2 grammar fork, which emits the block as a single token and removes the hazard.

### 2. The range model

**Decision: a range's `to` includes its attribute block.** Whole-range operations (accept, reject,
unwrap, delete, `full_range_back`) then remove the block along with the range automatically, and
adjacency threading (`right_adjacent`: `this.to === other.from`) keeps working for
`{==x==}{…}{>>c<<}`. Legacy metadata is already inside `from..to`, so this preserves today's
invariant: everything Inkling owns about a range lies between `from` and `to`.

The rejected alternative, keeping `to` at the closer and tracking the block separately, leaves every
whole-range replacement that forgets the block writing stray `{author=…}` text into the note.

What changes in `CriticMarkupRange` (`src/editor/base/ranges/base_range.ts`):

- `metadata?: number` becomes a discriminated location:
  `meta?: { syntax: "legacy" | "attributes"; from: number; to: number }`.
  For legacy it covers `{json}@@` inside the opener; for attributes it covers the trailing block.
- New getter `closer_to`: the end of the closing bracket (`to` minus the block, if any). The ten
  sites that compute the closer as `to - 3` (`markup-renderer.ts:39`, `range-correcter.ts:53`,
  `comment-mode.ts:33`, `edit-mode.ts:78`, `base_range.ts:286,298,325`,
  `substitution_range.ts:121,138,142`) move to `closer_to - 3`.
- `range_start` / `range_front` stop special-casing metadata for the attributes syntax (content now
  starts right after the opener).
- `length` and `empty()` stop counting metadata of either syntax. Today `length` includes the JSON,
  which is a latent bug this fixes.
- `text` stays metadata-stripped, with brackets, so `unwrap()`, `unwrap_parts()` and every
  `slice(3, -3)` keep working unchanged.
- `set_metadata` / `remove_metadata` / `delete_metadata` write in the range's **current** syntax
  unless the writer setting says to migrate (see *Migration*).
- **`own_fields` / `fields` split.** `own_fields` is what the note states for this range and is the
  only thing writers serialise. `fields` is the effective view: `own_fields` plus anything inherited
  under the thread rules. Every reader of `fields` today (author/time filters in
  `filter-ranges.ts`, `snippets/metadata.ts`, `marker.ts:113`, `comment-widget.ts:174`,
  `AnnotationThread.svelte:64`) keeps reading `fields` unchanged. Inheritance is resolved in
  `cursorGenerateRanges` right after `add_reply` assembles a thread, the one place that sees
  anchor and first comment together.

### 3. Writing

The three serialisers that hard-code `JSON.stringify(fields) + "@@"` go through one function,
`write_metadata(fields, syntax)`:

- `base_range.ts:155` (`set_metadata`) and `:370`
- `range-create.ts:37` (`construct_range`, used for every new suggestion and comment)
- `resolve.ts:48` (`range_source_with_fields`)

`construct_range` currently returns `start_offset` assuming metadata precedes the content. With
trailing attributes the content starts right after the opener, and the offsets must account for the
block after the closer instead. This is the riskiest arithmetic in the change and gets dedicated tests.

### 3a. Thread-rule edits

- `resolve_thread` / `reopen_thread` (`resolve.ts:28,35`) touch only the base. `reopen_thread` also
  deletes `done` from replies, so legacy threads are cleaned up when reopened.
- The quick-action and context-menu paths that delete `done`
  (`AnnotationThreadQuickActions.svelte:109`, `context-menu.ts:117`) route through the same functions.
- **Making inheritance explicit before it would change.** An edit that changes which comment is a
  highlight anchor's first comment (deleting or moving the first comment, or splitting the thread)
  first writes the anchor's inherited `author`/`time` into its own block, unless the new first
  comment has the same values. Otherwise the anchor would silently take a different author. If the
  thread is left with no comments, `cancel_empty_comment` already unwraps the highlight, so nothing
  needs writing.
- Adding a comment to a highlight that has its own block does not elide it retroactively. The writer
  elides only when it creates the pair, or when converting.

### 4. Display

- `markup-renderer.ts:52-54` hides `meta.from..meta.to` for either syntax (today it hides
  `from + 3 .. metadata + 2`).
- `marker.ts:84` and `comment-widget.ts:153` test `range.meta` instead of `range.metadata`.
- Reveal-on-cursor (`show_metadata`) shows the block where it is written.
- The reading-view post-processor (`renderer.ts`) maps Obsidian's rendered HTML back to source; a
  trailing `{author=…}` renders as literal text, so it must be stripped alongside the range. Needs
  its own fixture, since the existing `<mark>` mapping has broken before.

### 5. Comment-text escaping

`add-comment.ts` escapes `@@` typed into a comment because it would end the legacy metadata. With
attribute blocks the hazard moves: a comment body that ends with `<<}{a=b}` would gain metadata. The
escaping logic (`METADATA_TERMINATOR`, `add-comment.ts:153`) keeps the `@@` rule while legacy files
exist and adds a rule for text typed directly after a closer that would form a valid block.

### 6. Public API

`api.toOriginalText` / `api.hasCriticMarkup` strip both syntaxes. Their output is unchanged, so
`api.version` stays `1`. Transclusion Extractor calls this API and needs no change.

---

## Migration

### Principles

1. **Read both forever.** No version of Inkling stops reading `{json}@@`. It costs one branch in the
   parser and is the only way old notes, Commentator files and pasted text keep working.
2. **Never rewrite silently in bulk.** Opening a note never changes it.
3. **Expand, then contract.** Every install must be able to *read* the new form before any install
   *writes* it, because a note is often edited by several people on different versions.
4. **Lossless or untouched.** A range is converted only if converting back would reproduce it. Any
   range that cannot be converted losslessly stays legacy.

### Setting

`metadata_syntax: "legacy" | "attributes"`, under the existing metadata settings, which governs what
Inkling **writes**:

- for new ranges, and
- when Inkling already rewrites a range's metadata (author or time update, resolve/reopen, a merge).
  This is *touch-to-migrate*: a converted range is one Inkling was editing anyway.

### Release sequence

| Release | Reads | Writes by default | Notes |
|---|---|---|---|
| **A** (0.13.x) | legacy + attributes | legacy | Read support only. Nobody's notes change. Ship and wait for collaborators to update; BRAT updates automatically. |
| **B** | legacy + attributes | attributes for new installs; existing installs keep their setting | A one-time notice offers the switch and explains the collaborator requirement. |
| **C** (1.0) | legacy + attributes | attributes | Default flips for everyone who never chose. Legacy remains selectable for Commentator interop. |

The gap between A and B is what makes mixed teams safe. **Decided (2026-10-16):** two phases. For
the CRI team, B ships only after every member is confirmed on A and `config/critic.py` reads the new
form.

### Commands

- **Convert metadata in this note**: shows a count first ("37 ranges"), converts every losslessly
  convertible range, and reports any left as legacy with the reason.
- **Convert this note back to legacy**: the same, reversed. This is the rollback path if a
  collaborator turns out to be on an old version or on Commentator.

**Decided (2026-10-16):** conversion is per note only. No vault-wide command before 1.0.

### Lossless conversion

A range converts only if every field value is a string, a finite number or a boolean, and no string
contains a newline. Anything else (nested objects from the `[prop: string]: any` escape hatch,
arrays, `null`) stays legacy. Field order is preserved in both directions.

Conversion applies the thread rules: an anchor's `author`/`time` are elided when they equal its first
comment's, and `done` on replies is dropped. Converting back writes the anchor's inherited fields out
in full. An absent field on an attributes-syntax anchor always means "inherits", so the guarantee is:

- **Meaning is preserved** by legacy → attributes → legacy for every convertible range: every range's
  `fields` (effective) are identical before and after.
- **Bytes are preserved** when the legacy anchor stated the same `author`/`time` as its first comment
  and no reply carried `done`, which is what Inkling itself writes.
- A legacy anchor that stated **no** metadata will read as inheriting once converted, and converting
  back writes the inherited values onto it. This is a visible change, and arguably the correct one.

Both guarantees are tests, not hopes.

---

## Backwards compatibility

How each consumer sees a note written with attribute blocks:

| Consumer | Result | Action |
|---|---|---|
| Inkling ≥ A | Full support | None |
| Inkling < A (a collaborator who has not updated) | Stray `{author=…}` text; **anchored comments detach** (the block breaks adjacency, so a comment becomes bare and replies split into separate threads); edits near them may mix forms | This is why release A precedes B. Document it in the README upgrade section. |
| Commentator | Same as Inkling < A | Keep `metadata_syntax: legacy` |
| Generic CriticMarkup (MultiMarkdown, PyMdown, Zettlr) | Range renders correctly, followed by literal `{…}` | An improvement on legacy, whose JSON lands inside the range |
| CRI build (`config/critic.py`) | Strips the range but keeps the block, so `{author=…}` would appear in funder documents | **Must be updated before any CRI member writes attributes.** Port the same rule as `original-text.ts` and add test cases to `config/test_build.py`. |
| Transclusion Extractor | Uses `api.toOriginalText` | None |
| ZotLit | No citation false positives (unless a value starts with `@`) | None |
| Pandoc | Treats both forms as text | A Lua filter for Word export is future work |

How a note written with **legacy** metadata reads in Inkling ≥ A: unchanged, with one exception. A
highlight anchor that states no metadata now shows its first comment's author and time (rule 2),
including in the author filters of the Annotations view.

Thread rule 1 is safe for every version: older Inkling also reads `done` only from the base.

Notes containing both forms are valid. Threads may mix forms member by member.

---

## Overlap ids (interaction with the rest of Phase 2)

The roadmap's overlap dialect puts ids in the delimiters, `{==#a1 … ==#a1}`, because the closer
must name the range it closes. An attribute block only follows the closer, so it cannot replace that.
The two compose: `{==#a1 text ==#a1}{author="Andrew"}`. Reserving `#id` inside blocks (see
*Syntax*) leaves room for the Phase 2 spec to decide whether the opener's id should *also* be
mirrored there for Pandoc export. This spec does not decide it.

---

## Testing

- **`attributes.ts` unit tests:** grammar acceptance/rejection (all-or-nothing, `{}`, reserved
  forms, escapes, shorthand keys, types), serialise/parse round trips.
- **Round-trip property test:** for generated threads, legacy → attributes → legacy preserves every
  range's effective `fields`, is byte-identical for Inkling-shaped input (anchor equals first comment,
  no `done` on replies), and leaves non-convertible ranges alone.
- **Range model:** every range type × both syntaxes × threads, covering `closer_to`, `length`,
  `empty`, adjacency and accept/reject/unwrap removing the block. The 66 existing `@@` fixtures
  across 17 test files become parametrised over both syntaxes rather than duplicated.
- **Thread rules:** `fields` vs `own_fields` for anchors, replies and suggestion bases; `done` written
  and read on the base only; deleting, moving and splitting the first comment writes the anchor's
  inherited fields exactly when they would otherwise change; legacy replies with `done` are ignored
  and cleaned up on reopen.
- **Edit-engine fuzz:** the Phase 1 fuzz harness runs with attribute-block documents. Accept-All
  must never leave a stray block.
- **Reading view:** a fixture with a trailing block after a highlight + comment, including the
  `<mark data-highlight>` case.
- **Display:** hide/reveal decorations cover exactly the block.
- **CRI build:** `test_build.py` cases for attributes, legacy and mixed forms.

---

## Out of scope

- Pandoc-span or Word export (a filter can come later; this spec only makes it a direct mapping).
- Changing what metadata records (e.g. ISO dates instead of epoch seconds).
- The grammar fork itself, beyond noting the hazard it removes.
- Any change to ZotLit. A brackets-only recognition option is worth requesting separately.
