# Phase 0+1 Execution Notes

Plan: `2026-07-11-phase-0-1-repair-and-safety.md` — all 12 tasks complete on branch `repair-and-parity`.
Final state: `bun run build` clean; `bun run test` 1081/1081 across 6 suites (baseline at phase start: suite could not load at all).

## Bugs discovered during execution (input for Phase 2/3 planning)

### Fixed in this phase (beyond the plan's original scope)

1. **Substitution separator destruction in rangeCorrecter** (fixed in `a1d2996`).
   `SubstitutionRange.unwrap()` strips the `~>` separator (substitution_range.ts:26-28), so the
   _original shipped code_ corrupted every substitution range it "corrected" — deleting the
   separator along with the metadata. The plan's replacement code shared the bug; the landed fix
   rebuilds via `unwrap_parts().join("~>")`. Regression-tested with a separator-survival assertion.

### Known at end of Phase 1, since fixed (FIXED in Phase 3A)

2. **Reject-all resurrects never-accepted text** (FIXED in Phase 3A, Task 1 of
   `2026-07-11-phase-3a-parity.md`, commit "fix: deleting or substituting over pending additions
   retracts them instead of folding their text" on branch `phase-3a-parity`; the four `// BUG:`
   snapshot cases are now explicit round-trip-invariant tests) — 4 characterization cases in
   `tests/mark_ranges.test.ts` (annotated `// BUG:`): marking DELETION or SUBSTITUTION across a
   pending `AdditionRange` folds the addition's text into the new range. `AdditionRange.reject()`
   returns `""` but `DeletionRange.reject()` returns `unwrap()` (and
   `SubstitutionRange.reject()` returns the deleted part), so rejecting all suggestions
   afterwards keeps text that reject-all would previously have discarded:
   - `ab{++cd++}ef` + delete-all → `{--abcdef--}`: reject-all now yields `abcdef`, was `abef`
   - `ab{++cd++}ef` + delete `cd` → `ab{--cd--}ef`: same resurrection of `cd`
   - `x{~~y~>z~~}u` + substitute-all → `{~~xyzu~>new~~}`: resurrects `z`
   - `uv{++w++}{++y++}z` + substitute-all → `{~~uvwyz~>q~~}`: resurrects `w`, `y`
     Root fix belongs in `mark_range`'s fold-in logic (drop pending-addition text when folding into
     deletion/substitution). Should be scheduled early in Phase 3 (before comment mode builds on
     suggestion semantics) or as a Phase 2 rider. Do NOT update the snapshots to hide this.

**Status update (Phase 3A):** FIXED for full-coverage cases in commits 48e81e9 + c2009533
(retraction semantics + insert wrapped as pending addition; invariant-asserting tests landed).
**Residual, still open:** a DELETION/SUBSTITUTION that only _partially_ covers a pending
addition still folds the covered slice (e.g. `ab{++cd++}ef` delete 0–6 → reject-all yields
`abcef`, not `abef`). Full-coverage retraction only; schedule the partial-coverage case with
Phase 3B or later.

## Recorded spec deviation (Task 6)

The Phase 1 spec (plan item 2) called for stale files to be re-indexed and then have the
edit applied. The landed implementation deliberately downgrades this to skip-with-Notice
instead: `isEntryStale` blocks the write and surfaces a Notice telling the user to retry,
rather than triggering a re-index inline. This satisfies the safety invariant ("never apply
blind offsets" — a write never proceeds against a database entry that may be out of date)
without taking on the complexity of a synchronous re-index-then-apply path. Auto-re-index-and-apply
remains a Phase 2/3 candidate once the indexing pipeline has a cheap, awaitable single-file
re-index primitive to build on.

## Manual verification still pending (needs a human in Obsidian — cannot run headless)

- **Task 6 (staleness guard):** in a test vault, accept from the Annotations View on an untouched
  file (should work); edit a file then immediately accept from the view (~within 1s) — expect the
  skip Notice, not corruption.
- **Task 9 (gutter config):** resize + fold the annotation gutter, switch notes, confirm
  width/fold state carries over.

## Minor findings deferred to the final whole-branch review / Phase 2

- `styles.css` (build artifact) is not gitignored — recurring noise in `git status`.
- `moduleNameMapper` pattern `"embeddable-editor$"` in jest.config.cjs is loosely anchored.
- `__mocks__/obsidian.ts` grew to ~170 lines of inert stand-ins; needs a short doc note about
  keeping it in sync with real Obsidian API usage.
- Pre-existing `<Partial<App>>` + `@ts-ignore` cast pattern in tests/setup.ts.
- Plan-specified `as { extension; config }` cast in annotation-gutter.ts:56 — runtime-safe but a
  generic would be cleaner.
- No test covers the substitution-without-metadata rejoin path in rangeCorrecter.
- Task 6's report contains one garbled test-output quote (tree independently verified green).

## Environment quirk discovered by the clean-install gate (Task 12)

This arm64 Mac has an x64 (Rosetta) node at `/usr/local/bin/node` (Intel-Homebrew). dprint's
node-based postinstall therefore looked for `@dprint/darwin-x64` while bun (arm64) installs
`darwin-arm64`, failing every clean `bun install`. Fixed in-repo by setting
`"trustedDependencies": []` in package.json — bun no longer runs any dependency lifecycle
scripts (none are needed: esbuild ships platform binaries as optional deps; the repo's own
root postinstall still runs). dprint's CLI works via bun (`bun node_modules/dprint/bin.js`,
or `bun run format`). **Recommended machine fix:** replace the Rosetta node with an arm64
build; the `trustedDependencies` hardening is worth keeping regardless (supply-chain benefit).

