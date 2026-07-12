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

- **jest stays on 29**: jest 30's `unrs-resolver` native module cannot load under this machine's
  Rosetta x64 node while bun installs arm64 bindings — same root cause as the dprint postinstall
  failure. Retry the jest 30 bump after replacing the system node with an arm64 build.
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

### Manual smoke checklist (needs a human in Obsidian)

- Fresh vault → author-name prompt appears once; existing vault → no prompt, settings intact.
- New suggestion/comment carries `{"author":"...","time":...}@@` metadata; author/recency
  filters in the Annotations View now work out of the box.
- Select text → "Add comment" → highlight + focused comment thread; hover shows the thread.
- (Carried from earlier phases) staleness-guard Notice; gutter fold/resize persistence;
  bulk-stale accept shows ONE summary Notice.

## Test-infrastructure conventions established (use in later phases)

- jest state setup: `EditorState.create` requires more than `[rangeParser]` — use the
  `pluginSettingsField`/`providePluginSettingsExtension` pattern (see tests/range_correcter.test.ts).
- Parsing metadata (`{"author":...}@@`) requires `enable_metadata: true` — on by default since
  Phase 3A; tests that need deterministic markup output should override `add_metadata: false`.
- The `obsidian` npm package has no runtime code; the root `__mocks__/obsidian.ts` provides the
  runtime surface and jest auto-applies it. `src/ui/embeddable-editor.ts` is stubbed via
  `moduleNameMapper` because it extends a live-Obsidian class at module load.
