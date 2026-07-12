# Phase 3A: Reject-All Fix + Attribution Defaults + Anchored Comments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the reject-all text-resurrection corruption, turn author/timestamp attribution on by default with a first-run name prompt, and let comments anchor to text selections GDocs-style.

**Architecture:** Task 1 corrects `mark_range`'s deleted-text computation so pending additions are consumed rather than folded (converting the four `// BUG:` snapshot cases into explicit corrected expectations with accept/reject round-trip invariants). Task 2 flips six settings defaults and adds a small Obsidian `Modal` shown once on first install. Task 3 extends `addCommentToView` with a selection-wrapping path that produces `{==selection==}{>>comment<<}` — the parser's existing adjacency rule attaches the comment as a thread on the highlight, so gutter/hover rendering works unchanged.

**Tech Stack:** TypeScript 5.9, CodeMirror 6, Obsidian API, jest 29 + ts-jest, bun.

**Spec:** `docs/superpowers/specs/2026-07-11-repair-and-parity-design.md` (Phase 3, sections 3a and 3b) + execution-notes bug 2 (`docs/superpowers/plans/2026-07-11-phase-0-1-execution-notes.md`).

## Global Constraints

- Toolchain bun (`export PATH="$HOME/.bun/bin:$PATH"` everywhere). Gate before every commit: `bun run build`, `bun run test`, `bun run lint` (0 errors), `bun node_modules/dprint/bin.cjs check`. Baseline: 1082/1082 tests.
- dprint-format every file you touch (`bun node_modules/dprint/bin.cjs fmt <files>`).
- Test setup uses `createRangeState(doc, settings?, extra?)` from `tests/helpers.ts`; metadata parsing needs `{ enable_metadata: true }`.
- **Task 1 explicitly amends the four `// BUG:` snapshot cases** — this is the ONE sanctioned change to them; every other snapshot must stay byte-identical.
- Data-safety invariant for Task 1 (the whole point): for every mark operation, **accept-all output must be unchanged from pre-fix behavior, and reject-all output must equal what reject-all on the pre-mark document would have produced.**
- No Vim work, no comment-mode/frontmatter work (that's Phase 3B), no TS7.

## Relevant code map (read before implementing)

- `src/editor/base/edit-logic/mark.ts` — `mark_range` (~line 108 post-reformat; content-anchor). The suggestion branch (final `else`) computes `deleted = ranges.unwrap_in_range(text, from, to, in_range).output`, which unwraps pending `{++…++}` content INTO the new deletion/substitution — that's the corruption. The empty-`deleted` early-return (`if (!deleted) { … DELETION → return no-op }`) fires before bracket extension.
- `src/editor/base/ranges/grouped_range.ts` — `unwrap_in_range(doc, from, to, ranges)` (~line 101): per-range contribution is `range.unwrap_slice(...)`.
- `AdditionRange.reject()` → `""`; `DeletionRange.reject()` → `unwrap()`; `SubstitutionRange.reject()` → deleted part; `.accept()` mirrors (src/editor/base/ranges/types/*).
- The left/right MERGE paths in `mark_range`'s final else are already correct (substitution merges use `parts[0]` for deleted; `merge_type(ADDITION, DELETION)` is undefined so additions never merge into deletion marks) — the bug is confined to the `unwrap_in_range` fold and the empty-deleted early return.
- Comment thread adjacency: `src/editor/base/edit-util/range-parser.ts` (~line 49) — a COMMENT range `right_adjacent` to ANY previous range becomes its reply. This is why `{==x==}{>>c<<}` renders as an anchored thread with zero renderer changes.
- `create_range(settings, type, inserted, deleted?)` (src/editor/base/edit-util/range-create.ts:55) builds bracket text including metadata from settings.
- Settings: `src/constants.ts` DEFAULT_SETTINGS has `enable_metadata/enable_author_metadata/enable_timestamp_metadata` (parsing/display) and `add_metadata/add_author_metadata/add_timestamp_metadata` (write-on-edit) — all currently `false`; `author: ""`. `generate_metadata` (src/editor/base/edit-util/metadata.ts) reads the `add_*` set.
- `src/main.ts` `loadSettings()` does `this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())` — saved settings win, so flipping defaults only affects fresh installs (spec requirement).

---

### Task 1: Reject-all corruption fix in mark_range

**Files:**

- Modify: `src/editor/base/ranges/grouped_range.ts` (`unwrap_in_range` gains a drop-pending-additions mode)
- Modify: `src/editor/base/edit-logic/mark.ts` (suggestion branch uses it; empty-deleted handling distinguishes "nothing there" from "only pending additions there")
- Test: `tests/mark_ranges.test.ts` (amend the four `// BUG:` cases), `tests/__snapshots__/mark_ranges.test.ts.snap` (their entries removed)

**Interfaces:**

- Produces: `unwrap_in_range(doc, from, to, ranges, drop_pending_additions = false)` — same return shape; when the flag is true, a range **fully covered** by [from,to] contributes `""` if ADDITION and only its deletion part (`unwrap_parts()[0]`) if SUBSTITUTION; partially-covered ranges and other types contribute exactly as today. Callers other than the mark.ts suggestion branch are untouched (default `false`).

**Target semantics (these ARE the requirements):**

| # | Input doc           | Operation                                  | OLD output (corrupting) | NEW required output                  |
| - | ------------------- | ------------------------------------------ | ----------------------- | ------------------------------------ |
| 1 | `ab{++cd++}ef`      | DELETION over whole doc                    | `{--abcdef--}`          | `{--abef--}`                         |
| 2 | `ab{++cd++}ef`      | DELETION over exactly `cd` (positions 5–7) | `ab{--cd--}ef`          | `abef` (addition retracted outright) |
| 3 | `x{~~y~>z~~}u`      | SUBSTITUTION over whole doc, insert `new`  | `{~~xyzu~>new~~}`       | `{~~xyu~>new~~}`                     |
| 4 | `uv{++w++}{++y++}z` | SUBSTITUTION over whole doc, insert `q`    | `{~~uvwyz~>q~~}`        | `{~~uvz~>q~~}`                       |

Verify by hand before coding: in every row, accept-all on NEW output equals accept-all on OLD output (`""`, `abef`, `new`, `q` respectively), and reject-all on NEW output equals reject-all on the INPUT doc (`abef`, `abef`, `xyu`, `uvz`) — which OLD violated.

- [ ] **Step 1: Write the failing tests**

In `tests/mark_ranges.test.ts`:

1. Add round-trip helpers at top (after the existing `mark` helper):

```typescript
import { applyToText } from "../src/editor/base";

function accept_all(doc: string): string {
	const state = createRangeState(doc);
	return applyToText(
		doc,
		(range) => range.accept(),
		state.field(rangeParser).ranges.ranges,
	);
}

function reject_all(doc: string): string {
	const state = createRangeState(doc);
	return applyToText(
		doc,
		(range) => range.reject(),
		state.field(rangeParser).ranges.ranges,
	);
}
```

(Adapt the exact `applyToText` callback signature to the one used in tests/cursor_movement.test.ts — `(range, text) => range.unwrap()` pattern — and reuse `createRangeState` / imports already present in this file. If `accept()`/`reject()` need arguments, match their signatures from base_range.ts.)

2. Convert the four `// BUG:` snapshot cases into explicit tests in a new describe block, and REMOVE them from the `cases` snapshot array:

```typescript
describe("marking over pending additions consumes them (reject-all safety)", () => {
	// [name, doc, from, to, inserted, type, expected output, expected accept-all]
	const cases: [
		string,
		string,
		number,
		number,
		string,
		MarkType,
		string,
		string,
	][] = [
		[
			"delete spanning plain text and addition",
			"ab{++cd++}ef",
			0,
			12,
			"",
			SuggestionType.DELETION,
			"{--abef--}",
			"",
		],
		[
			"delete exactly an addition's contents",
			"ab{++cd++}ef",
			5,
			7,
			"",
			SuggestionType.DELETION,
			"abef",
			"abef",
		],
		[
			"substitution across existing substitution",
			"x{~~y~>z~~}u",
			0,
			12,
			"new",
			SuggestionType.SUBSTITUTION,
			"{~~xyu~>new~~}",
			"new",
		],
		[
			"substitution spanning two adjacent ranges",
			"uv{++w++}{++y++}z",
			0,
			17,
			"q",
			SuggestionType.SUBSTITUTION,
			"{~~uvz~>q~~}",
			"q",
		],
	];

	for (
		const [name, doc, from, to, inserted, type, expected, accept_expected]
			of cases
	) {
		test(name, () => {
			const output = mark(doc, from, to, inserted, type);
			expect(output).toBe(expected);
			// EXPL: The data-safety invariants this fix exists for:
			//       reject-all must restore what reject-all on the input would give,
			//       and accept-all must be unchanged from pre-fix behavior.
			expect(reject_all(output)).toBe(reject_all(doc));
			expect(accept_all(output)).toBe(accept_expected);
		});
	}
});
```

3. Delete the four `// BUG:` comment blocks and the header line about them (the bug is being fixed), and delete the four corresponding entries from `tests/__snapshots__/mark_ranges.test.ts.snap` (removing the test names from the snapshot array makes them obsolete; run `bun run test -- tests/mark_ranges.test.ts -u` ONLY after the explicit tests pass, and verify the `-u` run removes exactly 4 entries and modifies nothing else in the snap file).

- [ ] **Step 2: Run tests to verify they fail correctly**

Run: `bun run test -- tests/mark_ranges.test.ts`
Expected: the four new explicit tests FAIL with the OLD outputs from the table (e.g. received `{--abcdef--}`, expected `{--abef--}`). Everything else passes. If a case fails with a _different_ wrong output than the table's OLD column, STOP — the code has drifted from the characterization and the analysis needs redoing.

- [ ] **Step 3: Implement**

Suggested implementation (the tests are the contract; internals may deviate if all gates stay green — document any deviation):

1. `grouped_range.ts` — extend `unwrap_in_range` with `drop_pending_additions = false` as the fifth parameter. In the per-range loop, replace `output += range.unwrap_slice(Math.max(0, from), to);` with:

```typescript
if (drop_pending_additions && from <= range.from && range.to <= to) {
	// EXPL: A pending addition consumed by a deletion/substitution mark is a retracted
	//       suggestion — its text was never in the base document, so folding it into
	//       the new range would make reject-all resurrect it.
	if (range.type === SuggestionType.ADDITION) {
		// contributes nothing
	} else if (range.type === SuggestionType.SUBSTITUTION)
		output += (range as SubstitutionRange).unwrap_parts()[0];
	else
		output += range.unwrap_slice(Math.max(0, from), to);
} else {
	output += range.unwrap_slice(Math.max(0, from), to);
}
```

(Import `SuggestionType`/`SubstitutionRange` as needed within the file — check what it already imports.)

2. `mark.ts` suggestion branch (final `else` of the big type dispatch): change the deleted computation to pass the flag for deletion/substitution marks, and fix the empty-deleted early return:

```typescript
const drop_additions = type === SuggestionType.DELETION ||
	type === SuggestionType.SUBSTITUTION;
let deleted = from === to ?
	"" :
	ranges.unwrap_in_range(text, from, to, in_range, drop_additions).output;
if (!deleted) {
	// EXPL: Distinguish "selection contains nothing" from "selection covers only
	//       pending additions" — the latter must remove those additions outright
	//       (retracting a suggestion), not no-op.
	const covered = in_range.filter(r => from <= r.from && r.to <= to);
	if (drop_additions && covered.length > 0) {
		const removal_from = Math.min(from, covered[0].from);
		const removal_to = Math.max(to, covered[covered.length - 1].to);
		return {
			from: removal_from,
			to: removal_to,
			insert: inserted,
			start: removal_from,
			end: removal_from + inserted.length,
		};
	}
	if (type === SuggestionType.SUBSTITUTION)
		type = SuggestionType.ADDITION;
	else if (type === SuggestionType.DELETION)
		return { from, to: from, insert: "", start: from, end: from };
}
```

Note case 2 has `inserted === ""` so the removal returns empty insert; a substitution over only-additions with non-empty `inserted` degrades to inserting the replacement text plainly — assert that in a bonus test if time permits, otherwise leave to the round-trip invariants.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- tests/mark_ranges.test.ts`
Expected: all explicit tests pass. Then run the FULL suite: `bun run test`. The remaining 7 snapshot cases must be byte-unchanged (they don't cover pending additions with deletion/substitution marks — if any of them diff, your change leaked into an unintended path: STOP and narrow it). Then `-u` cleanup per Step 1.3 and re-run.

- [ ] **Step 5: Full gate and commit**

```bash
bun run build && bun run test 2>&1 | tail -3 && bun run lint > /dev/null && bun node_modules/dprint/bin.cjs check
git add src/editor/base/ranges/grouped_range.ts src/editor/base/edit-logic/mark.ts tests/mark_ranges.test.ts tests/__snapshots__/mark_ranges.test.ts.snap
git commit -m "fix: deleting or substituting over pending additions retracts them instead of folding their text"
```

Also update `docs/superpowers/plans/2026-07-11-phase-0-1-execution-notes.md`: mark bug 2 as FIXED with the commit SHA (edit the section header to "(FIXED in Phase 3A)" — keep the description for history). Include in the same commit.

---

### Task 2: Author attribution on by default + first-run name prompt

**Files:**

- Modify: `src/constants.ts` (six defaults)
- Create: `src/ui/modals/author-modal.ts`
- Modify: `src/ui/modals/index.ts` (export it — match the file's existing export style)
- Modify: `src/main.ts` (first-install detection + prompt)
- Test: `tests/metadata_defaults.test.ts` (create)

**Interfaces:**

- Consumes: `generate_metadata(settings)` (metadata.ts), `Modal`/`Setting` from obsidian (mocked at `__mocks__/obsidian.ts` — if `Setting` or `Modal` methods used here are missing from the mock, add minimal inert stand-ins, additive only).
- Produces: `AuthorNameModal(app, onSubmit: (author: string) => void)`; `CommentatorPlugin.first_install: boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/metadata_defaults.test.ts`:

```typescript
import { DEFAULT_SETTINGS } from "../src/constants";
import { generate_metadata } from "../src/editor/base/edit-util/metadata";

describe("attribution defaults (Phase 3a)", () => {
	test("metadata parsing and writing are on by default", () => {
		expect(DEFAULT_SETTINGS.enable_metadata).toBe(true);
		expect(DEFAULT_SETTINGS.enable_author_metadata).toBe(true);
		expect(DEFAULT_SETTINGS.enable_timestamp_metadata).toBe(true);
		expect(DEFAULT_SETTINGS.add_metadata).toBe(true);
		expect(DEFAULT_SETTINGS.add_author_metadata).toBe(true);
		expect(DEFAULT_SETTINGS.add_timestamp_metadata).toBe(true);
	});

	test("generate_metadata produces author and timestamp under defaults", () => {
		const metadata = generate_metadata({
			...DEFAULT_SETTINGS,
			author: "Test Author",
		});
		expect(metadata).toBeDefined();
		expect(metadata!.author).toBe("Test Author");
		expect(typeof metadata!.time).toBe("number");
	});

	test("generate_metadata omits author when name is unset", () => {
		const metadata = generate_metadata({ ...DEFAULT_SETTINGS, author: "" });
		expect(metadata).toBeDefined();
		expect(metadata!.author).toBeUndefined();
		expect(typeof metadata!.time).toBe("number");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/metadata_defaults.test.ts`
Expected: FAIL — the six flags are currently `false`.

- [ ] **Step 3: Flip the defaults**

In `src/constants.ts` DEFAULT_SETTINGS, set to `true`: `enable_metadata`, `enable_author_metadata`, `enable_timestamp_metadata`, `add_metadata`, `add_author_metadata`, `add_timestamp_metadata`. Leave `enable_completed_metadata`, `enable_style_metadata`, `enable_color_metadata`, `add_completed_metadata`, `add_style_metadata`, `add_color_metadata` as-is (`false`). Leave `author: ""`.

- [ ] **Step 4: Create the modal**

Create `src/ui/modals/author-modal.ts`:

```typescript
import { type App, Modal, Setting } from "obsidian";

/**
 * One-time first-install prompt for the display name used in suggestion/comment attribution.
 * Skipping is fine: generate_metadata omits the author field while settings.author is empty.
 */
export class AuthorNameModal extends Modal {
	constructor(app: App, private onSubmit: (author: string) => void) {
		super(app);
	}

	onOpen() {
		let value = "";
		this.titleEl.setText("Commentator: choose your author name");
		this.contentEl.createEl("p", {
			text:
				"Suggestions and comments you make will be attributed to this name. " +
				"You can change it any time under Settings → Commentator → Metadata.",
		});
		new Setting(this.contentEl)
			.setName("Display name")
			.addText(text => text.onChange(v => value = v));
		new Setting(this.contentEl)
			.addButton(btn =>
				btn.setButtonText("Save").setCta().onClick(() => {
					this.onSubmit(value.trim());
					this.close();
				})
			)
			.addButton(btn => btn.setButtonText("Skip").onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}
```

Export it from `src/ui/modals/index.ts` following that file's existing pattern.

- [ ] **Step 5: Wire first-install detection**

In `src/main.ts`:

1. Add a field near the other plugin fields: `first_install: boolean = false;`
2. In `loadSettings()`, capture the raw load before merging (adapt to the method's actual current shape):

```typescript
async loadSettings() {
	const saved = await this.loadData();
	this.first_install = saved == null;
	this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
	…
```

3. In `onload()` (after settings are loaded), add:

```typescript
this.app.workspace.onLayoutReady(() => {
	if (this.first_install && !this.settings.author) {
		new AuthorNameModal(this.app, async (author) => {
			if (author) {
				this.settings.author = author;
				await this.setSettings();
			}
		}).open();
	}
});
```

(Import `AuthorNameModal` from the modals barrel. Confirm the settings-persist method name in main.ts — `setSettings` is used by migrateSettings; if the canonical method differs, use that.)

- [ ] **Step 6: Verify and commit**

```bash
bun run test -- tests/metadata_defaults.test.ts && bun run build && bun run test 2>&1 | tail -3 && bun run lint > /dev/null && bun node_modules/dprint/bin.cjs check
```

Watch the FULL suite closely: flipping `enable_metadata` default changes what `DEFAULT_SETTINGS`-based tests parse. `tests/cursor_movement.test.ts` uses `DEFAULT_SETTINGS` with plain docs (no metadata syntax) — should be unaffected; if any test regresses, fix the TEST by pinning its settings explicitly via `createRangeState`'s override (document each in the report), never by un-flipping the defaults.

```bash
git add src/constants.ts src/ui/modals/author-modal.ts src/ui/modals/index.ts src/main.ts tests/metadata_defaults.test.ts
git commit -m "feat: enable author and timestamp attribution by default with first-run name prompt"
```

Manual smoke note for the report: fresh vault → prompt appears once; existing vault (data.json present) → no prompt, saved settings untouched.

---

### Task 3: Comments anchored to selections

**Files:**

- Modify: `src/editor/base/edit-logic/add-comment.ts`
- Modify: `README.md` (check off "Add comments to selection" under Comment Mode)
- Test: `tests/add_comment.test.ts` (create)

**Interfaces:**

- Consumes: `create_range(settings, type, inserted, deleted?)` (range-create.ts:55); `rangeParser` field; the adjacency rule (a COMMENT right-adjacent to any range becomes its reply — range-parser.ts ~49).
- Produces: unchanged export `addCommentToView(editor, range, scroll?)` — new behavior only when `range` is undefined AND the selection is non-empty.

**Behavior contract:**

- Non-empty selection, no overlap with existing markup → replace selection with `{==<selection>==}{>><<}` (metadata included per settings), cursor inside the new comment; gutter focus annotation fired for the new thread.
- Non-empty selection that intersects any existing range → CriticMarkup cannot nest; fall back to the existing at-cursor behavior (comment inserted at `selection.main.head`). (Spec refinement, recorded: the spec suggested snapping; nesting makes wrapping unsafe, and cursor-fallback preserves the no-data-mangling priority.)
- Empty selection or explicit `range` argument → exactly today's behavior.

- [ ] **Step 1: Write the failing tests**

Create `tests/add_comment.test.ts`:

```typescript
import { EditorView } from "@codemirror/view";

import { rangeParser, SuggestionType } from "../src/editor/base";
import { addCommentToView } from "../src/editor/base/edit-logic/add-comment";
import { createRangeState } from "./helpers";

// EXPL: add_metadata false keeps outputs deterministic (no timestamps in the markup)
const NO_META = { add_metadata: false };

function viewWith(doc: string, anchor: number, head: number) {
	const state = createRangeState(doc, NO_META);
	const view = new EditorView({ state });
	view.dispatch({ selection: { anchor, head } });
	return view;
}

describe("addCommentToView with a selection", () => {
	test("wraps a clean selection in a highlight with an attached comment", () => {
		const view = viewWith("hello world", 0, 5);
		addCommentToView(view, undefined);
		expect(view.state.doc.toString()).toBe("{==hello==}{>><<} world");

		const ranges = view.state.field(rangeParser).ranges.ranges;
		expect(ranges[0].type).toBe(SuggestionType.HIGHLIGHT);
		expect(ranges[0].replies).toHaveLength(1);
		expect(ranges[0].replies[0].type).toBe(SuggestionType.COMMENT);
	});

	test("selection overlapping existing markup falls back to cursor behavior", () => {
		const doc = "he{++llo++} world";
		const view = viewWith(doc, 0, 7); // overlaps the addition range
		addCommentToView(view, undefined);
		const result = view.state.doc.toString();
		// EXPL: no wrapping happened — no highlight bracket anywhere
		expect(result).not.toContain("{==");
		// a bare comment was inserted at the selection head
		expect(result).toContain("{>><<}");
		// the addition range is intact
		expect(result).toContain("{++llo++}");
	});

	test("empty selection keeps existing at-cursor behavior", () => {
		const view = viewWith("hello", 3, 3);
		addCommentToView(view, undefined);
		expect(view.state.doc.toString()).toBe("hel{>><<}lo");
	});
});
```

Note: `createRangeState` may need its `extra` extensions param for `EditorView` use — mirror how tests/cursor_movement.test.ts constructs views. Ensure `pluginSettingsField` is present in the state (addCommentToView reads it). If `activeWindow.setTimeout` (used at the end of addCommentToView) is undefined under jest, add `global.activeWindow = window` style setup in tests/setup.ts (additive) or verify the obsidian mock provides it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- tests/add_comment.test.ts`
Expected: test 1 FAILS — current behavior inserts `{>><<}` at the head without wrapping (doc becomes something like `hello{>><<} world` or `{>><<}hello world` depending on head position). Tests 2 and 3 may already pass (they pin current behavior). If test 1 fails on infra (missing field/activeWindow) rather than on the wrapping assertion, fix the infra first so the RED is meaningful.

- [ ] **Step 3: Implement the wrap path**

In `src/editor/base/edit-logic/add-comment.ts`, at the top of `addCommentToView` after `settings` is read, insert:

```typescript
const selection = editor.state.selection.main;

// EXPL: GDocs-style anchored comment — wrap a clean selection in a highlight range;
//       the adjacent comment attaches to it as a thread via the parser's adjacency rule.
//       CriticMarkup cannot nest, so any selection touching existing markup falls back
//       to the plain at-cursor comment below.
if (!range && !selection.empty) {
	const ranges = editor.state.field(rangeParser).ranges;
	if (ranges.ranges_in_interval(selection.from, selection.to).length === 0) {
		const anchor_text = editor.state.sliceDoc(selection.from, selection.to);
		const insert =
			create_range(settings, SuggestionType.HIGHLIGHT, anchor_text) +
			create_range(settings, SuggestionType.COMMENT, "");
		editor.dispatch(editor.state.update({
			changes: { from: selection.from, to: selection.to, insert },
			selection: EditorSelection.cursor(selection.from + insert.length - 3),
			scrollIntoView: scroll,
		}));
		activeWindow.setTimeout(() => {
			editor.dispatch(editor.state.update({
				annotations: [
					annotationGutterFocusAnnotation.of({
						from: selection.from,
						to: selection.from,
						index: 1,
					}),
				],
			}));
		});
		return;
	}
}
```

(`rangeParser` needs importing from `../edit-util`; everything else is already imported. `insert.length - 3` places the cursor inside `{>>░<<}`. The `index: 1` focuses the comment — position 1 in the thread `[highlight, comment]`; if manual testing in Phase 3B shows the gutter focuses the wrong element, adjust the index there, not here.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- tests/add_comment.test.ts` → 3/3 PASS. Then the full suite.

- [ ] **Step 5: README checkbox, gate, commit**

In README.md under `### Comment Mode`, change `- [ ] Add comments to selection` to `- [x] Add comments to selection`.

```bash
bun run build && bun run test 2>&1 | tail -3 && bun run lint > /dev/null && bun node_modules/dprint/bin.cjs check
git add src/editor/base/edit-logic/add-comment.ts tests/add_comment.test.ts README.md
git commit -m "feat: anchor comments to text selections via highlight wrapping"
```

Manual smoke note for the report: in a vault — select text → "Add comment" command → highlight + comment thread appear, gutter focuses the comment input; hover over the highlight shows the thread.

---

### Task 4: Phase 3A completion check

- [ ] **Step 1: Clean-state full gate**

```bash
export PATH="$HOME/.bun/bin:$PATH"
rm -rf node_modules && bun install && bun run build && bun run test 2>&1 | tail -3 && bun run lint > /dev/null && echo LINT-OK && bun node_modules/dprint/bin.cjs check && echo DPRINT-OK
```

Expected: all green from scratch.

- [ ] **Step 2: Update execution notes and commit**

Append a `## Phase 3A outcomes` section to `docs/superpowers/plans/2026-07-11-phase-0-1-execution-notes.md`: reject-all fix landed (bug 2 closed), defaults flipped (note the existing-user-unaffected mechanism), anchored comments behavior contract (including the nesting-fallback spec refinement), and the manual smoke checklist accumulated from Tasks 2-3.

```bash
git add docs/superpowers/plans/2026-07-11-phase-0-1-execution-notes.md
git commit -m "docs: record phase 3a outcomes"
```