## Phase 2 outcomes

All 9 modernization tasks landed on branch `phase-2-modernization`. Versions: eslint 10.6.0
(flat config, svelte files now actually linted), typescript-eslint 8.63, eslint-plugin-svelte
3.20, commander 15.0.0, @types/node 26.1.1, esbuild 0.28.1, dprint 0.55.1 (markup_fmt 0.27.3
formats Svelte 5 runes; 136-file style-only reformat landed). prettier and esbuild-jest removed.
Submodules vendored (byte-verified). Tests: shared `createRangeState` helper in tests/helpers.ts.

- **jest 30 landed 2026-07-12** (30.4.2 + jest-environment-jsdom 30 + @types/jest 30, zero
  config changes) after the Rosetta x64 node was replaced with arm64 (v26.5). It had been
  pinned to 29 because jest 30's `unrs-resolver` native module couldn't load under the x64
  node while bun installed arm64 bindings — the same root cause as the dprint postinstall
  failure.
- **Lint burn-down list** (12 rules downgraded to warn, 89 pre-existing findings — see task-3
  report table): prioritize `svelte/no-at-html-tags` (XSS-adjacent, AnnotationThread.svelte ×2)
  and the 3 `no-undef` hits (`Row` ×2, `Interval` ×1 — real missing references).
- Minor deferrals: why-comment for the `as unknown as Required<C>` double-cast in gutters/base.ts
  (verified TS2352 compiler necessity); manual smoke check that bulk-stale accept shows ONE
  summary Notice.
- Vendoring deviation: the plan estimated 33 files under src/ui/components; the submodule's
  actual tracked tree was 26 (the estimate counted untracked working-tree artifacts). All
  tracked content was vendored byte-identically (verified in review).

## Phase 3A outcomes

- **Reject-all corruption (bug 2) FIXED** for full-coverage cases (commits 48e81e9 + c2009533):
  deletion/substitution marks now retract fully-covered pending additions; replacement text is
  wrapped as a pending addition. Invariant-asserting tests (accept-all preserved, reject-all
  restores pre-mark semantics) landed in tests/mark_ranges.test.ts. Partial-coverage residual
  recorded above (bug 2 status update).
- **Attribution on by default** (commit 073939b): six defaults flipped (enable_/add_ metadata,
  author, timestamp). Existing users unaffected (saved settings win in the merge). First-install
  detection lives in migrateSettings (loadSettings is dead code — cleanup candidate); the
  AuthorNameModal prompts once on fresh installs.
- **Comments anchor to selections** (commit 7b59c20): clean selection wraps as
  `{==selection==}{>>comment<<}`; the parser's adjacency rule attaches the comment as a thread
  on the highlight, so gutter/hover render it with zero renderer changes. Selection touching
  existing markup falls back to at-cursor (CriticMarkup cannot nest — recorded spec refinement).
  Safety note: head-inside-markup cannot reach the fallback via real callers (at_cursor's
  inclusive boundaries guarantee `range` is defined there); the guarantee lives in caller
  discipline — flagged for a defensive guard later.
