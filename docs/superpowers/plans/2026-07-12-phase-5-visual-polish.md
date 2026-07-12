# Phase 5: Visual Polish + Comment Pill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge the editor's visual weight with Word/GDocs (quiet margins, clean highlights), fix two rendering bugs, add a GDocs-style add-comment pill on selection, and finish the plugin-list identity.

**Architecture:** Two CSS-scoped fixes (highlight shape, folded-gutter overlap); a settings-default flip with one-time migration (diff gutter off); manifest metadata edits; and one new CM6 extension (`comment-pill.ts`) using the `showTooltip` facet to float an Add-comment button near eligible selections, dispatching through the existing `addCommentToView`.

**Tech Stack:** TypeScript 5.9, CodeMirror 6 (`showTooltip`), SCSS, jest 30.

**User decisions (binding):** (1) highlights lose the bottom-half connector look — simple GDocs-like rounded background; (2) the folded gutter's unfold affordance must never overlap document text; (3) selection gets an add-comment pill (GDocs-style; reactions are out of scope — no data model for them); (4) plugin-list "By" line is just "Andrew Brož", description ends before "A hard fork…" (heritage stays in README/docs); (5) the red/green diff bars are OFF by default, with a one-time migration turning them off for existing users (setting remains for opt-in).

## Global Constraints

- Toolchain bun (`export PATH="$HOME/.bun/bin:$PATH"`). Gates before every commit: `bun run build`, `bun run test` (baseline 1147/1147), `bun run lint` (0 errors, 95-warning baseline), `bun node_modules/dprint/bin.cjs check`; dprint-fmt touched files.
- No behavior changes beyond the five decisions. The `// BUG:`/KNOWN-RESIDUAL tests and 7 snapshots stay byte-identical.
- Icons: lucide (`message-square-plus` for the pill).
- Test conventions per tests/helpers.ts; migration rules follow the `backfillLegacyMetadataFlags` pattern (pure function in constants.ts, called from migrateSettings, unit-tested directly).

## Code map (scouted anchors)

- Highlight styles: `src/assets/editor.scss:103` (`.cmtr-highlight` block) and `:205` (`span.cm-highlight:has([data-type="cmtr-highlight"])`) — the "bottom-half look" lives in one of these or in `.cmtr-has-reply` composites (editor.scss:40-90 pattern). The comment style `.cmtr-comment` uses `border-bottom: 2px solid` (editor.scss ~111) — the highlight variant likely inherits a similar connector.
- Folded-gutter button: `src/assets/annotation-gutter.scss:204` (`.cmtr-anno-gutter-button`) + 212/217/226; the button is created in the gutter code (grep `Unfold gutter` / `fold` in src/editor/renderers/gutters/annotations-gutter/ and gutters/base.ts).
- Selection pill home: `src/editor/uix/extensions/` (new file `comment-pill.ts`), registered in `loadEditorExtensions` (src/main.ts) — follow how `bracketMatcher`/`rangeCorrecter` are conditionally pushed.
- Eligibility rule for the pill = the same rule as the anchored-comment wrap path in `addCommentToView` (src/editor/base/edit-logic/add-comment.ts): non-empty selection with `ranges.ranges_in_interval(from, to).length === 0`. The pill click calls `addCommentToView(view, undefined)` (it reads the selection itself).
- Settings: `diff_gutter: true` at src/constants.ts:51; REQUIRES_FULL_RELOAD includes "diff_gutter" (constants.ts:154). Migration home: `migrateSettings` in src/main.ts next to the other backfills. Settings version key: `settings.version` (see migrateSettings) — the migration must run ONCE (gate on version comparison or a dedicated flag), not on every load, since users may re-enable.
- Manifests: manifest.json + manifest-beta.json (keep both identical).

---

### Task 1: Identity + quiet margins (manifests, diff-gutter default, migration)

**Files:**

- Modify: `manifest.json`, `manifest-beta.json`
- Modify: `src/constants.ts` (default + one-time migration helper)
- Modify: `src/main.ts` (call the helper in migrateSettings)
- Test: extend `tests/metadata_defaults.test.ts` (or a sibling) for the migration rule

**Contract:**

