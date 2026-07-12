# Commentator (AndrewBroz fork) — CriticMarkup plugin for Obsidian

> [!IMPORTANT]
> **This is a fork** of [Fevol/obsidian-criticmarkup](https://github.com/Fevol/obsidian-criticmarkup) ("Commentator"),
> maintained independently by [@AndrewBroz](https://github.com/AndrewBroz). It diverges from upstream with additional
> data-safety fixes and collaboration features (see [What's different](#whats-different-in-this-fork)).
> For the original plugin, use the upstream repository. Bugs in **this fork** belong in
> [this repo's issue tracker](https://github.com/AndrewBroz/obsidian-criticmarkup/issues) — please don't report
> fork issues upstream.

A [CriticMarkup](https://github.com/CriticMarkup/CriticMarkup-toolkit) editor for [Obsidian](https://obsidian.md/) for
collaborative editing and reviewing your notes: a suggestion mode for tracking changes (like Word's Track Changes /
Google Docs' Suggesting), comments anchored to text selections, and a comment-only mode for reviewers.

Commentator was built by [@Fevol](https://github.com/Fevol) upon the excellent work and advice of
[@kometenstaub](https://github.com/kometenstaub) (original [plugin](https://github.com/kometenstaub/obsidian-criticmarkup)
and [parser](https://github.com/kometenstaub/lang-criticmarkup)). All credit for the plugin's foundation belongs to them.

## Installing (via BRAT)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) community plugin
2. In BRAT: **Add beta plugin** → `AndrewBroz/obsidian-criticmarkup`
3. Enable **Commentator** in Settings → Community plugins

> [!WARNING]
> This fork is in beta. It carries an extensive automated regression suite (1,100+ tests, including
> round-trip safety tests for accept/reject), but has not yet finished manual validation in live vaults.
> Use it in a test vault or a synced/backed-up vault first. Note the plugin id is `commentator` — it
> cannot be installed side-by-side with upstream Commentator.

## What's different in this fork

**Data-safety fixes** (the headline reason this fork exists):

- Rejecting all suggestions no longer resurrects text from retracted additions
- "Accept/reject selected" no longer misfires at the very start of a document (previously accepted _everything_)
- Substitution ranges are no longer corrupted (separator/metadata destruction) by the markup auto-correcter
- Vault-wide accept/reject refuses to apply stale positions to files that changed after indexing

**Collaboration features:**

- **Comments anchored to selections** — select text → _Add comment_ → `{==highlight==}{>>comment<<}` thread
- **Comment mode** — a reviewer-friendly mode where text edits are blocked (with feedback) but commenting works
- **Frontmatter-enforced modes** — a note can force `suggest`/`comment`/`off` for everyone except listed authors (see [Frontmatter](#frontmatter))
- **Attribution on by default** — new installs stamp author + timestamp metadata and prompt once for your display name; the vault-wide Suggestion View can filter by author and recency

**Maintenance:** modernized toolchain (ESLint 10 with Svelte linting, dprint, vendored dependencies), repaired release CI, and a large regression-test suite where none could previously run.

## Frontmatter

Enforce an editing mode for a note via frontmatter (overrides the per-editor toggle):

```yaml
---
commentator: suggest   # or: comment, off
commentator-authors: [Alice]   # optional: these authors are exempt from enforcement
---
```

## Developing

To set up a development environment:

1. Install the `bun` package manager from https://bun.sh/
2. Clone this repository (`git clone https://github.com/AndrewBroz/obsidian-criticmarkup.git`)
3. Run `bun install` in the root of the repository
4. Run `bun run build:dev` to build the plugin
5. (_Optional_) For automatic plugin reload on each build, use `bun run build:dev:hr` (requires the [Obsidian CLI](https://obsidian.md/cli))

Other commands: `bun run test` (jest suite), `bun run lint` (ESLint), `bun run format` (dprint).

Releases: `bun run release-minor` (or `-patch`/`-major`) bumps versions, commits, and tags; pushing the tag
builds the GitHub release via CI (fallback: `gh workflow run releases.yml --ref <tag>`).

## Roadmap

Inherited from upstream and updated for this fork. No timeline is given; infeasible items may be dropped.

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
