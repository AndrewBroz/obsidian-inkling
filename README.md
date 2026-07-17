# Inkling: Collaborative Editing for Obsidian

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
3. Enable **Inkling** in Settings → Community plugins

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

## Developing

To set up a development environment:

1. Install the `bun` package manager from https://bun.sh/
2. Clone this repository (`git clone https://github.com/AndrewBroz/obsidian-inkling.git`)
3. Run `bun install` in the root of the repository
4. Run `bun run build:dev` to build the plugin
5. (_Optional_) For automatic plugin reload on each build, use `bun run build:dev:hr` (requires the [Obsidian CLI](https://obsidian.md/cli))

Other commands: `bun run test` (jest suite), `bun run lint` (ESLint), `bun run format` (dprint).

Releases: `bun run release-minor` (or `-patch`/`-major`) bumps versions, commits, and tags; pushing the tag
builds the GitHub release via CI (fallback: `gh workflow run releases.yml --ref <tag>`).

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
  - [x] Via gutter markings (line)

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
  - [x] In right-side gutter of document
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