1. Both manifests: `"author": "Andrew Brož"`, `"description": "Suggest edits, add comments, and annotate your notes using CriticMarkup syntax."` — nothing else changes (version stays; authorUrl stays).
2. `DEFAULT_SETTINGS.diff_gutter: false`.
3. One-time migration `disableDiffGutterOnce(settings, saved)` in constants.ts: for EXISTING saved settings that predate this change (gate on the settings-version comparison already available in migrateSettings — read how `settings.version` is compared and use the same mechanism; if versions aren't granular enough, use a dedicated `diff_gutter_migrated: boolean` settings key defaulting false), set `diff_gutter = false` exactly once; after that, a user re-enabling it stays enabled across restarts. Wire into migrateSettings next to the other backfills. Unit-test the pure function: legacy-saved-true → false once; re-enabled-after-migration → stays true; fresh install → default false untouched.

- [ ] Implement → gates → commit `feat: quiet defaults and final plugin-list identity` (+ Co-Authored-By trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` — all commits).

---

### Task 2: CSS fixes — highlight shape + folded-gutter overlap

**Files:**

- Modify: `src/assets/editor.scss` (highlight)
- Modify: `src/assets/annotation-gutter.scss` and/or the gutter button code (overlap)

**Contract:**

1. **Highlight shape:** a highlight (with or without an attached comment thread) renders as a simple continuous background with small uniform border-radius — no bottom border, no half-rounded corners, no connector artifacts. Find the actual source of the "bottom-half look" (inspect `.cmtr-highlight`, the `:has(...)` rule at editor.scss:205, and any `.cmtr-has-reply` composite that applies to highlights) and remove/normalize it. Keep the focused-state color distinction. Do not change suggestion (addition/deletion/substitution) styling.
2. **Folded-gutter unfold affordance:** when the annotation gutter is folded, the unfold button/handle must sit in the margin/edge strip, never overlapping document text (the screenshot shows it floating over the first line, tooltip included). Find where the folded-state button is positioned (gutter code + `.cmtr-anno-gutter-button` rules); fix via positioning/reserved space so text is never obscured at any editor width. If the fix needs a structural change (e.g. the button lives inside the content DOM rather than the gutter container), report the finding and do the minimal structural correction.
3. Evidence: CSS is not headless-verifiable — your report carries before/after reasoning per rule changed (what the old rule drew, why, what the new rule draws) and a manual smoke checklist. Keep `.cmtr-resolved` and Phase-4 classes untouched.

- [ ] Implement → gates → commit `fix: clean highlight shape and un-overlap the folded gutter button`.

---

### Task 3: GDocs-style add-comment pill on selection

**Files:**

- Create: `src/editor/uix/extensions/comment-pill.ts`
- Modify: `src/editor/uix/extensions/index.ts` (export), `src/main.ts` (register in loadEditorExtensions)
- Modify: `src/assets/editor.scss` (pill styling)
- Test: `tests/comment_pill.test.ts` (create — the tooltip-eligibility logic is pure/testable)

**Contract:**

1. A floating pill appears when (and only when): the selection is non-empty, spans no existing CriticMarkup range (`ranges_in_interval(from, to).length === 0` — same rule as the wrap path), and the doc is editable. It disappears on selection collapse/change to ineligible. Implement with CM6's `showTooltip` facet (StateField over selection → `Tooltip | null` with `above: true`, positioned at selection head; `strictSide: false` so CM flips it when cramped).
2. The pill contains ONE action: an Add-comment button (`message-square-plus` icon via setIcon + aria-label "Add comment") that calls `addCommentToView(view, undefined)` — which wraps the selection and focuses the comment editor (all existing behavior). The pill must not steal focus on hover, and clicking must not first collapse the selection (use mousedown preventDefault or the tooltip's DOM click handling — verify the selection survives to the handler).
3. Styling: compact rounded pill (Obsidian variables: `var(--background-primary)`, `var(--background-modifier-border)` shadow), matching Obsidian's aesthetic more than Google's literal look. No new setting (YAGNI) — but structure the extension so gating on a setting later is a one-liner.
4. Extract the eligibility predicate as a pure exported function `pill_eligible(state): boolean` (or returning the selection range) and unit-test it: empty selection → false; clean selection → true; selection overlapping a range → false; selection inside a comment → false. Tooltip positioning/DOM: manual smoke.
5. Mode interactions to verify in self-review: comment mode (pill should appear — adding comments is the point of that mode; the annotated dispatch passes the filter); enforced frontmatter modes (same); reading view N/A (CM extension only).

- [ ] TDD the predicate → implement the extension → gates → commit `feat: floating add-comment pill on text selection`.

**STOP condition:** if CM6 tooltip interaction fundamentally fights selection preservation (click collapses selection before the handler sees it) after one honest attempt at the standard mousedown-preventDefault approach, report BLOCKED with the event trace rather than shipping a flaky pill.

---

### Task 4: Completion + release

- [ ] Clean-state full gate; append `## Phase 5 outcomes` to the execution notes (decisions, migration semantics, pill eligibility rule, smoke checklist: highlight shape in light+dark themes, folded gutter at narrow widths, pill on selection/near markup/in comment mode, diff bars absent on fresh + migrated installs, plugin-list line); dprint-fmt; commit `docs: record phase 5 outcomes`.
- [ ] Release 0.6.0: `bun run release-minor`, push main + tag, `gh workflow run releases.yml --repo AndrewBroz/obsidian-inkling --ref 0.6.0`, verify assets, curate notes via `gh release edit`.
