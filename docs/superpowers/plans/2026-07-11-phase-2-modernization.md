# Phase 2: Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modernize the toolchain (ESLint 10, jest 30, single formatter), vendor the two git submodules, and land the small cleanups deferred from Phase 0+1 — all mechanically, with no product behavior change except the two explicitly-scoped Notice/workflow tweaks.

**Architecture:** No structural changes to `src/` beyond one generic type signature and one Notice-batching block. Tooling configs are replaced wholesale (`.eslintrc.cjs` → `eslint.config.js` flat config); test infra gains a shared helper. Every task is its own commit with the full gate green.

**Tech Stack:** bun, TypeScript 5.9 (unchanged), ESLint 10 + typescript-eslint 8.63 + eslint-plugin-svelte 3.20, jest 30 + ts-jest 29.4.11, dprint 0.55, esbuild 0.28.

**Spec:** `docs/superpowers/specs/2026-07-11-repair-and-parity-design.md` (Phase 2) plus deferrals in `docs/superpowers/plans/2026-07-11-phase-0-1-execution-notes.md`.

## Global Constraints

- Toolchain is bun (`export PATH="$HOME/.bun/bin:$PATH"` in every shell). Never commit `package-lock.json`. `bun.lock` IS tracked and changes with dependency edits.
- Gate before EVERY commit: `bun run build && bun run test` green (baseline: build clean, 1082/1082 tests, 6 suites, 11 snapshots). Tasks that change lint config also require `bun run lint` exit 0.
- `bunfig.toml` enforces `minimumReleaseAge` of 3 days: if `bun add pkg@^X.Y.Z` rejects a too-new version, step down to the newest version older than 3 days and note it in the report.
- `trustedDependencies: []` in package.json must be preserved (dependency lifecycle scripts stay disabled).
- CodeMirror pins stay: `@codemirror/state` 6.5.0, `@codemirror/view` 6.38.6 via `overrides`.
- dprint runs via bun on this machine (`bun node_modules/dprint/bin.js`) because the system node is a Rosetta x64 build — never invoke dprint through node directly.
- The four `// BUG:` annotated snapshot cases in tests/mark_ranges.test.ts must NOT change in this phase — a snapshot diff there means you broke something (or fixed something out of scope; either way STOP and report).
- NO product behavior changes except Task 7 (Notice batching) and Task 1's workflow edits, both explicitly scoped.
- Test-infra conventions from Phase 0+1 apply (see execution notes: settings-extension pattern, enable_metadata, obsidian mock).

## Explicitly out of scope (do not do here)

- The reject-all corruption fix (execution-notes bug 2) — scheduled as the FIRST task of Phase 3 (it is a behavior change).
- TypeScript 7 migration; splitting large files; any Phase 3 feature work.

---

### Task 1: Vendor the two git submodules

**Files:**

- Delete: `.gitmodules`
- Convert from gitlink to regular tracked content: `src/database/` (5 files), `src/ui/components/` (33 files)
- Modify: `.github/workflows/releases.yml` (drop `submodules: true`; cap first-release notes)
- Modify: `src/database/README.md`, `src/ui/components/README.md` (provenance note)

**Interfaces:**

- Produces: `src/database` and `src/ui/components` as normal directories — later tasks (ESLint config) reference them as vendored paths to exclude from lint.

- [ ] **Step 1: Record submodule provenance**

```bash
git submodule status
```

Note the two SHAs (expected: `d2b8304...` for src/database, `236bb3c...` for src/ui/components) — they go into the provenance notes below.

- [ ] **Step 2: Convert gitlinks to regular content**

```bash
git rm --cached src/database src/ui/components
rm -f src/database/.git src/ui/components/.git
git rm .gitmodules
git config --remove-section submodule.src/database 2>/dev/null; git config --remove-section submodule.src/ui/components 2>/dev/null; true
git add src/database src/ui/components
git status --porcelain | head -50
```

Expected: all 38 files staged as new; `.gitmodules` deleted. (`git rm --cached` on a gitlink leaves the working files in place; the `.git` files inside the submodule dirs are gitdir pointer files, safe to delete.)

- [ ] **Step 3: Add provenance notes**

Append to `src/database/README.md`:

```markdown
> Vendored from https://github.com/Fevol/obsidian-database-library at commit d2b8304 (2026-07-11). This copy is maintained in-tree; upstream sync is manual.
```