- Spec refinement: the first-run modal opens with an empty name field — no reliable
  cross-platform "system hint" exists inside Obsidian's sandbox; deliberately skipped.

### Manual smoke checklist (needs a human in Obsidian)

- Fresh vault → author-name prompt appears once; existing vault → no prompt, settings intact.
- New suggestion/comment carries `{"author":"...","time":...}@@` metadata; author/recency
  filters in the Annotations View now work out of the box.
- Select text → "Add comment" → highlight + focused comment thread; hover shows the thread.
- (Carried from earlier phases) staleness-guard Notice; gutter fold/resize persistence;
  bulk-stale accept shows ONE summary Notice.
- Edit a legacy metadata-free doc with an author set — author-SPLIT compatibility means edits
  land as separate adjacent ranges (expected).
- Delete across an anchored highlight+comment in suggestion mode — thread must degrade
  gracefully, no render error.

## Phase 3B outcomes

- **Comment mode** (commits b03092a + 050f8cd): `EditMode.COMMENT = 3`. The `commentMode`
  transaction filter gates user-initiated doc edits (input/delete/paste/move) — allowed only when
  the whole changed span sits inside one comment range's content; `commentModeAnnotation`-marked
  transactions (add-comment dispatches) and programmatic transactions pass; blocked edits show a
  throttled Notice (2s, module-level — shared across panes by design). Undo/redo not gated
  (history only holds allowed transactions). The annotation lives in comment-mode.ts (cycle-safety
  verified: cross-cycle bindings only read inside function bodies). `markup_focus` gained a
  COMMENT entry with `backfillMarkupFocus` protecting legacy saved settings. Toggle command +
  4-mode status-bar/header cycle + default-mode dropdown option landed; cycle tooltips updated to
  name the correct successor mode.
- **Frontmatter-enforced modes** (commit 99b85a3): `commentator: suggest | comment | off` with
  optional `commentator-authors` exemption list (listed authors write freely; empty local author
  never exempted). Precedence frontmatter > manual toggle > global default. Enforcement is a
  per-editor facet; the `setEditMode` guard locks BOTH the commands and the status-bar/header
  buttons (all call sites verified); removing the key restores the default mode via a
  pre-dispatch un-enforcement. Documented limitation: inactive panes showing the same file keep
  stale enforcement until refocused (file-open + active-file metadata events only).

### Manual smoke additions (Phase 3B)

- "Toggle comment mode" blocks typing with a Notice; comment edits still work; 4-mode cycle on
  status-bar and header buttons.
- Note with `commentator: comment` opens comment-locked; toggles show the enforcement Notice;
  removing the key restores the default; your own name in `commentator-authors` exempts you.

## Phase 4 outcomes (comment UX, 2026-07-12)

- **Anchor text never renders as a comment**: gutter cards show only real comments (HIGHLIGHT
  base with replies is dropped from the card thread); the vault Annotations View shows the anchor
  as a muted 2-line-clamped quote without author/timestamp.
- **Resolve/reopen lifecycle** stored in `done` metadata on every thread member (reversible;
  delete is a separate explicit action). Resolved threads: no gutter card, highlight renders as
  plain text (`cmtr-resolved`), comment ranges render as NOTHING in live preview and reading
  view. Actions: hover Resolve/Delete buttons on gutter cards (lucide check / trash-2),
  Resolve/Reopen in both context menus and Annotations View quick actions (base-row only);
  "Set completed" menu item replaced. Annotations View gained a ResolvedFilter
  (All/Unresolved/Resolved, default Unresolved — resolved threads vanish from the view by
  default; the StateButton is always visible in the toolbar). Resolve/reopen is offered only for
  HIGHLIGHT/COMMENT-based threads (`thread_resolvable`) — suggestion threads close via
  accept/reject, and a done-flagged suggestion (legacy "Set completed" data) keeps its gutter
  card and suggestion styling. Standalone resolved comment threads (no visible highlight left in
  the note) are reopened from the Annotations View's Resolved filter.
- **Empty comments**: blur/submit/Escape on a fresh empty comment silently cancels it
  (anchored highlight unwrapped if it was the only comment); clearing an EXISTING comment then
  blurring reverts, never deletes. Guarded against reentrant blur double-dispatch (a review-caught
  CRITICAL: Escape on an empty reply could double-dispatch with stale coordinates and delete
  unrelated text — fixed with dispatch-first ordering + a WeakSet latch; mutation-verified tests).
