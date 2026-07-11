# Phase 0+1: Repair Dev Loop & Data-Safety Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a working build/test/CI loop, then eliminate the known text-loss bugs and build a regression-test tripwire around the suggestion edit engine.

**Architecture:** No structural changes — surgical fixes to existing modules plus new jest test files under `tests/`. The one small refactor (Task 9) replaces an untyped array-index reach-through with an explicit return value from the annotation-gutter factory.

**Tech Stack:** TypeScript 5.9, CodeMirror 6 (state 6.5.0 / view 6.38.6 pinned via overrides), Svelte 5, jest 29 + ts-jest, bun + esbuild.

**Spec:** `docs/superpowers/specs/2026-07-11-repair-and-parity-design.md` (Phases 0 and 1).

## Global Constraints

- Toolchain is **bun**; all commands run via bun. Never commit `package-lock.json` (gitignored).
- CodeMirror versions stay pinned: `@codemirror/state` 6.5.0, `@codemirror/view` 6.38.6 (package.json `overrides`).
- `src/ui/components` and `src/database` are git submodules — do not modify files inside them.
- One task = at least one commit; build (`bun run build`) and tests (`bun run test`) must pass before every commit from Task 2 onward.
- Code style: tabs, dprint-formatted (`bun run format` before committing). Comments use the codebase's `// EXPL:` / `// NOTE:` prefixes.
- No behavior changes beyond those specified per task.
- If npm was used in this checkout earlier, delete `node_modules` before Task 1 so bun resolves cleanly.

---

### Task 1: Toolchain bootstrap

**Files:** none modified (environment only)

**Interfaces:**
- Produces: a checkout where `bun install`, `bun run build`, and submodules all work — every later task depends on this.

- [ ] **Step 1: Install bun**

```bash
brew install oven-sh/bun/bun
bun --version
```
Expected: a 1.x version prints.

- [ ] **Step 2: Clean npm artifacts and install**

```bash
cd /Users/andrewbroz/Code/forks/obsidian-criticmarkup
rm -rf node_modules
git submodule update --init --recursive
bun install
```
Expected: install completes; postinstall prints `Removed .../index.d.cts` lines for @codemirror/state and view.

- [ ] **Step 3: Baseline build**

```bash
bun run build
```
Expected: `tsc -noEmit` passes and esbuild produces `main.js` with no errors. If tsc fails here, STOP — the environment is not reproducing the upstream-blessed setup; diagnose before proceeding (check that the postinstall `.d.cts` removal ran).

- [ ] **Step 4: No commit** (nothing changed in the repo)

---

### Task 2: Un-break the jest test suite

**Files:**
- Rename: `jest.config.js` → `jest.config.cjs`

**Interfaces:**
- Produces: working `bun run test`; all later TDD tasks rely on it.

- [ ] **Step 1: Verify current failure**

```bash
bun run test 2>&1 | head -5
```
Expected: `ReferenceError: module is not defined in ES module scope`.

- [ ] **Step 2: Rename the config**

```bash
git mv jest.config.js jest.config.cjs
```
(jest auto-discovers `jest.config.cjs`; no content change needed.)

- [ ] **Step 3: Run the suite**

```bash
bun run test 2>&1 | tail -20
```
Expected: the `tests/cursor_movement.test.ts` suite executes. Expected PASS. If individual cursor tests fail, do NOT fix them in this task — record the failing case names in the commit message body as pre-existing failures and continue (they are input for Phase 1 work).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix: rename jest config to .cjs so tests run under type:module"
```

---

### Task 3: Package/manifest config fixes

**Files:**
- Modify: `package.json:8` (dev script), `package.json` dependencies
- Modify: `manifest-beta.json`

**Interfaces:**
- Produces: `@codemirror/search` declared (consumed by `src/ui/pages/annotations-view/filter-ranges.ts:5`).

- [ ] **Step 1: Fix the stale dev script**

In `package.json`, replace:
```json
"dev": "bun run esbuild.config.mjs && obsidian plugin:reload id=commentator",
```
with:
```json
"dev": "bun scripts/build/esbuild.config.ts development && obsidian plugin:reload id=commentator",
```
(`esbuild.config.mjs` does not exist; this mirrors `build:dev:hr` minus the tsc pass for fast iteration.)

- [ ] **Step 2: Declare the missing dependency**

```bash
bun add @codemirror/search@^6.5.0
```
Expected: added to `dependencies`, `bun.lock` updated. Note: the `overrides` pin on @codemirror/state stays authoritative; no override entry is needed for search.

- [ ] **Step 3: Sync manifest-beta.json**

Replace the full contents of `manifest-beta.json` with:
```json
{
    "id": "commentator",
    "name": "Commentator",
    "version": "0.2.6",
    "minAppVersion": "1.7.5",
    "description": "Suggest edits, add comments, and annotate your notes using CriticMarkup syntax.",
    "author": "kometenstaub and Fevol",
    "authorUrl": "https://github.com/fevol",
    "isDesktopOnly": false
}
```
(Identical to `manifest.json` — the beta manifest was carrying a stale minAppVersion 1.5.0 and old description.)

- [ ] **Step 4: Verify and commit**

```bash
bun run build && bun run test 2>&1 | tail -3
git add package.json bun.lock manifest-beta.json
git commit -m "fix: repair dev script, declare @codemirror/search, sync beta manifest"
```
Expected: build + tests green.

---

### Task 4: Rewrite the release workflow

**Files:**
- Rewrite: `.github/workflows/releases.yml`

- [ ] **Step 1: Replace the workflow**

Replace the full contents of `.github/workflows/releases.yml` with:

```yaml
name: Build obsidian plugin

