# Inkling Markup: Collaborative Editing for Obsidian

**Inkling** is a [CriticMarkup](https://github.com/CriticMarkup/CriticMarkup-toolkit) editor for [Obsidian](https://obsidian.md/).
It is designed both for collaborative editing (with tools like Relay) and for reviewing your notes, providing a suggestion mode
for tracking changes, comments anchored to text selections, and a comment-only mode for reviewers.

This is a fork of [Commentator](Fevol/obsidian-criticmarkup). Commentator was built by [@Fevol](https://github.com/Fevol) upon the
excellent work and advice of [@kometenstaub](https://github.com/kometenstaub) (original
[plugin](https://github.com/kometenstaub/obsidian-criticmarkup) and [parser](https://github.com/kometenstaub/lang-criticmarkup)).
All credit for the plugin's foundation belongs to them.

## Installing (via BRAT)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) community plugin
2. In BRAT: **Add beta plugin** → `AndrewBroz/obsidian-inkling`
3. Enable **Inkling Markup** in Settings → Community plugins

### Beta channel

Betas are published to a separate, release-only repository,
[`AndrewBroz/obsidian-inkling-beta`](https://github.com/AndrewBroz/obsidian-inkling-beta), never to this
one. To test them, remove `AndrewBroz/obsidian-inkling` from BRAT and add the beta repository instead.
List only one of the two. Every stable release is published to the beta repository too, so testers move
onto it when a beta ends.

### Upgrading from 0.11.x or older (plugin id `inkling`)

From 0.12.0 the plugin id is **`inkling-markup`**. The old id `inkling` now belongs to an unrelated
plugin in the community store, so Obsidian offers that plugin's releases as an "update" to old installs.
**Do not click Update on an Inkling 0.11.x install** (or "Update all"): it replaces Inkling with a
different plugin.

1. In BRAT, check for updates (or re-add `AndrewBroz/obsidian-inkling`); this installs `inkling-markup`
   alongside the old copy
2. Enable **Inkling Markup** in Settings → Community plugins. On first load it imports your settings and
   hotkeys from the old copy and disables it
3. Click **Uninstall old copy** in the notice that appears (or uninstall the 0.11.x **Inkling** manually)

> [!WARNING]
> This fork is in beta. It carries an extensive automated regression suite (1,100+ tests, including
> round-trip safety tests for accept/reject), but has not yet finished manual validation in live vaults.
> Use it in a test vault or a synced/backed-up vault first.

## What's different in this fork

**Data-safety fixes:**

- Rejecting all suggestions no longer resurrects text from retracted additions
- "Accept/reject selected" no longer misfires at the start of a document (previously accepted _everything_)
- Substitution ranges are no longer corrupted (separator/metadata destruction) by the markup auto-correcter
- Vault-wide accept/reject refuses to apply stale positions to files that changed after indexing

**Collaboration features:**

- **Comments anchored to selections** — Select text > _Add comment_ > `{==highlight==}{>>comment<<}` thread.
- **Comments on code** — Comment on a line of a code block, or on the whole block, without changing the code (see [Comments on code](#comments-on-code))
- **Comment mode** — A reviewer-friendly mode where text edits are blocked (with feedback) but commenting works
- **Frontmatter-enforced modes** — A note can force `suggest`/`comment`/`off` for everyone except listed authors (see [Frontmatter](#frontmatter))
- **No unprotected mode** — Every editing mode guards the CriticMarkup syntax (see [Editing modes](#editing-modes))
- **Attribution on by default** — New installs stamp author + timestamp metadata and prompt once for your display name. The vault-wide Suggestion View can filter by author and recency.

**Maintenance:** Modernized toolchain (ESLint 10 with Svelte linting, dprint, vendored dependencies), repaired release CI, and a large regression-test suite.

## Editing modes

The editor toggle (status bar / note header) cycles through three modes:

| Mode           | Behaviour                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------- |
| **Editing**    | Ordinary editing, with edits guarded so they cannot corrupt the CriticMarkup syntax (the default) |
| **Suggesting** | Edits are converted into suggestion ranges instead of changing the text directly                  |
| **Commenting** | Document edits are blocked (with feedback); comments and replies still work                       |

Upstream Commentator also had a "Regular" mode that installed no protection at all, so ordinary typing
could corrupt a note's markup (backspacing `{++` into `{+`, deleting half of a range). It has been
removed. Its one interesting property, seeing the raw brackets and metadata of the range under the cursor, is
now the **Reveal CriticMarkup syntax under the cursor** setting (Editor settings), which works in every mode.

## Frontmatter

Enforce an editing mode for a note via frontmatter that overrides the per-editor toggle:

```yaml
---
inkling: suggest   # or: comment, off
inkling-authors: [Alice]   # optional: these authors are exempt from enforcement
---
```

`off` enforces plain **Editing** mode (nothing beyond the usual syntax protection): use it to override a
reader's own default of suggesting or commenting.

The legacy `commentator:` / `commentator-authors:` keys still work (checked when no `inkling` key is present),
so existing notes from before the rename don't need to be updated.

> [!NOTE]
> This is not hard technical enforcement. Inkling is only appropriate for high-trust teams.

## Comments on code

Select some code in a code block and click the comment button, or put the cursor in the block and run **Add comment**.
With only the cursor in the block, the comment is about the whole block. This works in every mode, including
Commenting, where the code itself stays locked.

Inkling never writes inside a code block. The comment goes on the line just below the block and remembers the code you
selected. Its card sits beside the block and shows that code; click the card to highlight the code in the block (the
whole block is outlined for a comment on all of it).

- **If you edit the code**, the highlight follows the selected code to wherever it is now. If that code appears more
  than once, Inkling picks the copy nearest to where it was.
- **If the selected code is gone**, the card still shows it, marked "This code has changed", and clicking the card
  outlines the whole block.
- **If you delete the block, or put a blank line or any other text between the block and its comments**, the comments
  stay in the note as ordinary comments and still show the code they were about.
- **Several comments on one block** share the line below it, side by side.
- **Removing or resolving** (with Remove comments on resolve on) a comment that has the line to itself removes the line
  too.

A block needs its closing fence (```` ``` ```` or `~~~`) before you can comment on it.

## Metadata format

Inkling stores author, time and resolution state with each range, in a Pandoc-style attribute block after the range's
closer:

```
{==some==}{>>note<<}{author="Andrew" time=1791819807}
```

Older notes may use the legacy format, which puts JSON ahead of the content, ended by `@@`:

```
{=={"author":"Andrew","time":1791819807}@@some==}{>>{"author":"Andrew","time":1791819807}@@note<<}
```

Legacy is deprecated: Inkling reads it everywhere but no longer writes it. Opening a note never changes it. A range that
Inkling rewrites anyway (an edit, a reply, a resolve) is written as an attribute block, and **Update Inkling comments
and suggestions to the new format** converts a whole note at once. The one exception: a range whose fields or text an
attribute block cannot hold losslessly (a value with a line break, a nested object, or text that itself starts with a
JSON object and `@@`) stays legacy.

Pandoc-grammar tools such as ZotLit read `@@some` as a citation; attribute blocks avoid that. Other CriticMarkup
readers also show a trailing block as stray text after a correct range, rather than inside the highlighted content.

To clear finished discussions, run **Remove resolved comments in this note**. It asks for confirmation, then deletes
every resolved comment thread in the note in one step (a single undo restores them). Highlighted text is kept, and
suggestions are never touched. **Settings, Editor, Remove comments on resolve** makes every Resolve action delete the
thread instead of marking it done. As of 0.13 this setting is on by default, including for existing installs (it is
switched on once; turning it off afterwards sticks). Threads resolved earlier can be removed with the command above.

A comment on code keeps what it is about in its attribute block: `quote` (the selected code, or for a selection over
several lines, the selected part of its first line), `line` (the line within the block where the selection starts,
counting from 1) and `lines` (how many lines were selected, only when more than one). A comment on the whole block has
none of these. It belongs to the block when it starts on the line directly after the closing fence, with nothing but
other such comments before it on that line:

````
```js
let x = 1
```
{>>Why not const?<<}{author="Andrew" time=1795300000 quote="let x = 1" line=1}
````

Thread rules for attribute blocks: a highlight takes its author and time from its first comment, so the same fact is
not written twice. The resolved state (`done`) is written once, on the thread's base.

If an author name has an `@` at the start of a word (such as `@andrew`), Pandoc-grammar tools read it as a citation even
in attribute blocks, and the Name setting shows a warning.

> [!WARNING]
> Every collaborator must be on Inkling 0.13 or later (the release that reads attribute blocks), since 0.14 writes
> only attribute blocks. Older versions and Commentator do not read them.

### Upgrade note

Update in this order: first every collaborator's Inkling to 0.13 or later, then any tooling that parses the metadata
itself (for the CRI build, `config/critic.py`), and only then Inkling 0.14, which writes nothing but attribute blocks.

### What's new in 0.14

- **A new format for comments and suggestions.** Inkling now saves comment and suggestion metadata in a new format.
  Everyone you share notes with needs Inkling 0.13 or later. Commentator can't read it.
- **Older notes keep working.** Inkling still reads the old format and updates each comment or suggestion as you edit
  it. To update a whole note at once, run **Update Inkling comments and suggestions to the new format**.
- **The old format is retired.** Inkling no longer saves anything in it, and the Metadata format setting is gone.
  Existing installs see a one-time notice.
- **Line markers go in as typed in Suggest mode.** A quote `> `, heading `#`, list item `- ` or `1. `, or task `- [ ] `
  typed at the start of a line is not marked as a suggestion, so the line still works as a quote, heading or list. What
  you type after it is: `> {++new text++}`.

### What's new in 0.13

- **Fenced code blocks are left alone.** CriticMarkup inside a fenced code block (``` or ~~~, including inside
  callouts, quotes and lists) is no longer recognised; inline `code` is unchanged. Before updating, accept or reject any
  pending suggestions or comments inside fenced code blocks. In Suggest mode, an edit that touches a fenced code
  block (its code or a fence line, even if it also covers prose) or pastes a fence line is applied as typed and not
  tracked. Comments cannot be added inside a code block.
- **Fix code-block suggestions made by 0.12 by hand.** Inkling 0.12 could write a suggested code block with the markup
  on its fence lines, such as `{++```js` … ```` ```++} ````. A fence line carrying anything after its backticks opens a
  new code block (as Obsidian renders it), so the rest of the note is read as code. Put `{++` and `++}` on lines of
  their own, around the block, to fix it.
- **Broken markup is cleaned up automatically.** Sync tools can leave stray CriticMarkup brackets or orphaned Inkling
  metadata behind. When a note becomes active, or the open note changes from outside the editor, these are removed.
  Text is never removed, and an Undo right after a cleanup restores the markup and leaves that note alone until Obsidian
  restarts. Only the note you are viewing is cleaned, and markup inside fenced or inline code or math is never touched.
  Turn it off with **Clean up broken markup automatically** (on by default), or run **Clean up broken markup in this
  note** yourself.

## Developing

To set up a development environment:

1. Install the `bun` package manager from https://bun.sh/
2. Clone this repository (`git clone https://github.com/AndrewBroz/obsidian-inkling.git`)
3. Run `bun install` in the root of the repository
4. Run `bun run build:dev` to build the plugin
5. (_Optional_) For automatic plugin reload on each build, use `bun run build:dev:hr` (requires the [Obsidian CLI](https://obsidian.md/cli))

Other commands: `bun run test` (jest suite), `bun run lint` (ESLint), `bun run format` (dprint).

Releases: `bun run release-minor` (or `-patch`/`-major`) bumps versions, commits, and tags; pushing the tag
builds the GitHub release via CI (fallback: `gh workflow run releases.yml --ref <tag>`). Push `main` and
the tag separately, never with `--follow-tags`.

Betas: `bun run release-beta --type minor` makes `0.13.0-beta.0` from `0.12.4`; run `bun run release-beta`
again for `-beta.1`, and `bun run release-minor` to promote it to `0.13.0`. Beta tags publish only to the
beta repository, because BRAT installs pre-releases for everyone tracking "latest". CI needs a
`BETA_REPO_TOKEN` secret: a fine-grained token with Contents read/write on the beta repository.

## Roadmap

This project inherited a roadmap from Commentator and introduced its own priorities. No timeline is given.
Items may be dropped for any reason.

### Parser

- [x] Parsing of CriticMarkup syntax (see [CriticMarkup parser library](https://github.com/Fevol/criticmarkup-parser/))
- [x] Parsing of annotations and extended syntax (see **Syntax**)
- [ ] Improving resilience to invalid markup

### UIX

#### Commands

- [x] Mark selection as `Insertion`/`Deletion`/...
- [x] Accepting/Rejecting all changes in document
  - [x] Via command palette (entire document/selection)
  - [x] Via context menu (selection)
  - [x] Via change markers in the margin (line)

#### Extensions

- [x] Auto-close critic-markup brackets when typing
- [ ] Automatically correct invalid markup
- [ ] Automatically simplify dangling and (partially) empty markup

#### Suggestion View

- [x] Vault-wide index of all suggestions and comments
  - [x] Automatically create/re-synchronize on vault opening
  - [x] Keep up-to-date with immediate changes in vault
- [x] Custom view for viewing suggestions and comments over entire vault
  - [x] Metadata rendering
  - [x] Filter by recency
  - [x] Filter by author (see also custom syntax)
  - [x] Performance improvements
  - [x] UIX/Scrolling improvements
  - [x] Accept/Close selection of suggestions and comments

#### Editor

- [x] Preview of `Accept/Reject` commands in editor
- [x] Toggling suggestion mode on/off in editor
- [x] Toggling comment mode on/off in editor
- [ ] Integration of toggles for suggestion mode, preview and comment mode with other community plugins
- [x] Specify suggestion/comment-only mode in frontmatter (based on authorship)

### Rendering

- [x] Rendering of markup in Live Preview
- [x] Rendering of markup in Reading View (Postprocessor)
- [x] Rendering comments
  - [x] In a column beside the note
  - [x] On hover in document

### Syntax

- [x] Extend CriticMarkup syntax to allow for authorship and timestamp annotation
- [x] Extend `Comment` markup to support comment threads
- [ ] Allow custom highlight colours for `Highlight` markup

### Suggestion Mode

- [x] Converting edit operations into appropriate markings
- [ ] Correct cursor placement through edit and cursor operations
  - [x] Support different options for cursor movement (always stop when markup encountered, ...)
  - [ ] Full Vim Support _(not planned in this fork)_
- [ ] Toggle sequential CM state updating for improved multi-cursor support when inserting/deleting

### Comment Mode

- [x] Add comments to selection
- [x] Smooth cursor movement through markup

## API for other plugins

Other plugins can turn CriticMarkup into the note's original text: suggestions shown as rejected, comments removed, highlights unwrapped.

```ts
const api = app.plugins.getPlugin("inkling-markup")?.api;
if (api && api.version >= 1) {
	const original = api.toOriginalText(markdown);
}
```

`version` changes only on a breaking change. Transclusions of notes containing CriticMarkup are displayed using this original text.