- Edge notes: includeComments=false now hides anchored threads' cards entirely (anchor is
  suppressed and replies are excluded — recorded UX change); reading-view block-transition
  TempRanges can't see metadata (pre-existing limitation, applies to resolved detection too);
  `removeThreadChanges` helper is marker.ts-local (promote if the view needs it later).

### Manual smoke additions (Phase 4)

- Anchored comment: gutter card shows ONLY the comment (no "Sed"-style anchor entry).
- Resolve from gutter button: card + highlight disappear; find + reopen it in the Annotations
  View under the Resolved filter; reopen restores highlight and card.
- Empty-comment cancel: add comment → click away without typing → markup gone silently (both
  the gutter editor and the live-preview tooltip); clear an existing comment → blur → content
  restored; Escape on an empty reply → no stray text deleted (the reentrancy fix).
- Delete thread from gutter trash button on an anchored thread → highlight unwraps to plain text.

## Phase 5 outcomes (visual polish + comment pill, 2026-07-12)

- **Plugin-list identity finished**: author "Andrew Brož", description ends at "...CriticMarkup
  syntax." (heritage lives in README/LICENSE).
- **Diff gutter off by default** with a one-time migration (`diff_gutter_migrated` flag): legacy
  saved `true` flips to `false` once; re-enabling afterwards sticks. Setting remains for opt-in.
- **Highlight box fixed — real root cause**: `{==...==}` ALSO parses as Obsidian's native
  `==highlight==`, stacking two 0.4-alpha washes into a darker squared box (pixel-verified
  against the report screenshot). Fixed with a dual-direction neutralizer on the nested native
  span; `.cmtr-highlight` also gained a uniform small radius.
- **Folded-gutter unfold button** reparented pane-relative (`position: absolute` in `.cm-editor`)
  — the old `position: fixed` (a regression from 3d329e2b that also dropped the right-offset
  wiring) misplaced it over text and would misplace it in splits/sidebars; also fixed an
  always-invalid two-value `top: calc(...)` shorthand.
- **Add-comment pill**: CM6 `showTooltip` extension; appears on non-empty selections that touch
  no existing markup in editable docs; one `message-square-plus` button calling the existing
  anchored-comment flow; selection survives the click (mousedown preventDefault); returns the
  same tooltip object when unchanged (no flicker); excluded from embedded editors by the existing
  filteredExtensions path. Known follow-ups: mouse-first (keyboard reachability unverified);
  the eligibility predicate is duplicated with addCommentToView's wrap-path guard (drift risk).
- The release-bump script now emits LF JSON (dprint's json config is LF; the earlier CRLF fix
  was wrong for JSON) — release bumps no longer break the format gate.

### Manual smoke additions (Phase 5)

- Highlight with attached comment renders one uniform wash, rounded, no squared bottom (light +
  dark themes; also check a standalone native ==highlight== still renders natively).
- Folded gutter: unfold button hugs the right margin, never over text — try narrow panes,
  split panes, right sidebar open, readable line width on/off; unfolded button sits just left
  of the gutter panel.
- Select text → pill appears above selection; click → comment editor focused with highlight
  anchor; pill absent when selection touches markup, in read-only views, and inside embeds.
- Fresh install AND upgraded install: no red/green diff bars; re-enable in settings → bars
  persist across restarts.
- Plugin list shows "By Andrew Brož" and the one-sentence description.

### Known follow-ups (Phase 5)

- **(a) Reading-view fully-enclosed-block double-wash:** `{==...==}` in reading view can stack with
  Obsidian's native `==highlight==` wash (renderer.ts:78–133, pre-existing path for block-transition
  TempRanges). Smoke-test item: add "full-paragraph highlight in reading view" to the Phase 6+
  smoke checklist.
- **(b) Descendant neutralizer side effect:** the dual-direction neutralizer on `.cmtr-highlight`
  (fixing the stacked-wash box) also unhighlights genuine nested native `==...==` inside a plugin
  highlight. This is rare (CriticMarkup does not nest), and the trade-off (visual correctness wins)
  is accepted.
- **(c) Add-comment pill eligibility predicate:** the `showTooltip` extension (pill appearance
  logic) duplicates the wrap-path guard from `addCommentToView` (drift risk). Suggested home for a
  shared predicate: `base/edit-logic` next to `addCommentToView`, exported for reuse by
  `comment-pill.ts` — avoids uix→base→uix import cycle.