on:
  push:
    tags:
      - "*"

env:
  PLUGIN_NAME: commentator

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: true
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
      - name: Build plugin
        run: |
          bun install --frozen-lockfile
          bun run build
          mkdir ${{ env.PLUGIN_NAME }}
          cp main.js manifest.json styles.css ${{ env.PLUGIN_NAME }}
          zip -r ${{ env.PLUGIN_NAME }}.zip ${{ env.PLUGIN_NAME }}
      - name: Generate release notes
        run: |
          PREV_TAG=$(git describe --tags --abbrev=0 "${GITHUB_REF_NAME}^" 2>/dev/null || echo "")
          if [ -n "$PREV_TAG" ]; then
            git log --pretty=format:'- %s' "$PREV_TAG..${GITHUB_REF_NAME}" > release_notes.md
          else
            git log --pretty=format:'- %s' "${GITHUB_REF_NAME}" > release_notes.md
          fi
      - name: Create release
        uses: softprops/action-gh-release@v2
        with:
          body_path: release_notes.md
          files: |
            ${{ env.PLUGIN_NAME }}.zip
            main.js
            manifest.json
            styles.css
```

Changes vs old file: removes the dead `cd ./src/editor/base/parser` build step (parser is an npm package since commit 7baea4d); replaces archived `actions/create-release@v1`/`upload-release-asset@v1` with `softprops/action-gh-release@v2`; drops removed `::set-output` syntax; generates release notes from git log instead of the nonexistent `CHANGELOG.md`.

- [ ] **Step 2: Validate YAML locally**

```bash
node -e "console.log('yaml ok')" && npx --yes yaml-lint .github/workflows/releases.yml 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/releases.yml')); print('yaml ok')"
```
Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/releases.yml
git commit -m "ci: repair release workflow (dead parser step, archived actions, set-output)"
```

---

### Task 5: Fix falsy-zero interval bug in accept/reject suggestions

**Files:**
- Modify: `src/editor/base/edit-logic/alter-suggestion.ts:11,21`
- Test: `tests/alter_suggestion.test.ts` (create)

**Interfaces:**
- Consumes: `acceptSuggestions(state, from?, to?, remove_attached_comments?)` / `rejectSuggestions(...)` — signatures unchanged.
- Produces: corrected semantics — `from`/`to` of `0` now means "interval", not "whole document". Callers (`src/editor/uix/commands.ts`, `src/editor/uix/context-menu.ts`) need no changes.

- [ ] **Step 1: Write the failing test**

Create `tests/alter_suggestion.test.ts`:

```typescript
import { EditorState } from "@codemirror/state";

import { rangeParser } from "../src/editor/base";
import { acceptSuggestions, rejectSuggestions } from "../src/editor/base/edit-logic/alter-suggestion";

describe("accept/reject suggestion interval handling", () => {
	const doc = "hello {++world++}";
	const state = EditorState.create({ doc, extensions: [rangeParser] });

	test("cursor selection at position 0 accepts/rejects nothing", () => {
		// EXPL: regression test — `(from || to)` treated position 0 as "no interval given"
		//       and fell back to EVERY range in the document
		expect(acceptSuggestions(state, 0, 0)).toHaveLength(0);
		expect(rejectSuggestions(state, 0, 0)).toHaveLength(0);
	});

	test("selection before the range accepts nothing", () => {
		expect(acceptSuggestions(state, 0, 5)).toHaveLength(0);
	});

	test("interval from 0 covering the range accepts it", () => {
		expect(acceptSuggestions(state, 0, doc.length)).toHaveLength(1);
	});

	test("no interval given accepts all suggestions", () => {
		expect(acceptSuggestions(state)).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun run test -- tests/alter_suggestion.test.ts
```
Expected: FAIL — "cursor selection at position 0" gets length 1 (all ranges) instead of 0.

- [ ] **Step 3: Fix both functions**

