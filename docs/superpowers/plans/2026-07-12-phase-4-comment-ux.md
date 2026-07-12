# Phase 4: Google-Docs-Parity Comment UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Comment cards show only real comments (never the anchor text), threads gain a resolve/reopen lifecycle stored in `done` metadata, and empty comments can no longer be created or persisted.

**Architecture:** A small pure edit-logic module (`resolve.ts`) owns resolve/reopen/cancel edit generation (TDD'd). Rendering sites each add a `done`/anchor branch at already-mapped points: gutter marker construction, live-preview decorations, reading-view postprocess, and the Annotations View. Interaction wiring (buttons, blur guards) follows existing in-file patterns — notably the reply editor's empty-cancel guard, which becomes the template for all comment editors.

**Tech Stack:** TypeScript 5.9, CodeMirror 6, Svelte 5, Obsidian API (lucide icons via `setIcon`/`Icon`/`Button`), jest 30.

**User decisions (binding):** anchor text hidden in editor gutter, shown as a muted quote in the vault Annotations View; resolving hides the gutter card AND the highlight rendering (markup stays in the doc — reversible via reopen); empty comments auto-cancel on blur.

## Global Constraints

- Toolchain bun (`export PATH="$HOME/.bun/bin:$PATH"`). Gates before every commit: `bun run build`, `bun run test` (baseline 1107/1107), `bun run lint` (0 errors), `bun node_modules/dprint/bin.cjs check`. dprint-fmt touched files.
- Resolve is REVERSIBLE: never delete markup to resolve; only metadata changes. Delete stays a distinct, explicit action.
- Icons: lucide names via the existing mechanisms (`setIcon`/`Menu.setIcon` in TS, `<Button icon=…>`/`<Icon icon=…>` in Svelte). Resolve = `check`, reopen = `rotate-ccw`, delete-thread = `trash-2` (match Obsidian conventions; if a name doesn't exist in the bundled lucide set, pick the closest and note it).
- The four `// BUG:`/KNOWN-RESIDUAL tests and the 7 snapshots must be unchanged.
- Test conventions: `createRangeState` from tests/helpers.ts; metadata tests need `enable_metadata: true`; deterministic outputs need `add_metadata: false`.
- Thread semantics: `full_thread = [base, ...replies]` (base is HIGHLIGHT for anchored threads, COMMENT otherwise); a thread is resolved iff `base_range.fields.done === true`; resolve/reopen writes to EVERY thread member (robust to later splits).

## Code map (from scout — anchors are file:line in the current tree)

- Gutter cards: `marker.ts:420` `createMarkers` builds threads; `marker.ts:433-452` prunes by included-types (`full_thread.shift()` pattern); `AnnotationMarker.toDOM` `marker.ts:375-384` renders one `AnnotationNode` per thread entry — entry #0 is the anchor card to suppress. Context menu: `onCommentContextmenu` `marker.ts:179-336`.
- Gutter comment editor: `renderSource` `marker.ts:66-100` (`onSubmit` 86-89, `onBlur` 91-95 — both write unconditionally); `renderPreview` write path `marker.ts:164-176` with the double-call guard at 112.
- Live-preview comment editor: `comment-widget.ts` `renderRange` 69-219 (`onSubmit` 85-93, `onBlur` 95-104 — writes unconditionally). **Reference implementation for empty-cancel: the reply editor's `onBlur` at `comment-widget.ts:175-189`** (`if (content.trim())` write, else unload).
- Live-preview decorations: `markup-renderer.ts:101` `constructDecorations`; `range.fields` readable (used at 17/124/125); HIGHLIGHT falls to `markContents` at ~156.
- Reading view: `post-process/renderer.ts:19` `rangePostProcess` (COMMENT → `renderCommentWidget`, others → `range.postprocess()` at `base_range.ts:308-323`).
- Annotations View: `AnnotationThread.svelte` — base renders as top entry (95-127, `unwrap_parts()` at 103-127); `done` already drives `cmtr-view-range-completed` class (line 57). Quick actions: `AnnotationThreadQuickActions.svelte` (Button pattern at 42/65/89/97). Filters: `filter-ranges.ts:48` pipeline; enum pattern at 7-32; view wiring `AnnotationsView.svelte` (filter state 40-60, StateButtons 296-359, menu 455-601).
- Metadata mutations: `add_metadata`/`set_metadata`/`delete_metadata` (`base_range.ts:116-158`, all return `EditorChange[]`); single-range editor dispatch pattern `uix/context-menu.ts:86-94` ("Set completed"); vault-wide pattern `applyRangeEditsToVault` (`uix/workspace.ts:16-74`, `include_replies` default true) + `applyToFile` (`alter-suggestion.ts:51-63`) whose `fn(range, text)` returns the REPLACEMENT TEXT for the range span.
- `range.text` is stored metadata-stripped with brackets (`base_range.ts:37-58`) — so `range.text.slice(0,3) + JSON.stringify(fields) + "@@" + range.text.slice(3)` rebuilds a range's full source with new metadata.

---

### Task 1: Resolve/reopen/cancel edit-logic (pure, TDD)

**Files:**

- Create: `src/editor/base/edit-logic/resolve.ts`
- Modify: `src/editor/base/edit-logic/index.ts` (re-export, match file's style)
- Test: `tests/resolve.test.ts` (create)

**Interfaces (produces — later tasks import these from `../base` or the edit-logic barrel):**

```typescript
thread_resolved(range: CriticMarkupRange): boolean
resolve_thread(range: CriticMarkupRange): EditorChange[]     // done:true on every full_thread member of range.base_range
reopen_thread(range: CriticMarkupRange): EditorChange[]      // delete done from every member
range_source_with_fields(range: CriticMarkupRange, fields: MetadataFields): string
  // rebuilds the range's full markup text with the given fields (empty fields = no metadata blob)
cancel_empty_comment(range: CommentRange): EditorChange[]
  // removes the comment; if its base is a HIGHLIGHT whose only reply it was, also unwraps the highlight
```

- [ ] **Step 1: Write failing tests** — `tests/resolve.test.ts` using `createRangeState(doc, { enable_metadata: true })`; parse → act → apply `EditorChange[]` to the doc string (sort desc, splice — same helper shape as tests/mark_ranges.test.ts) → reparse → assert. Cases:
  1. Plain comment thread `x{>>a<<}{>>b<<}y`: `resolve_thread` on the base → both comments gain `{"done":true}@@`; reparse → `thread_resolved` true; `reopen_thread` → doc returns to the original (delete_metadata removes the whole blob when done was the only field); `thread_resolved` false.
  2. Anchored thread `x{==sel==}{>>c<<}y`: resolve via the REPLY (not base) → all three ranges (highlight + comment) carry done; `thread_resolved(reply)` true.
  3. Ranges with existing metadata `x{=={"author":"A"}@@sel==}{>>{"author":"A"}@@c<<}y`: resolve merges `done:true` into existing fields (author preserved); reopen removes only `done` (author intact).
  4. `range_source_with_fields`: highlight with fields → `{=={"author":"A","done":true}@@sel==}`; with `{}` → `{==sel==}`; substitution keeps its `~>` (build from `range.text`, which already contains it).
  5. `cancel_empty_comment`: fresh empty comment `x{>><<}y` → removal yields `xy`; empty reply on anchored thread with ONLY that reply `x{==sel==}{>><<}y` → yields `xsely` (highlight unwrapped too); empty reply where the thread has ANOTHER comment `x{==sel==}{>>keep<<}{>><<}y` → yields `x{==sel==}{>>keep<<}y` (anchor kept).
- [ ] **Step 2: RED** — module missing.
- [ ] **Step 3: Implement.** `resolve_thread`/`reopen_thread` via `base_range.full_thread.flatMap(r => r.add_metadata("done", true))` / `delete_metadata("done")` — note these MUTATE `fields` and return non-overlapping changes (each range edits its own metadata blob), safe to dispatch together. `thread_resolved` reads `range.base_range.fields.done === true`. `cancel_empty_comment` computes spans from `range`/`base_range` (`full_range_front/back`, `unwrap()`); the unwrap case replaces the highlight's span with `base.unwrap()` and deletes the comment span (two non-overlapping changes, or one spanning change — implementer's choice, tests are the contract).
- [ ] **Step 4: GREEN + full gates.**
- [ ] **Step 5: Commit** — `feat: resolve/reopen and empty-comment cancel edit logic` (+ Co-Authored-By trailer as in all commits: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`).

---

### Task 2: Gutter + document rendering (hide anchor card, hide resolved, buttons)

**Files:**

- Modify: `src/editor/renderers/gutters/annotations-gutter/marker.ts`
- Modify: `src/editor/renderers/live-preview/markup-renderer.ts`
- Modify: `src/editor/renderers/live-preview/comment-widget.ts` (icon suppression only — the blur work is Task 4)
- Modify: `src/editor/base/ranges/base_range.ts` (`postprocess` done-branch)
- Modify: `src/assets/annotation-gutter.scss` (+ any needed classes)
- Modify: `src/editor/uix/context-menu.ts` ("Set completed" → Resolve/Reopen)

**Interfaces:** Consumes Task 1's `thread_resolved`/`resolve_thread`/`reopen_thread`.

**Behavior contract (each bullet must be demonstrably true after this task):**

1. **Anchor card suppressed:** in `createMarkers` (after the included-types pruning at marker.ts:433-452), when the base is a HIGHLIGHT **with replies**, drop the base entry (`full_thread.shift()` — same idiom the file already uses). A highlight with NO replies keeps its current card (it's a standalone annotation, still governed by included-types).
2. **Resolved threads have no gutter card:** in `createMarkers`, skip marker creation entirely when `thread_resolved(range)`. (Both the `create()` and `update()` StateField paths flow through `createMarkers` — verify the update path at marker.ts:486-520 doesn't re-add via a different route; if it maps old markers, ensure resolved ones are dropped there too.)
3. **Resolved highlight/comment renders as plain text:** in `constructDecorations` (markup-renderer.ts), when a range's `base_range` is resolved: still hide brackets + metadata, but do NOT apply the type style — apply class `cmtr-resolved` instead (styled as plain text; keep the class so themes can hook it). In `CommentIconWidget` construction path (comment-widget.ts / its caller in markup-renderer), skip the icon for resolved comments. In `base_range.postprocess` (reading view), emit class `cmtr-resolved` instead of `cmtr-<type>` when `this.fields.done` (or the base range's — postprocess runs per-range; comments carry their own done since resolve writes to every member).
4. **Per-card actions:** in `AnnotationMarker.toDOM` (marker.ts:375-384), add a compact action row to `.cmtr-anno-gutter-thread` — Resolve (`check`, tooltip "Resolve thread") and Delete thread (`trash-2`, tooltip "Delete thread") — using `setIcon` + `aria-label`, styled via a new `.cmtr-anno-gutter-thread-actions` scss block (visible on hover/focus like Google; keep it subtle). Resolve dispatches `resolve_thread` changes on the view; Delete dispatches removal of `full_range_front..full_range_back` (the existing "Remove all comments"/"Close comment thread" span logic at marker.ts:264-278 — reuse its computation; for anchored threads deleting the thread must also unwrap the highlight, i.e. replace the base span with `base.unwrap()` — reuse/extend, don't duplicate: extract a small helper if the existing menu item's code is reused).
5. **Context menus updated:** `onCommentContextmenu` gains "Resolve thread"/"Reopen thread" (conditional on current state); `uix/context-menu.ts:86-94`'s "Set completed" item becomes "Resolve thread" using `resolve_thread` (and a "Reopen thread" counterpart when resolved).

**Testing:** rendering is DOM/CM-bound — cover what's testable headlessly: add `tests/resolve_rendering.test.ts` asserting `constructDecorations`-level behavior IF it's exercisable via EditorState + the renderer extension (attempt it; the cursor test builds EditorViews, so decoration iteration may be feasible — timebox to ~30 min, and if not feasible, say so in the report and rely on the gates + manual smoke). Everything else: manual smoke notes in the report.

- [ ] Implement per contract → gates → commit `feat: hide anchor cards and resolved threads in gutter; resolve/reopen actions` (+ trailer).

**STOP conditions:** if suppressing the base card breaks marker positioning (markers are keyed `range.from..range.to`), or the update() path resists resolved-filtering after one honest attempt, report BLOCKED with specifics instead of hacking the StateField.

---

### Task 3: Annotations View (quote header, resolved filter, quick actions)

**Files:**

- Modify: `src/ui/pages/annotations-view/AnnotationThread.svelte`
- Modify: `src/ui/pages/annotations-view/AnnotationThreadQuickActions.svelte`
- Modify: `src/ui/pages/annotations-view/filter-ranges.ts`
- Modify: `src/ui/pages/annotations-view/AnnotationsView.svelte`
- Modify: `src/ui/pages/annotations-view/context-menu.ts` (resolve/reopen items)
- Modify: `src/assets/view.scss`
- Modify: `src/editor/uix/workspace.ts` or reuse — vault-wide resolve via `applyRangeEditsToVault`
- Test: extend `tests/` for the filter logic (pure part)

**Interfaces:** Consumes Task 1's functions incl. `range_source_with_fields` for the vault-wide path: the `applyToFile` transform for resolve is `(range, text) => range_source_with_fields(range, { ...range.fields, done: true })` and for reopen strips `done` — with `include_replies: true` so the whole thread is covered. IMPORTANT: `applyToFile`'s fn replaces the span `range.from..(remove_attached_comments ? full_range_back : range.to)` — check `applyToFile`/`applyToText`'s exact span semantics (alter-suggestion.ts:51-63, range-operations.ts) and ensure per-range replacement (NOT whole-thread span) is used for metadata rewrites; if `applyToText` only supports whole-range replacement per entry, that is exactly right since each thread member is its own entry when `include_replies` expands them.

**Behavior contract:**

1. **Anchored quote:** in `AnnotationThread.svelte`, when `row.range.type === HIGHLIGHT && row.range.replies.length`, the base entry renders as a muted quote (new class `cmtr-view-range-anchor-quote`: smaller, italic/greyed, left-bar quote styling, CSS `-webkit-line-clamp: 2` truncation) WITHOUT the author/timestamp metadata row — replies below render unchanged. Standalone highlights (no replies) render as today.
2. **Resolved filter:** new `ResolvedFilter { ALL, UNRESOLVED, RESOLVED }` in filter-ranges.ts (enum pattern at 7-32), applied in the pipeline via `thread_resolved` on the entry's base (place it OUTSIDE the `enable_metadata`-gated block — when metadata parsing is off, everything is simply unresolved). Default: `UNRESOLVED` (Google behavior). UI: a StateButton in AnnotationsView.svelte cycling All (`list`) / Unresolved (`circle`) / Resolved (`circle-check`) following the existing StateButton pattern (296-359), plus a "Filter by resolved" section in the More-options menu if the existing menu pattern (455-601) makes that natural.
3. **Quick actions:** `AnnotationThreadQuickActions.svelte` gains Resolve (`check`) on unresolved threads / Reopen (`rotate-ccw`) on resolved ones (shown on the BASE entry only, not per-reply), wired through `applyRangeEditsToVault` with the transforms above. Existing delete buttons stay; the resolved-state card keeps its `cmtr-view-range-completed` class (line 57 — already wired).
4. **Context menu:** annotations-view/context-menu.ts gains matching Resolve/Reopen items.

**Testing:** the filter addition gets a pure test (build entries from parsed docs, run `filterRanges` with each ResolvedFilter value). Svelte rendering: manual smoke note.

- [ ] Implement per contract → gates → commit `feat: anchored quotes, resolved filter, and resolve actions in annotations view` (+ trailer).

---

### Task 4: Empty comments — prevent and auto-cancel

**Files:**

- Modify: `src/editor/renderers/live-preview/comment-widget.ts` (`renderRange` onBlur/onSubmit, ~85-104)
- Modify: `src/editor/renderers/gutters/annotations-gutter/marker.ts` (`renderSource` onBlur/onSubmit 86-95 + the `renderPreview` write path 164-176)
- Test: `tests/` — the cancel logic is Task 1's `cancel_empty_comment` (already tested); this task's additions are wiring, covered by targeted tests only if cheaply feasible

**Behavior contract (mirror the reply editor's guard at comment-widget.ts:175-189 everywhere):**

1. Blur or submit with **empty** text on a comment that was **freshly created empty** (its parsed `unwrap()` is empty): dispatch `cancel_empty_comment(range)` — comment removed; anchored highlight unwrapped if this was its only comment. No Notice needed (Google is silent).
2. Blur or submit with empty text on a comment that **previously had content**: do NOT write; revert the editor/preview to the existing content (no dispatch). An explicit delete remains available via menu/buttons.
3. Non-empty text: current behavior unchanged (including the marker.ts:112 double-call guard — do not regress it; if your change makes the `new_text` guard dance simpler, simplify it and explain, but the FIXME's scenario must not re-break: mod+enter on a new comment must write exactly once).
4. `addCommentToView` still creates the empty comment + focuses the editor (unchanged) — the guard lives in the editors.

- [ ] Implement per contract → gates → commit `feat: auto-cancel empty comments on blur` (+ trailer).

**STOP condition:** if the gutter editor's blur fires during the focus-timing setTimeout dance (add-comment.ts:71-81) and auto-cancel eats brand-new comments before the user can type, STOP and report — the fix may need the focus annotation to suppress the first blur, and that interaction deserves eyes before hacking.

---

### Task 5: Completion

- [ ] Clean-state full gate (`rm -rf node_modules && bun install && bun run build && bun run test && bun run lint && dprint check`).
- [ ] Append `## Phase 4 outcomes` to the execution notes: behavior contracts as landed, manual smoke checklist (anchored comment shows no anchor card; resolve hides card + highlight, reopen restores; vault view quote + resolved filter; empty-comment cancel in both editors incl. the timing STOP-condition check), deviations. dprint-fmt, commit `docs: record phase 4 outcomes` (+ trailer).
- [ ] Release: `bun run release-minor` (→ 0.5.0), push main + tag, then `gh workflow run releases.yml --ref 0.5.0` (tag triggers are broken on this repo), verify assets, curate release notes via `gh release edit`.