## Test-infrastructure conventions established (use in later phases)

- jest state setup: `EditorState.create` requires more than `[rangeParser]` — use the
  `pluginSettingsField`/`providePluginSettingsExtension` pattern (see tests/range_correcter.test.ts).
- Parsing metadata (`{"author":...}@@`) requires `enable_metadata: true` — on by default since
  Phase 3A; tests that need deterministic markup output should override `add_metadata: false`.
- The `obsidian` npm package has no runtime code; the root `__mocks__/obsidian.ts` provides the
  runtime surface and jest auto-applies it. `src/ui/embeddable-editor.ts` is stubbed via
  `moduleNameMapper` because it extends a live-Obsidian class at module load.

## Rename to Inkling (2026-07-12)

- **New identity**: manifest id/name → `inkling` / "Inkling", `package.json` name →
  `obsidian-inkling`, release workflow `PLUGIN_NAME` → `inkling`. Version, minAppVersion,
  isDesktopOnly, author/authorUrl untouched. README retitled, BRAT slug updated to
  `AndrewBroz/obsidian-inkling`, fork callout keeps the Fevol/kometenstaub attribution and now
  explains the name.
- **What stayed internal (deliberately)**: the `COMMENTATOR_ANNOTATIONS_VIEW` view-type string
  (`"commentator-annotations-view"`) is unchanged — renaming it would orphan saved workspace
  layouts that reference the view by type string. The `cmtr-` CSS class prefix, the
  `CommentatorPlugin`/`CommentatorSettings`/`CommentatorAnnotationsView*` TypeScript identifiers,
  and the `window.COMMENTATOR_DEBUG` debug global all stay as-is — these are internal code
  identifiers, not user-visible surface.
- **Runtime plugin-id self-references (not in the original scope list, fixed for correctness)**:
  renaming `manifest.json`'s `id` to `inkling` means every place the plugin looked itself up in
  Obsidian's plugin registry by the OLD id (`app.plugins.plugins["commentator"]` /
  `app.plugins.plugins.commentator`) would otherwise silently break at runtime (undefined access →
  TypeError) the moment the rename shipped. Updated to `inkling` in:
  `src/util/obsidian-util.ts` (`openSettingTab` default, other-plugins filter, bug-report plugin
  version lookup), `src/editor/renderers/gutters/annotations-gutter/marker.ts` and
  `src/editor/renderers/live-preview/comment-widget.ts` (author-comparison and embeddable-editor
  filtered-extensions lookups), `src/types/extensions.d.ts` (`PluginsPluginsRecord` key), and
  `src/main.ts`'s `beforePluginUninstallPatch` id argument. Left `"commentator-version"` in the
  GitHub issue-link query params untouched — it targets a field id in the upstream Fevol repo's
  issue template, unrelated to this fork's own id.
- **Cache rename + old-store cleanup**: the `Database` name moved from `"commentator/cache"` to
  `"inkling/cache"` (rebuilds automatically, no migration needed — see `src/main.ts`). Added a
  one-time, best-effort `localforage.dropInstance({ name: "commentator/cache/" + this.app.appId })`
  in `onload`'s `onLayoutReady`, wrapped in `.catch(() => {})` since the old instance may not
  exist for fresh installs.
- **Settings-import shim**: `migrateSettings` in `src/main.ts` now runs, when `loadData()` returns
  `null` (fresh install), a best-effort read of
  `${configDir}/plugins/commentator/data.json` before falling back to defaults — so testers who
  installed an earlier build of this fork under the `commentator` id keep their settings across
  the rename. Placed before `first_install` is computed (an import counts as not-first-install, so
  no author re-prompt) and before the defaults merge, so imported settings flow through the
  existing legacy backfills (`backfillLegacyMetadataFlags`, `backfillMarkupFocus`) untouched.
- **Frontmatter dual keys**: `FRONTMATTER_MODE_KEYS = ["inkling", "commentator"]` and
  `FRONTMATTER_AUTHORS_KEYS = ["inkling-authors", "commentator-authors"]` in
  `src/editor/uix/frontmatter-mode.ts`. First mode-key match wins (`inkling` beats a coexisting
  `commentator` key). The authors list is looked up by the SAME index/family as the matched mode
  key first, falling back to the other family only if the matched family has no authors entry at
  all — so `inkling-authors` doesn't need to duplicate everyone already listed under a legacy
  `commentator-authors`, but a present (even empty-effect) `inkling-authors` entry is authoritative
  once `inkling` is the matched key. Covered by new TDD cases in `tests/frontmatter_mode.test.ts`
  (the 5 pre-existing legacy-key cases still pass unmodified).