In `src/editor/base/edit-logic/alter-suggestion.ts`, in **both** `acceptSuggestions` (line 11) and `rejectSuggestions` (line 21), replace:
```typescript
	return ((from || to) ? range_field.ranges_in_interval(from ?? 0, to ?? Infinity) : range_field.ranges)
```
with:
```typescript
	return ((from !== undefined || to !== undefined) ? range_field.ranges_in_interval(from ?? 0, to ?? Infinity) : range_field.ranges)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun run test -- tests/alter_suggestion.test.ts
```
Expected: PASS (4/4).

- [ ] **Step 5: Full verify and commit**

```bash
bun run build && bun run test 2>&1 | tail -3
git add src/editor/base/edit-logic/alter-suggestion.ts tests/alter_suggestion.test.ts
git commit -m "fix: selection at position 0 no longer accepts/rejects every suggestion in the document"
```

---

### Task 6: Staleness guard for vault-wide range edits

**Files:**
- Modify: `src/editor/uix/workspace.ts:8-35` (`applyRangeEditsToVault`)
- Test: `tests/workspace_guard.test.ts` (create)

**Interfaces:**
- Consumes: `plugin.database.getItem(path)` → `DatabaseItem<T> | null` where `DatabaseItem<T> = { data: T; mtime: number }` (from `src/database/database.ts:11,318`).
- Produces: `isEntryStale(file_mtime: number, db_mtime: number | undefined): boolean` exported from `src/editor/uix/workspace.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace_guard.test.ts`:

```typescript
import { isEntryStale } from "../src/editor/uix/workspace";

describe("isEntryStale", () => {
	test("file modified after index entry is stale", () => {
		expect(isEntryStale(2000, 1000)).toBe(true);
	});

	test("file not modified since index entry is fresh", () => {
		expect(isEntryStale(1000, 1000)).toBe(false);
		expect(isEntryStale(1000, 2000)).toBe(false);
	});

	test("missing index entry is stale", () => {
		expect(isEntryStale(1000, undefined)).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun run test -- tests/workspace_guard.test.ts
```
Expected: FAIL with `isEntryStale` is not exported / not a function.
Note: `workspace.ts` imports `obsidian`; jest resolves that to the root `__mocks__/obsidian.ts` automatically (same mechanism the cursor tests rely on). If the import chain errors on a missing export from the mock, add a minimal stub export to `__mocks__/obsidian.ts` (e.g. `export class Notice { constructor(..._args: unknown[]) {} }`) — additive only.

- [ ] **Step 3: Implement the guard**

In `src/editor/uix/workspace.ts`, add above `applyRangeEditsToVault`:

```typescript
/**
 * EXPL: Range offsets come from the vault index, which refreshes on a debounce.
 *       If the file changed after it was indexed, those offsets may no longer match
 *       the file contents, and applying them would corrupt the file.
 */
export function isEntryStale(file_mtime: number, db_mtime: number | undefined): boolean {
	return db_mtime === undefined || file_mtime > db_mtime;
}
```

Then inside the `applyRangeEditsToVault` loop, directly after the `if (!file || !(file instanceof TFile)) { continue; }` block, insert:

```typescript
		if (isEntryStale(file.stat.mtime, plugin.database.getItem(path)?.mtime)) {
			new Notice(
				`Commentator: Skipped "${path}" — the file changed after its annotations were indexed. Wait a moment (or rebuild the database) and try again.`,
				5000,
			);
			continue;
		}
```

Finally, replace the unconditional history push at the end of the function:
```typescript
	plugin.file_history.push({changes: file_history, mtime: Date.now()});
```
with:
```typescript
	// EXPL: Only record history for files that were actually modified
	if (Object.keys(file_history).length > 0)
		plugin.file_history.push({ changes: file_history, mtime: Date.now() });
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun run test -- tests/workspace_guard.test.ts
```
Expected: PASS (3/3).

- [ ] **Step 5: Full verify and commit**

```bash
bun run build && bun run test 2>&1 | tail -3
git add src/editor/uix/workspace.ts tests/workspace_guard.test.ts __mocks__/obsidian.ts
git commit -m "fix: skip vault-wide accept/reject on files modified after indexing (data-loss guard)"
```

- [ ] **Step 6: Manual smoke note**

Record in the execution notes: verify in a test vault that Annotations View accept still works on an untouched file, and that editing a file then immediately accepting from the view within ~1s shows the skip Notice instead of corrupting.

---

### Task 7: Fix rangeCorrecter metadata destruction + cursor drift

**Files:**
- Modify: `src/editor/uix/extensions/range-correcter.ts`
- Test: `tests/range_correcter.test.ts` (create)

**Interfaces:**
- Consumes: `CriticMarkupRange.range_start` (`= metadata + 2` when metadata exists, else `from + 3` — `src/editor/base/ranges/base_range.ts:85-87`); `range.unwrap()` returns content **without** metadata (constructor strips it, `base_range.ts:40`).
- Produces: unchanged export `rangeCorrecter`.