Append the equivalent to `src/ui/components/README.md` (repo: `https://github.com/Fevol/obsidian-svelte-component-library`, commit 236bb3c). Use the actual SHAs from Step 1.

- [ ] **Step 4: Update the release workflow**

In `.github/workflows/releases.yml`:

1. Delete the two checkout option lines `submodules: true` (keep `fetch-depth: 0` — still needed for tags/notes).
2. In the "Generate release notes" step, change the no-previous-tag fallback line from:

```yaml
git log --pretty=format:'- %s' "${GITHUB_REF_NAME}" > release_notes.md
```

to:

```yaml
git log -n 50 --pretty=format:'- %s' "${GITHUB_REF_NAME}" > release_notes.md
```

(An unbounded first-release log would dump the repo's entire history into the release body.)

- [ ] **Step 5: Verify and commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run build && bun run test 2>&1 | tail -3
git add -u && git add src/database src/ui/components .github/workflows/releases.yml
git commit -m "chore: vendor database and component-library submodules as regular source"
```

Expected: build clean, 1082/1082. Confirm `git submodule status` now prints nothing.

---

### Task 2: README dev-setup rewrite, roadmap truth-up, stale config purge

**Files:**

- Modify: `README.md` (Developing section + two roadmap checkboxes)
- Modify: `.gitignore` (remove stale `parser/build/`)

- [ ] **Step 1: Rewrite the Developing section**

Replace the numbered list under `### Developing` in README.md with:

```markdown
To set up a development environment:

1. Install the `bun` package manager from https://bun.sh/
2. Clone this repository (`git clone https://github.com/AndrewBroz/obsidian-criticmarkup.git`)
3. Run `bun install` in the root of the repository
4. Run `bun run build:dev` to build the plugin
5. (_Optional_) For automatic plugin reload on each build, use `bun run build:dev:hr` (requires the [Obsidian CLI](https://obsidian.md/cli))

Other commands: `bun run test` (jest suite), `bun run lint` (ESLint), `bun run format` (dprint).
```

(Drops `--recurse-submodules` — the submodules were vendored in Task 1 — and points at this fork's URL.)

- [ ] **Step 2: Check off the two implemented roadmap items**

In README.md's Suggestion View section, change:

```markdown
- [ ] Filter by recency
- [ ] Filter by author (see also custom syntax)
```

to:

```markdown
- [x] Filter by recency
- [x] Filter by author (see also custom syntax)
```

(Both are fully implemented — `src/ui/pages/annotations-view/filter-ranges.ts:100-157` — they only require metadata to be enabled, which Phase 3 makes the default.)

- [ ] **Step 3: Remove the stale gitignore entry**

In `.gitignore`, delete the line `parser/build/` (the parser directory was removed when the parser became an npm package).

- [ ] **Step 4: Verify and commit**

```bash
bun run build && bun run test 2>&1 | tail -3
git add README.md .gitignore
git commit -m "docs: update dev setup for vendored deps, check off implemented roadmap items"
```

---

### Task 3: ESLint 8 → 10 flat config, with Svelte files actually linted

**Files:**

- Delete: `.eslintrc.cjs`
- Create: `eslint.config.js`
- Modify: `package.json` (dependency swap; `lint` script unchanged)

**Interfaces:**

- Consumes: vendored dirs from Task 1 (excluded from linting as third-party code).
- Produces: `bun run lint` exits 0 and, for the first time, actually lints `.svelte` files (the old config declared the svelte plugin but ignored `**/*.svelte`).

- [ ] **Step 1: Swap the lint dependencies**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun remove eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser eslint-plugin-deprecation
bun add -d eslint@^10.7.0 typescript-eslint@^8.63.0 eslint-plugin-svelte@^3.20.0 svelte-eslint-parser@^1.8.0 globals@^17.7.0 @eslint/js@^10.0.0
```

Note: `eslint-plugin-deprecation` is deprecated — its rule now ships as `@typescript-eslint/no-deprecated`. If `@eslint/js@^10` doesn't resolve (its major tracks eslint), use the version matching the installed eslint (`npm view @eslint/js versions` to confirm) and note it.

- [ ] **Step 2: Delete the legacy config, create the flat config**

`git rm .eslintrc.cjs`, then create `eslint.config.js`:

```javascript
import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	// Vendored third-party code and build outputs are not ours to lint
	{
		ignores: [
			"main.js",
			"src/database/**",
			"src/ui/components/**",
			"scripts/**",
			"**/*.js",
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	...svelte.configs.recommended,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
		},
		rules: {
			// Carried over from .eslintrc.cjs
			"no-unused-vars": "off",
			"@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
			"@typescript-eslint/no-explicit-any": ["error", { ignoreRestArgs: true }],
			"@typescript-eslint/ban-ts-comment": "off",
			"no-prototype-builtins": "off",
			"@typescript-eslint/no-empty-function": "off",
			// Ignore A11y rules (carried over)
			"svelte/valid-compile": "off",
		},
	},
	{
		// Replaces eslint-plugin-deprecation: type-aware deprecation warnings on .ts only
		// (type-aware linting of .svelte files is still fragile; the old config had the same caveat)
		files: ["**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: { "@typescript-eslint/no-deprecated": "warn" },
	},
	{
		files: ["**/*.svelte"],
		languageOptions: {
			parserOptions: {
				parser: tseslint.parser,
				extraFileExtensions: [".svelte"],
			},
		},
	},
);
```

- [ ] **Step 3: Run lint and disposition the fallout**

```bash
bun run lint
```

The `.svelte` files have NEVER been linted, so expect new findings. Disposition rules (strict):

- Config-level problems (parser errors, plugin wiring) → fix the config.
- Pre-existing rule violations in source → do NOT edit source in this task. Add a clearly-marked block to the shared `rules` object:

```javascript
// PRE-EXISTING violations found when svelte linting was first enabled (Phase 2).
// Downgraded to warnings so the gate stays green; burn down separately.
// "<rule-name>": "warn",
```

with one entry per offending rule, and list every downgraded rule + count in your report. `bun run lint` must exit 0 (warnings allowed, errors not).

- [ ] **Step 4: Verify and commit**

```bash
bun run build && bun run test 2>&1 | tail -3 && bun run lint > /dev/null && echo LINT-OK
git add -A eslint.config.js .eslintrc.cjs package.json bun.lock
git commit -m "chore: migrate to eslint 10 flat config, lint svelte files, drop deprecated plugin"
```

---

### Task 4: Drop redundant tooling (prettier, esbuild-jest)

**Files:**

- Modify: `package.json` (remove two devDependencies)
- Modify: `jest.config.cjs` (remove the esbuild-jest transform line)

- [ ] **Step 1: Remove the packages**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun remove prettier esbuild-jest
```

(prettier is unused — dprint is the scripted formatter; esbuild-jest is unmaintained since 2021 and pinned against an esbuild it was never built for.)

- [ ] **Step 2: Remove the js transform from jest.config.cjs**

Delete the line:

```javascript
"^.+\\.(js|jsx)$": "esbuild-jest"
```

(All test files and everything they import from `src/` are `.ts`/`.svelte`; node_modules is never transformed. If the suite fails on an untransformed `.js` file, STOP and report which file — do not reintroduce a transform without approval.)

- [ ] **Step 3: Verify and commit**

```bash
bun run test 2>&1 | tail -3 && bun run build
git add package.json bun.lock jest.config.cjs
git commit -m "chore: drop prettier and esbuild-jest"
```

Expected: 1082/1082.

---

### Task 5: Dependency bumps (jest 30 stack + utility bumps)

**Files:**

- Modify: `package.json`, `bun.lock`

- [ ] **Step 1: Bump the test stack together**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun add -d jest@^30.4.2 jest-environment-jsdom@^30.0.0 ts-jest@^29.4.11 @types/jest@^30.0.0
bun run test 2>&1 | tail -5
```

ts-jest 29.4.11 declares `jest: ^29.0.0 || ^30.0.0` — compatible. If `@types/jest@^30` doesn't exist yet (check `npm view @types/jest version`), keep `@types/jest@^29` and note it. If jest 30 breaks the suite: capture the error, try the smallest config fix (jest 30 renamed some config keys — check its migration notes via the error text), and if not resolvable within the config, revert the test-stack bump, report DONE_WITH_CONCERNS, and leave jest 29 in place (the other bumps below still land).

- [ ] **Step 2: Bump the utilities**

```bash
bun add -d commander@^15.0.0 @types/node@^26.0.0 esbuild@^0.28.0 dprint@^0.55.0
bun run build && bun run test 2>&1 | tail -3
```

commander is used only by `scripts/release/bump-version.ts` — after bumping, run `bun scripts/release/bump-version.ts --help` and confirm it prints usage without error (commander 14+ dropped some legacy APIs). esbuild bump affects `scripts/build/esbuild.config.ts` — the build passing IS the verification. For dprint, verify the binary runs: `bun node_modules/dprint/bin.js --version`.

- [ ] **Step 3: Formatting sanity check**

```bash
bun node_modules/dprint/bin.js check 2>&1 | tail -5
```

dprint 0.55 may format differently than 0.49. If `check` reports diffs: run `bun run format`, inspect `git diff --stat` — if the reformat touches more than ~15 files, commit the version bumps FIRST, then the reformat as its own separate commit (`style: reformat with dprint 0.55`), so the mechanical noise doesn't bury the dependency change.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: bump jest to 30, commander to 15, types/node to 26, esbuild to 0.28, dprint to 0.55"
```

(plus the separate `style:` commit if Step 3 produced one)

---

### Task 6: Consolidate test helpers + tighten jest module mapping

**Files:**

- Create: `tests/helpers.ts`
- Modify: `tests/alter_suggestion.test.ts`, `tests/range_correcter.test.ts`, `tests/range_metadata.test.ts`, `tests/mark_ranges.test.ts` (use the helper)
- Modify: `jest.config.cjs` (moduleNameMapper anchor)

**Interfaces:**

- Produces: `createRangeState(doc: string, settings?: Partial<PluginSettings>): EditorState` in `tests/helpers.ts` — the canonical way Phase 3 tests build parser-ready states.

- [ ] **Step 1: Extract the duplicated state-construction helper**

Read the four test files and identify the duplicated setup (each builds a settings extension via `providePluginSettingsExtension` with overrides and creates an `EditorState` with `rangeParser` + settings field). Create `tests/helpers.ts` exporting exactly one function that covers all four call patterns:

```typescript
import { EditorState } from "@codemirror/state";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import type { PluginSettings } from "../src/types";

// EXPL: rangeParser's StateField requires the plugin-settings extension in the state,
//       and metadata parsing is off in DEFAULT_SETTINGS — tests opt in via overrides.
//       (Established in Phase 0+1; see docs/superpowers/plans/2026-07-11-phase-0-1-execution-notes.md)
export function createRangeState(
	doc: string,
	settings: Partial<PluginSettings> = {},
): EditorState {
	// Adapt the body from the existing duplicated blocks in tests/range_correcter.test.ts —
	// move that code here VERBATIM (including how providePluginSettingsExtension is invoked),
	// parameterizing only doc and the settings overrides. If the four files' setups differ
	// (e.g. one also adds rangeCorrecter or a selection), keep those extras in the test files
	// by having createRangeState accept an optional third param `extra: Extension[] = []`.
	throw new Error("move the real implementation here");
}
```

The comment block above describes intent; the actual body MUST be the moved code from the test files, not a reimplementation. Refactor all four test files to import from `./helpers`. `tests/cursor_movement.test.ts` stays untouched (different, view-based setup).

- [ ] **Step 2: Verify no test regressed**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run test 2>&1 | tail -3
```

Expected: identical counts (1082/1082, 11 snapshots). Snapshot diffs = you changed behavior; revert and retry.

- [ ] **Step 3: Tighten the moduleNameMapper anchor**

```bash
grep -rn "embeddable-editor" src/ tests/ --include="*.ts" | grep -v "__mocks__" | grep "import\|from"
```

Collect the exact import specifiers in use. Replace the mapper key `"embeddable-editor$"` in jest.config.cjs with a pattern anchored to the `ui/` path segment that still matches every real specifier found (e.g. `"ui/embeddable-editor$"` if all specifiers end with `ui/embeddable-editor`). Re-run the suite to prove the stub still applies (if the mapper stops matching, the suite fails to load — instant feedback).

- [ ] **Step 4: Commit**

```bash
bun run build && bun run test 2>&1 | tail -3
git add tests/ jest.config.cjs
git commit -m "test: consolidate state-construction helper, tighten embeddable-editor stub mapping"
```

---

### Task 7: Notice batching for bulk-stale vault edits

**Files:**

- Modify: `src/editor/uix/workspace.ts` (`applyRangeEditsToVault`)

**Interfaces:**

- Consumes: `isEntryStale` and the guard added in Phase 1 (workspace.ts).
- Produces: same function signature; behavior change limited to Notice presentation (one summary instead of one per file).

- [ ] **Step 1: Batch the skip notices**

In `applyRangeEditsToVault`: add `const skipped_paths: string[] = [];` before the loop. Replace the per-file stale Notice + continue block with:

```typescript
if (isEntryStale(file.stat.mtime, plugin.database.getItem(path)?.mtime)) {
	skipped_paths.push(path);
	progressBarUpdate(++idx);
	continue;
}
```

After the loop (next to the conditional history push), add:

```typescript
if (skipped_paths.length === 1) {
	new Notice(
		`Commentator: Skipped "${
			skipped_paths[0]
		}" — the file changed after its annotations were indexed. Wait a moment (or rebuild the database) and try again.`,
		5000,
	);
} else if (skipped_paths.length > 1) {
	new Notice(
		`Commentator: Skipped ${skipped_paths.length} files that changed after their annotations were indexed. Wait a moment (or rebuild the database) and try again.`,
		5000,
	);
}
```

Keep the `progressBarUpdate(++idx)` on the `!file` path as-is. Match the file's 4-space indentation.

- [ ] **Step 2: Verify and commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run build && bun run test 2>&1 | tail -3
git add src/editor/uix/workspace.ts
git commit -m "fix: batch stale-file skip notices into a single summary"
```

(No headless test can drive Notice; tests/workspace_guard.test.ts still covers `isEntryStale`. Note the manual smoke item: bulk-accept right after a bulk edit should show ONE notice.)

---

### Task 8: Generic gutter config factory (remove the plan-mandated cast)

**Files:**

- Modify: `src/editor/renderers/gutters/base.ts` (`createGutterWithConfig` becomes generic)
- Modify: `src/editor/renderers/gutters/annotations-gutter/annotation-gutter.ts` (drop the `as` cast)

- [ ] **Step 1: Make the factory generic**

In base.ts, change `createGutterWithConfig`'s signature (body stays identical):

```typescript
export function createGutterWithConfig<C extends GutterConfig>(
	viewplugin: ViewPlugin<GutterView>,
	config: C,
	activeGutters: Facet<Required<C>>,
	unfixGutters: Facet<boolean, boolean>,
): { extension: Extension; config: Required<C> } {
	const merged = { ...defaults, ...config } as Required<C>;
	return {
		extension: [
			createGutterExtension(viewplugin, {}, unfixGutters),
			activeGutters.of(merged),
		],
		config: merged,
	};
}
```

Check `createGutter` (the non-generic wrapper above it) still compiles — it instantiates `C = GutterConfig`. If the `activeGutters` facet parameter's variance causes an error at either call site, report the exact tsc output rather than adding casts.

- [ ] **Step 2: Drop the cast in annotation-gutter.ts**

```typescript
export function annotation_gutter(
	config: AnnotationGutterConfig,
): { extension: Extension; config: Required<AnnotationGutterConfig> } {
	return createGutterWithConfig(
		annotationGutterView,
		config,
		activeGutters,
		unfixGutters,
	);
}
```

(`activeGutters` in this file is already `Facet<Required<AnnotationGutterConfig>>`, so `C` infers to `AnnotationGutterConfig` with no cast.)

- [ ] **Step 3: Verify and commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run build && bun run test 2>&1 | tail -3
git add src/editor/renderers/gutters/base.ts src/editor/renderers/gutters/annotations-gutter/annotation-gutter.ts
git commit -m "refactor: make gutter config factory generic, drop assertion cast"
```

---

### Task 9: Phase completion check

- [ ] **Step 1: Full gate from clean state**

```bash
export PATH="$HOME/.bun/bin:$PATH"
rm -rf node_modules && bun install && bun run build && bun run test 2>&1 | tail -3 && bun run lint > /dev/null && echo LINT-OK && bun node_modules/dprint/bin.js check 2>&1 | tail -2
```

Expected: everything green from scratch (submodule-free clone equivalence: also verify `git submodule status` outputs nothing).

- [ ] **Step 2: Update execution notes**

Append a `## Phase 2 outcomes` section to `docs/superpowers/plans/2026-07-11-phase-0-1-execution-notes.md`: final versions landed, any lint rules downgraded to `warn` in Task 3 (the burn-down list), whether jest 30 landed or was reverted, and any deviations. Commit:

```bash
git add docs/superpowers/plans/2026-07-11-phase-0-1-execution-notes.md
git commit -m "docs: record phase 2 outcomes"
```