## Mode simplification

Removal of the vestigial `EditMode.OFF`, and the promotion of its one good feature to a setting.

- **Why OFF existed**: an upstream (2024) refactor promoted the "off" state of an old boolean
  suggestion-mode setting into a first-class member of the new `EditMode` enum. Nothing in the plugin
  ever defended it as a mode: `getEditMode` returned `[]` for it, i.e. it installed ZERO editor
  extensions. So in OFF there was no `editMode` transaction filter, no cursor-movement correction, no
  bracket protection — ordinary typing could silently corrupt a note's CriticMarkup (typing between
  brackets, backspacing `{++` into `{+`, deleting half of a range). CORRECTED is the default, every
  command's "home" mode, and the only thing standing between the user and that corruption; the cycle
  passing through OFF meant two header-button clicks could land a user in an unprotected editor
  without any indication that the safety net was gone.
- **What was removed**: the `OFF = 0` enum member (`src/types.ts`), its `getEditMode` branch, its
  `markup_focus` profile (`src/constants.ts`), its status-bar/header button states, and the "Regular
  Edit Mode" settings-dropdown entry. `main.ts`'s `defaultEditModeExtension` field (assigned in
  `onload`, never read) went with it.
- **Values are NOT renumbered**: `CORRECTED = 1, SUGGEST = 2, COMMENT = 3` stay as they are, because
  edit modes are persisted in `data.json`. Value `0` is retired, exported as `RETIRED_EDIT_MODE` for
  the clamp below.
- **Button indexing**: the two mode buttons used to index their state arrays BY ENUM VALUE
  (`states[value]`, cycle `(value + 1) % states.length`), which only worked because the enum happened
  to start at 0 and be contiguous. Rather than keep a dead placeholder at index 0, each state now
  carries its own `value` (`{ value, icon, text }` / `{ value, icon, tooltip, text }`), and
  `StatusBarButton`/`HeaderButton` map value → position via `stateIndex()`. The header button cycles
  in ARRAY order (`nextState()`), so the 3-cycle is Editing → Suggesting → Commenting → Editing and can
  never land on a retired value — there is no dead slot to skip. Preview-mode buttons were converted
  the same way (their values still coincide with their indices). An unknown/stale value now hides the
  header button and is ignored by the status-bar button, instead of dereferencing a hole in the array.
- **Migration/remap**: `clampRetiredEditMode(settings)` (constants.ts, beside `disableDiffGutterOnce`)
  rewrites a persisted `default_edit_mode: 0` to `EditMode.CORRECTED`. Called from `migrateSettings` on
  EVERY load, not from the version-gated branch — `DEFAULT_SETTINGS.version` is a hardcoded schema
  constant that existing saves already match, so that branch never fires for them (same reasoning as
  the `disableDiffGutterOnce` EXPL). Per-editor modes are not persisted (they are seeded from
  `default_edit_mode` or frontmatter on every view), so no other clamp site is needed.
- **Frontmatter `off`**: remapped from `EditMode.OFF` to `EditMode.CORRECTED`. The intent of `off` was
  always "this note enforces no suggest/comment discipline", never "this note may be corrupted".
- **New setting `reveal_syntax_on_focus`** (default `false`, Editor settings, "Reveal CriticMarkup
  syntax under the cursor"): OFF's `markup_focus` profile was the only thing it did well — it revealed
  brackets and metadata for the range the cursor is inside. That is now a mode-independent setting.
  Wired at the read site: `resolveFocusSettings(settings, edit_mode)`
  (`src/editor/renderers/live-preview/markup-renderer.ts`) returns the mode's stored profile with
  `show_syntax`/`show_metadata` ORed to true when the setting is on; `show_comment`/`show_styling`/
  `focus_annotation` remain mode-owned, and the stored profiles are never mutated. Added to
  `REQUIRES_EDITOR_RELOAD` so toggling it repaints via `fullReloadEffect` immediately.
- **Net effect**: the 3-cycle no longer passes through an unprotected state; the "see the raw syntax"
  affordance survives, decoupled from the hazard it was accidentally bundled with.