**Bug being fixed (the file's own FIXME, line 10):** for a range carrying `{"author":...}@@` metadata, the filter replaces doc region `from+3 .. to-3` (which *includes* the metadata) with `unwrap()` text (which *excludes* it) — silently deleting the metadata. Additionally `removed_characters` overcounts newline collapses (each `\n\s*\n` → `\n` keeps one char) and the cursor is shifted even when it exited *before* the range.

- [ ] **Step 1: Write the failing test**

Create `tests/range_correcter.test.ts`:

```typescript
import { EditorSelection, EditorState } from "@codemirror/state";

import { rangeParser } from "../src/editor/base";
import { rangeCorrecter } from "../src/editor/uix/extensions/range-correcter";

// EXPL: This is the exact document from the FIXME at range-correcter.ts:10
const METADATA = `{"author":"Fevol","time":1708879304}`;
const doc = `In ad{~~${METADATA}@@dition to document files, metadata is used for:\n\n- videos~>audio~~}\n- audio files`;

function exitRange(from_pos: number, to_pos: number) {
	const state = EditorState.create({
		doc,
		selection: EditorSelection.cursor(from_pos),
		extensions: [rangeParser, rangeCorrecter],
	});
	return state.update({
		selection: EditorSelection.cursor(to_pos),
		userEvent: "select",
	});
}

describe("rangeCorrecter on substitution range with metadata", () => {
	const inside = doc.indexOf("metadata is used"); // cursor inside the range content

	test("exiting the range preserves metadata while collapsing double newlines", () => {
		const tr = exitRange(inside, 0);
		const result = tr.state.doc.toString();
		expect(result).toContain(`{~~${METADATA}@@`); // metadata survives
		expect(result).toContain("used for:\n- videos"); // \n\n collapsed to \n
	});

	test("cursor exiting leftwards (before the range) is not shifted", () => {
		const tr = exitRange(inside, 0);
		expect(tr.state.selection.main.head).toBe(0);
	});

	test("cursor exiting rightwards is shifted by exactly the removed characters", () => {
		const tr = exitRange(inside, doc.length);
		// EXPL: one "\n\n" collapses to "\n" => exactly 1 character removed
		expect(tr.state.doc.length).toBe(doc.length - 1);
		expect(tr.state.selection.main.head).toBe(doc.length - 1);
	});
});

describe("rangeCorrecter still corrects ranges without metadata", () => {
	test("leading whitespace inside a highlight is stripped on exit", () => {
		const plain_doc = "x{== hl==}y";
		const state = EditorState.create({
			doc: plain_doc,
			selection: EditorSelection.cursor(6),
			extensions: [rangeParser, rangeCorrecter],
		});
		const tr = state.update({
			selection: EditorSelection.cursor(plain_doc.length),
			userEvent: "select",
		});
		expect(tr.state.doc.toString()).toBe("x{==hl==}y");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun run test -- tests/range_correcter.test.ts
```
Expected: FAIL — metadata assertion fails (metadata deleted) and/or cursor assertions fail. If the *whole suite* fails because the parser does not produce a range for the metadata document, STOP and investigate the parse (print `state.field(rangeParser).ranges.ranges`) before changing the filter — the fix's `from` position depends on `range_start` being metadata-aware.

- [ ] **Step 3: Fix the filter**

In `src/editor/uix/extensions/range-correcter.ts`, replace the body of the `if (changed)` block and the newline accounting. The full new file contents:

```typescript
import { type ChangeSpec, EditorSelection, EditorState } from "@codemirror/state";

import { rangeParser, SuggestionType } from "../../base";

/**
 * Removes initial whitespaces and double newlines from ranges that would otherwise result in markup being applied
 * to text that is not part of the range (due to CM shenanigans)
 */
export const rangeCorrecter = EditorState.transactionFilter.of(tr => {
	if (tr.isUserEvent("select")) {
		const previous_selection = tr.startState.selection.main, current_selection = tr.selection!.main;

		if (current_selection.anchor === current_selection.head) {
			const ranges = tr.startState.field(rangeParser).ranges;

			const start_range = ranges.at_cursor(previous_selection.head);
			const end_range = ranges.at_cursor(current_selection.head);

			// Execute only if the cursor is moved outside a particular range
			if (
				start_range && start_range !== end_range &&
				(start_range.type === SuggestionType.SUBSTITUTION || start_range.type === SuggestionType.HIGHLIGHT)
			) {
				let new_text = start_range.unwrap();
				let changed = false;

				let removed_characters = 0;
				const left_whitespace_end = new_text.search(/\S/);
				if (left_whitespace_end >= 1) {
					changed = true;
					new_text = new_text.slice(left_whitespace_end);
					removed_characters += left_whitespace_end;
				}

				const invalid_endlines = new_text.match(/\n\s*\n/g);
				if (invalid_endlines) {
					changed = true;
					new_text = new_text.replace(/\n\s*\n/g, "\n");
					// EXPL: Each match is replaced by a single "\n", so one character per match survives
					removed_characters += invalid_endlines.reduce((acc, cur) => acc + cur.length - 1, 0);
				}

				if (changed) {
					const changes: ChangeSpec[] = [{
						// EXPL: unwrap() strips the metadata block, so the replacement must start at
						//       range_start (after the metadata) — starting at from + 3 would delete it
						from: start_range.range_start,
						to: start_range.to - 3,
						insert: new_text,
					}];
					// EXPL: Only shift the cursor when it exited past the removed characters
					const head = current_selection.head <= start_range.range_start ?
						current_selection.head :
						current_selection.head - removed_characters;
					return {
						changes,
						selection: EditorSelection.cursor(head),
					};
				}
			}
		}
	}

	return tr;
});
```

(The FIXME comment block at lines 10-14 is removed — that case is now the regression test.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun run test -- tests/range_correcter.test.ts
```
Expected: PASS (4/4).

- [ ] **Step 5: Full verify and commit**

```bash
bun run build && bun run test 2>&1 | tail -3
git add src/editor/uix/extensions/range-correcter.ts tests/range_correcter.test.ts
git commit -m "fix: rangeCorrecter no longer destroys range metadata or over-shifts the cursor"
```

---

### Task 8: Fix no-op delete_metadata

**Files:**
- Modify: `src/editor/base/ranges/base_range.ts:125-136`
- Test: `tests/range_metadata.test.ts` (create)

**Interfaces:**
- Consumes: `remove_metadata(): EditorChange[]` and `set_metadata(fields): EditorChange[]` (both already correct, `base_range.ts:116-159`).
- Produces: `delete_metadata(key: string): EditorChange[]` that actually returns the document edits. Currently uncalled anywhere — this makes it safe for Phase 3 metadata work.

- [ ] **Step 1: Write the failing test**

Create `tests/range_metadata.test.ts`:

```typescript
import { EditorState } from "@codemirror/state";

import { rangeParser } from "../src/editor/base";

function parseFirstRange(doc: string) {
	const state = EditorState.create({ doc, extensions: [rangeParser] });
	return state.field(rangeParser).ranges.ranges[0];
}

describe("delete_metadata", () => {
	test("deleting the only key removes the whole metadata block", () => {
		const range = parseFirstRange(`x{~~{"author":"A"}@@a~>b~~}y`);
		expect(range.fields.author).toBe("A");

		const changes = range.delete_metadata("author");
		// EXPL: metadata block spans from after "{~~" to after "@@"
		expect(changes).toEqual([{ from: range.from + 3, to: range.metadata! + 2, insert: "" }]);
	});

	test("deleting one of several keys rewrites the remaining metadata", () => {
		const range = parseFirstRange(`x{~~{"author":"A","time":1}@@a~>b~~}y`);

		const changes = range.delete_metadata("time");
		expect(changes).toEqual([{ from: range.from + 3, to: range.metadata!, insert: `{"author":"A"}` }]);
	});

	test("deleting an absent key is a no-op", () => {
		const range = parseFirstRange(`x{~~{"author":"A"}@@a~>b~~}y`);
		expect(range.delete_metadata("color")).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun run test -- tests/range_metadata.test.ts
```
Expected: FAIL — first two tests receive `[]` (the computed edits are discarded).
If instead the tests fail because `range.fields.author` is undefined, the parser is not populating metadata for this syntax — STOP and check the parse output before touching `delete_metadata`.

- [ ] **Step 3: Fix the method**

In `src/editor/base/ranges/base_range.ts`, replace `delete_metadata` (lines 125-136) with:

```typescript
	delete_metadata(key: string): EditorChange[] {
		if (key in shortHandMapping) key = shortHandMapping[key as keyof typeof shortHandMapping];

		if (!(key in this.fields))
			return [];

		delete this.fields[key as keyof typeof this.fields];
		if (Object.keys(this.fields).length === 0)
			return this.remove_metadata();
		return this.set_metadata(this.fields);
	}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun run test -- tests/range_metadata.test.ts
```
Expected: PASS (3/3).

- [ ] **Step 5: Full verify and commit**

```bash
bun run build && bun run test 2>&1 | tail -3
git add src/editor/base/ranges/base_range.ts tests/range_metadata.test.ts
git commit -m "fix: delete_metadata returns its document edits instead of discarding them"
```

---

### Task 9: Replace gutter-config array reach-through with explicit return

**Files:**
- Modify: `src/editor/renderers/gutters/base.ts:555-562` (`createGutter`)
- Modify: `src/editor/renderers/gutters/annotations-gutter/annotation-gutter.ts:230-232` (`annotation_gutter`)
- Modify: `src/editor/renderers/gutters/annotations-gutter/index.ts:17-28` (`annotationGutter`)
- Modify: `src/main.ts:112-117`

**Interfaces:**
- Consumes: `createGutter(viewplugin, config, activeGutters, unfixGutters)` currently returns `[extension, activeGutters.of({...defaults, ...config})]`; `main.ts:115` reaches into `(annotation_gutter as unknown as any)[1][1].value` to grab that merged config object. The object identity matters: `main.ts:174-176` mutates it so the gutter reads updated width/fold state before init.
- Produces:
  - `createGutterWithConfig(viewplugin, config, activeGutters, unfixGutters): { extension: Extension; config: Required<GutterConfig> }` in `base.ts`;
  - `annotation_gutter(config): { extension: Extension; config: Required<AnnotationGutterConfig> }`;
  - `annotationGutter(plugin): { extension: Extension; config: Required<AnnotationGutterConfig> }`.
- The diff gutter's `createGutter` call (`diffs-gutter/diff-gutter.ts:90`) keeps working unchanged.

- [ ] **Step 1: Check for other callers**

```bash
grep -rn "annotationGutter(" src/ --include="*.ts" | grep -v "annotations-gutter/"
```
Expected: only `src/main.ts:113`. If other call sites appear, update them the same way as main.ts below.

- [ ] **Step 2: Add config-returning factory in base.ts**

In `src/editor/renderers/gutters/base.ts`, replace `createGutter` (lines 555-562) with:

```typescript
/** Define an editor gutter. The order in which the gutters appear is
 determined by their extension priority.
 */
export function createGutter(
	viewplugin: ViewPlugin<GutterView>,
	config: GutterConfig,
	activeGutters: Facet<Required<GutterConfig>>,
	unfixGutters: Facet<boolean, boolean>,
) {
	return createGutterWithConfig(viewplugin, config, activeGutters, unfixGutters).extension;
}

/**
 * Like createGutter, but also returns the merged config object registered in the facet.
 * EXPL: The returned object is the exact instance the gutter reads; callers may mutate it
 *       to communicate initial width/fold state before the gutter initializes.
 */
export function createGutterWithConfig(
	viewplugin: ViewPlugin<GutterView>,
	config: GutterConfig,
	activeGutters: Facet<Required<GutterConfig>>,
	unfixGutters: Facet<boolean, boolean>,
): { extension: Extension; config: Required<GutterConfig> } {
	const merged = { ...defaults, ...config } as Required<GutterConfig>;
	return {
		extension: [createGutterExtension(viewplugin, {}, unfixGutters), activeGutters.of(merged)],
		config: merged,
	};
}
```
Note: `createGutter` previously returned `Extension[]`; it now returns `Extension` (the nested array is itself a valid Extension). Verify `diff-gutter.ts:90` still type-checks — CodeMirror treats `Extension | Extension[]` interchangeably.

- [ ] **Step 3: Thread through annotation_gutter**

In `src/editor/renderers/gutters/annotations-gutter/annotation-gutter.ts`, replace (lines 230-232):
```typescript
export function annotation_gutter(config: AnnotationGutterConfig): Extension {
	return createGutter(annotationGutterView, config, activeGutters, unfixGutters);
}
```
with:
```typescript
export function annotation_gutter(config: AnnotationGutterConfig): { extension: Extension; config: Required<AnnotationGutterConfig> } {
	return createGutterWithConfig(annotationGutterView, config, activeGutters, unfixGutters) as
		{ extension: Extension; config: Required<AnnotationGutterConfig> };
}
```
and add `createGutterWithConfig` to the existing import from `../base` (replacing the `createGutter` import if nothing else in the file uses it).

- [ ] **Step 4: Thread through annotationGutter**

In `src/editor/renderers/gutters/annotations-gutter/index.ts`, replace the `annotationGutter` export (lines 17-28) with:

```typescript
// NOTE: Keep the gutter here, as Obsidian *really* does not like the circular reference
// 		 between Markers and Gutters (which is required for calling the moveGutter function)
export const annotationGutter = (plugin: CommentatorPlugin) => {
	const { extension, config } = annotation_gutter({
		class: "cmtr-anno-gutter " + (plugin.app.vault.getConfig("cssTheme") === "Minimal" ? " is-minimal" : ""),
		markers: v => v.state.field(annotationGutterMarkers),
		foldState: plugin.settings.annotation_gutter_default_fold_state,
		width: plugin.settings.annotation_gutter_width,
		hideOnEmpty: plugin.settings.annotation_gutter_hide_empty,
		includeFoldButton: plugin.settings.annotation_gutter_fold_button,
		includeResizeHandle: plugin.settings.annotation_gutter_resize_handle,
	});
	return { extension: [annotationGutterMarkers, extension], config };
};
```

- [ ] **Step 5: Fix the main.ts call site**

In `src/main.ts`, replace (lines 112-117):
```typescript
		if (this.settings.annotation_gutter) {
			const annotation_gutter = annotationGutter(this);
			// FIXME: Bad. Bad. Bad. This is drivel of the highest degree.
			this.annotation_gutter_config = (annotation_gutter as unknown as any)[1][1].value;
			this.editorExtensions.push(annotationGutterCompartment.of(Prec.low(annotation_gutter)));
		}
```
with:
```typescript
		if (this.settings.annotation_gutter) {
			const { extension, config } = annotationGutter(this);
			this.annotation_gutter_config = config;
			this.editorExtensions.push(annotationGutterCompartment.of(Prec.low(extension)));
		}
```

- [ ] **Step 6: Full verify and commit**

```bash
bun run build && bun run test 2>&1 | tail -3
git add src/editor/renderers/gutters/base.ts "src/editor/renderers/gutters/annotations-gutter/annotation-gutter.ts" "src/editor/renderers/gutters/annotations-gutter/index.ts" src/main.ts
git commit -m "refactor: return annotation gutter config explicitly instead of array index reach-through"
```

- [ ] **Step 7: Manual smoke note**

Record in execution notes: in a test vault, resize + fold the annotation gutter, switch notes, and confirm the width/fold state carries over (this exercises the mutation path at `main.ts:174-176`).

---

### Task 10: Diagnosability cleanups

**Files:**
- Modify: `src/main.ts:315-317`
- Modify: `src/ui/pages/settings/tabs/GeneralSettings.svelte:156`
- Modify: `src/patches.ts:107-127`

- [ ] **Step 1: Log the swallowed migration error**

In `src/main.ts`, replace:
```typescript
			} catch (e) {
				new Notice("Commentator: Migration to new settings failed, using the default settings provided by the plugin", 0);
			}
```
with:
```typescript
			} catch (e) {
				console.error("Commentator: settings migration failed", e);
				new Notice("Commentator: Migration to new settings failed, using the default settings provided by the plugin", 0);
			}
```

- [ ] **Step 2: Remove the unconditional console.log**

In `src/ui/pages/settings/tabs/GeneralSettings.svelte`, in the Rebuild button `onClick`, delete the line:
```typescript
        console.log("Database rebuilt");
```

- [ ] **Step 3: Delete the dead commented-out block**

In `src/patches.ts`, delete lines 107-127 (the commented-out alternative `loadFile` implementation, from `// NOTE: Alternative that is only called when file is changed…` through the final `// },`). Git history preserves it.

- [ ] **Step 4: Full verify and commit**

```bash
bun run build && bun run test 2>&1 | tail -3
git add src/main.ts src/ui/pages/settings/tabs/GeneralSettings.svelte src/patches.ts
git commit -m "chore: log migration failures, drop debug log and dead code"
```

---

### Task 11: Regression-test harness for mark_ranges

**Files:**
- Test: `tests/mark_ranges.test.ts` (create)
- Test snapshot: `tests/__snapshots__/mark_ranges.test.ts.snap` (generated)

**Interfaces:**
- Consumes: `mark_ranges(ranges: CriticMarkupRanges, text: Text, from: number, to: number, inserted: string, type: MarkType, metadata_fields?: MetadataFields, force?): EditorSuggestion[]` (`src/editor/base/edit-logic/mark.ts:441`); `EditorSuggestion = { from, to, insert, start, end }` (`src/editor/base/edit-handler/types.ts`).
- Produces: the tripwire suite that Phases 2 and 3 must keep green. **No production code changes in this task** — bugs found here get `// BUG:` comments in the test and a note in execution notes, not fixes.

- [ ] **Step 1: Write the harness with explicit-expectation tests**

Create `tests/mark_ranges.test.ts`:

```typescript
import { EditorState } from "@codemirror/state";

import { rangeParser, SuggestionType } from "../src/editor/base";
import type { EditorSuggestion } from "../src/editor/base/edit-handler";
import { mark_ranges, MarkAction, type MarkType } from "../src/editor/base/edit-logic/mark";
import type { MetadataFields } from "../src/editor/base/ranges";

function mark(doc: string, from: number, to: number, inserted: string, type: MarkType, metadata_fields?: MetadataFields): string {
	const state = EditorState.create({ doc, extensions: [rangeParser] });
	const ranges = state.field(rangeParser).ranges;
	const edits: EditorSuggestion[] = mark_ranges(ranges, state.doc, from, to, inserted, type, metadata_fields);

	// EXPL: edits must never overlap — overlapping edits would corrupt the document
	const ordered = [...edits].sort((a, b) => a.from - b.from);
	for (let i = 1; i < ordered.length; i++)
		expect(ordered[i].from).toBeGreaterThanOrEqual(ordered[i - 1].to);

	let output = doc;
	for (const edit of [...ordered].reverse())
		output = output.slice(0, edit.from) + edit.insert + output.slice(edit.to);
	return output;
}

describe("mark_ranges in plain text", () => {
	test("insertion wraps in addition markup", () => {
		expect(mark("hello world", 5, 5, " big", SuggestionType.ADDITION)).toBe("hello{++ big++} world");
	});

	test("deletion wraps in deletion markup", () => {
		expect(mark("hello world", 5, 11, "", SuggestionType.DELETION)).toBe("hello{-- world--}");
	});

	test("replacement wraps in substitution markup", () => {
		expect(mark("hello world", 6, 11, "there", SuggestionType.SUBSTITUTION)).toBe("hello {~~world~>there~~}");
	});

	test("insertion with metadata prepends the metadata block", () => {
		expect(mark("hello world", 5, 5, " big", SuggestionType.ADDITION, { author: "A" }))
			.toBe(`hello{++{"author":"A"}@@ big++} world`);
	});
});

// EXPL: Characterization tests — they pin down CURRENT behavior of the branches
//       mark.ts itself flags as uncertain (its TODO/FIXME comments), so any later
//       change to this logic trips a snapshot diff and gets reviewed deliberately.
describe("mark_ranges characterization (snapshot-pinned)", () => {
	const cases: [string, string, number, number, string, MarkType][] = [
		["insert inside existing addition", "he{++llo++}", 7, 7, "y", SuggestionType.ADDITION],
		["insert at right edge of addition", "he{++llo++}x", 11, 11, "y", SuggestionType.ADDITION],
		["delete spanning plain text and addition", "ab{++cd++}ef", 0, 12, "", SuggestionType.DELETION],
		["delete inside existing deletion", "ab{--cd--}ef", 5, 6, "", SuggestionType.DELETION],
		["substitution across existing substitution", "x{~~y~>z~~}u", 0, 12, "new", SuggestionType.SUBSTITUTION],
		["substitution spanning two adjacent ranges", "uv{++w++}{++y++}z", 0, 17, "q", SuggestionType.SUBSTITUTION],
		["deletion across highlight range", "ab{==cd==}ef", 0, 12, "", SuggestionType.DELETION],
		["clear action on marked text", "hello{++ big++} world", 0, 21, "", MarkAction.CLEAR],
		["insert between two additions", "uv{++w++}{++y++}z", 9, 9, "x", SuggestionType.ADDITION],
		["delete exactly an addition's contents", "ab{++cd++}ef", 5, 7, "", SuggestionType.DELETION],
	];

	for (const [name, doc, from, to, inserted, type] of cases) {
		test(name, () => {
			expect(mark(doc, from, to, inserted, type)).toMatchSnapshot();
		});
	}

	test("insert into range with different author is kept outside that range", () => {
		expect(mark(`a{++{"author":"B"}@@bc++}d`, 21, 21, "x", SuggestionType.ADDITION, { author: "A" }))
			.toMatchSnapshot();
	});
});
```

- [ ] **Step 2: Run the explicit-expectation tests first**

```bash
bun run test -- tests/mark_ranges.test.ts -t "plain text"
```
Expected: PASS (4/4). If any explicit expectation fails, the *actual* output must be inspected by hand: if the actual output is valid CriticMarkup that loses no user text, update the expectation with a comment explaining the semantics; if it loses text or produces unbalanced markup, mark the test `test.failing` (jest 29 supports it) with a `// BUG:` comment describing the corruption, and record it in execution notes. Do not fix mark.ts in this task.

- [ ] **Step 3: Generate and audit the snapshots**

```bash
bun run test -- tests/mark_ranges.test.ts
cat tests/__snapshots__/mark_ranges.test.ts.snap
```
Read every snapshot entry and verify by hand: (1) brackets balanced, (2) every character of the original doc either survives or sits inside `{--…--}`/`{~~…~>` markup, (3) inserted text appears exactly once. Annotate any violation with a `// BUG:` comment above its test case and record it in execution notes.

- [ ] **Step 4: Full verify and commit**

```bash
bun run build && bun run test 2>&1 | tail -3
git add tests/mark_ranges.test.ts tests/__snapshots__/mark_ranges.test.ts.snap
git commit -m "test: add regression harness for mark_ranges (explicit + characterization)"
```

---

### Task 12: Phase completion check

- [ ] **Step 1: Full suite + build from clean state**

```bash
rm -rf node_modules && bun install && bun run build && bun run test 2>&1 | tail -5
```
Expected: everything green from scratch (proves Task 1-3 environment fixes are complete and reproducible).

- [ ] **Step 2: Reconcile plan vs. execution notes**

Confirm every `// BUG:` discovered in Task 11 and any pre-existing cursor-test failures from Task 2 are written into `docs/superpowers/plans/2026-07-11-phase-0-1-execution-notes.md` (create it if any exist) — these seed the Phase 2/3 planning.

- [ ] **Step 3: Commit notes if created**

```bash
git add docs/superpowers/plans/2026-07-11-phase-0-1-execution-notes.md 2>/dev/null && git commit -m "docs: record phase 0+1 execution findings" || echo "no notes to commit"
```
