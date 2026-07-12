# Repair & Word/GDocs-Parity Design — obsidian-criticmarkup (Commentator fork)

**Date:** 2026-07-11
**Status:** Approved by Andrew (sections 1 and 2 approved in conversation)

## Context & Decisions

This fork of [Fevol/obsidian-criticmarkup](https://github.com/Fevol/obsidian-criticmarkup) is treated as a
**hard fork**: full freedom to restructure and modernize; future upstream merges are manual/selective.

- **Toolchain:** bun stays the blessed toolchain (install via Homebrew locally). Full tooling
  modernization is in scope, except TypeScript 7 migration (deferred).
- **Priorities:** resilience and zero data loss above all; then Word/Google-Docs feature parity.
- **Out of scope:** Vim support (explicitly dropped from the roadmap), TypeScript 7, splitting
  large files beyond what the feature work requires.

A full code review (2026-07-11 session) found the defects listed below; each phase item links back
to a verified finding.

## Sequencing

Approach: **safety-first phases**, in strict order. Every later phase depends on the test
foundations of Phase 1. Each mechanical step in Phase 2 is its own commit with build + tests green
as the gate.

---

## Phase 0 — Working dev loop

All verified broken as of 2026-07-11:

1. Install bun (Homebrew), `git submodule update --init`, `bun install`; confirm `bun run build`
   passes as baseline.
2. Rename `jest.config.js` → `jest.config.cjs`. (CJS `module.exports` crashes under
   `"type": "module"`; jest cannot currently run at all.) Confirm `tests/cursor_movement.test.ts`
   is green.
3. Fix `dev` script in `package.json` — points at nonexistent `esbuild.config.mjs`; should use
   `scripts/build/esbuild.config.ts`.
4. Declare `@codemirror/search` in `dependencies` (imported by
   `src/ui/pages/annotations-view/filter-ranges.ts:5`, currently undeclared).
5. Rewrite `.github/workflows/releases.yml`:
   - remove dead `cd ./src/editor/base/parser` build step (parser is an npm package now);
   - replace archived `actions/create-release@v1` / `upload-release-asset@v1` with
     `softprops/action-gh-release`;
   - drop removed `::set-output` syntax;
   - release notes from git log (repo has no CHANGELOG.md).
6. Sync `manifest-beta.json` with `manifest.json` (minAppVersion 1.7.5, current description).

## Phase 1 — Data-safety fixes + test tripwire

1. **Falsy-zero bug** in `acceptSuggestions`/`rejectSuggestions`
   (`src/editor/base/edit-logic/alter-suggestion.ts:9-27`): `(from || to)` treats position 0 as
   "no selection", falling back to _all ranges in the document_. Fix with
   `from !== undefined || to !== undefined`; regression test for selection at position 0.
2. **Stale-index vault edits**: add mtime guard to `applyRangeEditsToVault`
   (`src/editor/uix/workspace.ts:8-35`), mirroring the check `undoRangeEditsToVault` already does
   (`workspace.ts:61-65`). If stale, re-index the file before applying; never apply blind offsets.
3. **`rangeCorrecter` corruption case** (`src/editor/uix/extensions/range-correcter.ts:10`):
   reproduce the FIXME's documented failing input as a test first, then fix.
4. **`delete_metadata()` no-op** (`src/editor/base/ranges/base_range.ts:125-136`): returns `[]`
   while discarding computed edits; fix the returns or delete the method (currently uncalled).
5. **Diagnosability**: log the swallowed migration error (`src/main.ts:315`); remove unconditional
   `console.log` in `GeneralSettings.svelte:156`; delete dead commented block
   (`src/patches.ts:107-127`).
6. **`(extension as any)[1][1].value` reach-through** (`src/main.ts:114`): replace with an explicit
   export from `annotationGutter` so internal reordering can't silently break gutter config.
7. **`mark.ts` test harness** (largest item): unit tests for `mark_ranges`
   (`src/editor/base/edit-logic/mark.ts`) covering insert/delete/substitution across each range
   type, plus the branches flagged by its own TODO/FIXME comments (downgrade-past-bracket, the
   `-2` separator hotpatch, insertion-into-substitution intent). These tests are the tripwire for
   all later phases.

## Phase 2 — Modernization (mechanical, no behavior change)

1. ESLint 8 → 10, flat config; drop deprecated `eslint-plugin-deprecation` (rule now in
   typescript-eslint); actually lint `.svelte` files (currently `ignorePatterns` excludes them
   despite the svelte plugin being configured).
2. Drop `prettier` (dprint is the scripted formatter) and `esbuild-jest` (unmaintained, pinned
   against an esbuild it was never built for; ts-jest covers TS).
3. Bump: jest → 30, commander → 15, `@types/node` → 26, esbuild → 0.28, dprint → 0.55.
   **Not** TypeScript 7.
4. Vendor the two git submodules (`src/ui/components`, `src/database`) as regular committed
   source; delete `.gitmodules`; update README (drop `--recurse-submodules`).
5. Purge stale config: `parser/` in eslint ignorePatterns, `parser/build/` in `.gitignore`.
6. Gate: `bun run build` + full test suite green after every step; one commit per step.

## Phase 3 — Word/GDocs parity features

Ordered by dependency. Each lands with unit tests through the Phase 1 harness plus a manual smoke
checklist in a test vault. Nothing modifies the suggestion-mode edit path except through tested
entry points.

### 3a. Author attribution on by default

- New-install defaults: `enable_metadata`, `enable_author_metadata`,
  `enable_timestamp_metadata` = true. Existing users' saved settings untouched (settings merge
  preserves saved values).
- First-run prompt for display name, pre-filled from a system hint; stored in settings, editable
  in the Metadata tab.
- Unblocks the already-implemented author/recency filters in the Annotations View
  (`filter-ranges.ts:100-157`) — check both README roadmap boxes.

### 3b. Comments anchored to selections

- **Syntax:** wrap selection in a highlight range with the thread attached:
  `{==selected text==}{>>comment<<}`. CriticMarkup-toolkit-idiomatic; no custom syntax.
- **Implementation:** `addCommentToView` (`src/editor/base/edit-logic/add-comment.ts`) wraps the
  selection when one exists; gutter + hover renderer treat highlight+thread as one unit
  (hover gutter comment ⇄ highlight anchored text).
- **Edge cases:**
  - selection overlapping existing markup → snap anchor to avoid splitting markup (reuse
    `range-grouping.ts` interval logic);
  - empty selection → current at-cursor behavior;
  - anchored text deleted in suggestion mode → thread degrades to un-anchored comment, no error.

### 3c. Comment mode (comment-only editing)

- New `EditMode.COMMENT` (`src/types.ts:13-17`); `getEditMode` maps it to a transaction filter
  blocking document-changing transactions except comment insert/edit/resolve operations
  (identified by our own transaction annotation, same mechanism suggestion mode uses).
  Selection/navigation unrestricted.
- Blocked edits show a brief Notice (no silent failure).
- UI: joins status-bar mode cycle + dedicated toggle command. Checks off the "Toggling comment
  mode" roadmap item.

### 3d. Frontmatter-enforced mode

- Frontmatter: `commentator: suggest | comment | off`; optional `commentator-authors: [...]` —
  when present, enforcement applies only to users _not_ listed (owner writes freely, reviewers
  forced into the declared mode).
- On file-open and `metadataCache` change, dispatch per-editor mode via existing
  `plugin-settings.ts` facet infrastructure. Manual toggle locked while enforced, with tooltip.
- **Precedence:** frontmatter > manual per-editor toggle > global default.

---

## Explicitly deferred / dropped

- Vim motion support (dropped — user decision).
- TypeScript 7 migration (deferred).
- Splitting `mark.ts` / `annotation-gutter.ts` into modules (only as needed by feature work).
- Custom highlight colours, community-plugin toggle integration, sequential multi-cursor updates
  (roadmap items not in this effort; revisit after Phase 3).
