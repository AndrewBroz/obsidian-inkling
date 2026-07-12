# Phase 3B: Comment Mode + Frontmatter-Enforced Modes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GDocs-style comment-only editing mode and per-document mode enforcement via frontmatter, completing the Word/GDocs-parity feature set.

**Architecture:** `EditMode.COMMENT` joins the enum; a new `commentMode` transaction filter blocks user-initiated document edits outside comment ranges (throttled Notice, never silent) while plugin-internal and annotated comment operations pass. Frontmatter enforcement is a pure resolver (`resolveFrontmatterMode`) plus workspace wiring: file-open/metadata-change events dispatch the resolved mode through the existing `editMode`/`editModeValue` compartments and set a per-editor `enforced` facet that the toggle commands respect.

**Tech Stack:** TypeScript 5.9, CodeMirror 6 (transactionFilter, Compartment/Facet), Obsidian API (metadataCache, workspace events), jest 29.

**Spec:** `docs/superpowers/specs/2026-07-11-repair-and-parity-design.md` sections 3c and 3d.

## Global Constraints

- Toolchain bun (`export PATH="$HOME/.bun/bin:$PATH"`). Gate before every commit: `bun run build`, `bun run test`, `bun run lint` (0 errors), `bun node_modules/dprint/bin.cjs check`. Baseline: 1092/1092 tests.
- dprint-fmt every file you touch.
- Blocked edits MUST produce user feedback (Notice) — no silent failure (spec 3c).
- Precedence (spec 3d, verbatim): **frontmatter > manual per-editor toggle > global default.**
- Existing saved settings must keep working: `markup_focus` is saved per-user and will lack the new COMMENT key — backfill on load (same pattern as `backfillLegacyMetadataFlags`).
- Test conventions: `createRangeState(doc, settings?, extra?)` from tests/helpers.ts; deterministic outputs need `add_metadata: false`; `Notice` is inert in `__mocks__/obsidian.ts`.
- No Vim work; no changes to mark.ts/accept/reject paths.

## Relevant code map

- `src/types.ts:13-17` — `enum EditMode { OFF = 0, CORRECTED = 1, SUGGEST = 2 }`. Values are persisted numbers; append `COMMENT = 3`, never reorder.
- `src/editor/uix/extensions/editing-modes/index.ts` — `getEditMode(edit_mode, settings): Extension[]` dispatches per mode; add the COMMENT branch here.
- `src/editor/settings/index.ts` — the Compartment/Facet pattern (`editModeValueState`/`editModeValue`/`editMode`, `attachValue` helper). Add `editModeEnforcedState`/`editModeEnforced` here following the same pattern.
- `src/editor/uix/commands.ts` (~line 167) — "Toggle suggestion mode" shows the exact reconfigure-dispatch pattern for mode changes (`editModeValue.reconfigure` + `editMode.reconfigure` + `plugin.setEditMode(view, mode)`).
- `src/main.ts` `setEditMode(view, mode)` (~line 512) — reconfigures both compartments and updates the status-bar + header buttons.
- Mode UI states are arrays indexed by EditMode value: `src/editor/status-bar/index.ts:24-26` (`{icon, text}`) and the header-button equivalent (grep `"Suggesting"` — both files carry a 3-entry edit-mode array). The buttons cycle `(value + 1) % states.length`, so appending a 4th entry automatically joins the cycle.
- `src/constants.ts` `markup_focus` (~line 20) — exhaustive `Record<EditMode, …>`; tsc fails on the enum growth until a COMMENT entry is added.
- `src/ui/pages/settings/tabs/GeneralSettings.svelte:40` — default-edit-mode dropdown options list.
- `src/editor/base/edit-logic/add-comment.ts` — both dispatch sites (wrap path + cursor path) need the comment-op annotation.
- Comment range content span: `range.range_start` (post-metadata) to `range.to - 3` (base_range.ts).
- `migrateSettings` in src/main.ts is the real settings-load path (loadSettings is dead code — do not touch it).

---

### Task 1: EditMode.COMMENT + the comment-mode transaction filter

**Files:**

- Modify: `src/types.ts` (enum)
- Modify: `src/constants.ts` (markup_focus COMMENT entry + backfill helper)
- Modify: `src/main.ts` (`migrateSettings`: markup_focus backfill call)
- Create: `src/editor/uix/extensions/editing-modes/comment-mode.ts`
- Modify: `src/editor/uix/extensions/editing-modes/index.ts` (dispatch + re-export)
- Modify: `src/editor/base/edit-logic/add-comment.ts` (annotate both dispatches)
- Test: `tests/comment_mode.test.ts` (create)

**Interfaces:**

- Produces: `EditMode.COMMENT = 3`; `commentMode(settings: PluginSettings): Extension`; `commentModeAnnotation: Annotation<boolean>` (exported from comment-mode.ts and re-exported via the editing-modes barrel); `backfillMarkupFocus(settings: PluginSettings): void` in constants.ts.
- Consumes: `rangeParser`, `SuggestionType`, comment content-span accessors.

- [ ] **Step 1: Write the failing tests**

Create `tests/comment_mode.test.ts`:

```typescript
import { EditorState } from "@codemirror/state";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import {
	commentMode,
	commentModeAnnotation,
} from "../src/editor/uix/extensions/editing-modes/comment-mode";
import { createRangeState } from "./helpers";

const NO_META = { add_metadata: false };

function commentModeState(doc: string): EditorState {
	return createRangeState(doc, NO_META, [
		commentMode({ ...DEFAULT_SETTINGS, add_metadata: false }),
	]);
}

describe("comment mode blocks document edits", () => {
	test("typing in plain text is filtered out", () => {
		const state = commentModeState("hello world");
		const tr = state.update({
			changes: { from: 5, to: 5, insert: "X" },
			userEvent: "input",
		});
		expect(tr.state.doc.toString()).toBe("hello world");
	});

	test("deleting document text is filtered out", () => {
		const state = commentModeState("hello world");
		const tr = state.update({
			changes: { from: 0, to: 5, insert: "" },
			userEvent: "delete",
		});
		expect(tr.state.doc.toString()).toBe("hello world");
	});

	test("typing inside a comment's content is allowed", () => {
		const doc = "hello {>>note<<} world";
		const state = commentModeState(doc);
		// position inside "note": after "{>>" (7..10 is "not"...) — compute from the doc
		const inside = doc.indexOf("note") + 2;
		const tr = state.update({
			changes: { from: inside, to: inside, insert: "X" },
			userEvent: "input",
		});
		expect(tr.state.doc.toString()).toBe("hello {>>noXte<<} world");
	});

	test("an annotated comment operation is allowed anywhere", () => {
		const state = commentModeState("hello world");
		const tr = state.update({
			changes: { from: 5, to: 5, insert: "{>><<}" },
			userEvent: "input",
			annotations: [commentModeAnnotation.of(true)],
		});
		expect(tr.state.doc.toString()).toBe("hello{>><<} world");
	});

	test("non-user-event (programmatic) transactions pass through", () => {
		const state = commentModeState("hello world");
		const tr = state.update({
			changes: { from: 0, to: 5, insert: "HELLO" },
		});
		expect(tr.state.doc.toString()).toBe("HELLO world");
	});

	test("an edit spanning from a comment into document text is blocked", () => {
		const doc = "hello {>>note<<} world";
		const state = commentModeState(doc);
		const inside = doc.indexOf("note");
		const tr = state.update({
			changes: { from: inside, to: doc.length, insert: "" },
			userEvent: "delete",
		});
		expect(tr.state.doc.toString()).toBe(doc);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- tests/comment_mode.test.ts`
Expected: FAIL at import — `comment-mode.ts` does not exist.

- [ ] **Step 3: Implement**

1. `src/types.ts` — append to the enum:

```typescript
export enum EditMode {
	OFF = 0,
	CORRECTED = 1,
	SUGGEST = 2,
	COMMENT = 3,
}
```

2. `src/constants.ts` — add to `markup_focus` (after the SUGGEST entry):

```typescript
[EditMode.COMMENT]: {
	show_styling: true,
	show_syntax: false,
	show_metadata: false,
	focus_annotation: true,
	show_comment: true,
},
```

and add next to `backfillLegacyMetadataFlags`:

```typescript
/**
 * EXPL: EditMode.COMMENT (Phase 3B) added a markup_focus entry; settings saved before it
 *       exists lack the key and would leave renderers reading undefined for COMMENT mode.
 */
export function backfillMarkupFocus(settings: PluginSettings): void {
	if (!settings.markup_focus[EditMode.COMMENT]) {
		settings.markup_focus[EditMode.COMMENT] =
			DEFAULT_SETTINGS.markup_focus[EditMode.COMMENT];
	}
}
```

(Import EditMode if not already; check `markup_focus`'s type in types.ts — if it's an exhaustive mapped type, the entry addition satisfies tsc; the backfill covers saved data.)

3. `src/main.ts` `migrateSettings` — directly after the `backfillLegacyMetadataFlags(...)` call, add `backfillMarkupFocus(this.settings);` (import it alongside).

4. Create `src/editor/uix/extensions/editing-modes/comment-mode.ts`:

```typescript
import { Annotation, EditorState, type Extension } from "@codemirror/state";
import { Notice } from "obsidian";

import { type PluginSettings } from "../../../../types";
import { rangeParser, SuggestionType } from "../../../base";

/** Marks a transaction as a Commentator comment operation, exempt from comment-mode blocking. */
export const commentModeAnnotation = Annotation.define<boolean>();

// EXPL: One Notice per burst of blocked keystrokes, not one per keypress
let last_block_notice = 0;

export const commentMode = (settings: PluginSettings): Extension =>
	EditorState.transactionFilter.of(tr => {
		if (!tr.docChanged)
			return tr;
		if (tr.annotation(commentModeAnnotation))
			return tr;
		// EXPL: Only gate direct user edits; programmatic transactions (accept/reject from the
		//       gutter, comment-widget submissions, undo of allowed edits) pass through
		if (
			!(tr.isUserEvent("input") || tr.isUserEvent("delete") ||
				tr.isUserEvent("paste") || tr.isUserEvent("move"))
		) {
			return tr;
		}

		const ranges = tr.startState.field(rangeParser).ranges;
		let allowed = true;
		tr.changes.iterChangedRanges((fromA, toA) => {
			const range = ranges.at_cursor(fromA);
			// EXPL: The whole changed region must sit inside ONE comment range's content span
			if (
				!(range && range.type === SuggestionType.COMMENT &&
					range.range_start <= fromA && toA <= range.to - 3)
			) {
				allowed = false;
			}
		});
		if (allowed)
			return tr;

		if (Date.now() - last_block_notice > 2000) {
			last_block_notice = Date.now();
			new Notice(
				"Commentator: comment mode — text edits are disabled; add or edit comments instead.",
				3000,
			);
		}
		return [];
	});
```

5. `src/editor/uix/extensions/editing-modes/index.ts` — add the branch and re-export:

```typescript
else if (edit_mode === EditMode.COMMENT)
	return [commentMode(settings)];
```

(within `getEditMode`, before the final `return []`; import from `./comment-mode` and add `export * from "./comment-mode";`.)

6. `src/editor/base/edit-logic/add-comment.ts` — add `commentModeAnnotation.of(true)` to the `annotations` of BOTH document-changing dispatches (the wrap path and the cursor path). The `update(...)` specs currently have no `annotations` key on the change dispatches — add e.g.:

```typescript
annotations: [commentModeAnnotation.of(true)],
```

Import via the editing-modes barrel (`../../uix/extensions/editing-modes`) — CHECK for import cycles first (add-comment.ts is in base/, the annotation lives in uix/): if importing uix from base creates a cycle (base barrel is imported by uix), move `commentModeAnnotation` into `src/editor/base/edit-util/transaction-util.ts` (which already exists) instead, and have comment-mode.ts import it from base — that direction is already used. Decide by checking imports; report which home it got.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- tests/comment_mode.test.ts` → 6/6 PASS. Then the full suite (expect 1098/1098).

- [ ] **Step 5: Full gate and commit**

```bash
bun run build && bun run test 2>&1 | tail -3 && bun run lint > /dev/null && bun node_modules/dprint/bin.cjs check
git add src/types.ts src/constants.ts src/main.ts src/editor/uix/extensions/editing-modes/ src/editor/base/edit-logic/add-comment.ts tests/comment_mode.test.ts
git commit -m "feat: add comment-only edit mode blocking document edits outside comments"
```

(Adjust the `git add` list if the annotation landed in transaction-util.ts.)

---

### Task 2: Comment mode UI — toggle command, mode cycle, settings dropdown

**Files:**

- Modify: `src/editor/uix/commands.ts` (new "Toggle comment mode" command)
- Modify: `src/editor/status-bar/index.ts` (append 4th edit-mode state)
- Modify: the header-button edit-mode states array (grep `"Suggesting"` under src/editor/view-header/ — same shape `{icon, tooltip?, text}`)
- Modify: `src/ui/pages/settings/tabs/GeneralSettings.svelte` (default-mode dropdown option)
- Modify: `README.md` (check off "Toggling comment mode on/off in editor")

**Interfaces:**

- Consumes: `EditMode.COMMENT`, `getEditMode` (Task 1); the reconfigure-dispatch pattern from "Toggle suggestion mode" (commands.ts ~167).

- [ ] **Step 1: Add the toggle command**

In `src/editor/uix/commands.ts`, directly after the "Toggle suggestion mode" command object, add:

```typescript
{
	id: "toggle-comment-mode",
	name: "Toggle comment mode",
	icon: "message-square",
	editor_context: true,
	regular_callback: (editor: Editor, view: MarkdownView) => {
		const current_value = editor.cm.state.facet(editModeValueState);
		const resulting_mode = current_value === EditMode.COMMENT ? EditMode.CORRECTED : EditMode.COMMENT;
		editor.cm.dispatch(editor.cm.state.update({
			effects: [
				editModeValue.reconfigure(editModeValueState.of(resulting_mode)),
				editMode.reconfigure(getEditMode(resulting_mode, plugin.settings)),
			],
		}));
		plugin.setEditMode(view, resulting_mode);
	},
},
```

(Mirror the exact `id:` presence/absence and callback shape of the suggestion toggle as it exists in the file — if the suggestion toggle has no `id` field, omit it here too. The enforcement lock is added in Task 3.)

- [ ] **Step 2: Extend both mode-state arrays**

`src/editor/status-bar/index.ts` — append after `{ icon: "file-edit", text: "Suggesting" }`:

```typescript
{ icon: "message-square", text: "Commenting" },
```

Header button: locate the parallel edit-mode array (it has entries with tooltips like the status bar's texts) and append the equivalent entry with `icon: "message-square"`, tooltip/text "Commenting" — match that array's exact field names. The cycle logic (`(value + 1) % states.length`) picks it up automatically.

- [ ] **Step 3: Settings dropdown**

`src/ui/pages/settings/tabs/GeneralSettings.svelte` (~line 40), after the Suggestion Mode option:

```typescript
{ value: EditMode.COMMENT.toString(), text: "Comment Mode" },
```

- [ ] **Step 4: README checkbox**

Change `- [ ] Toggling comment mode on/off in editor` to `- [x] Toggling comment mode on/off in editor`.

- [ ] **Step 5: Full gate and commit**

No new unit tests (UI wiring — command callbacks and Svelte options aren't headless-testable here); the gate is build + suite + manual smoke note.

```bash
bun run build && bun run test 2>&1 | tail -3 && bun run lint > /dev/null && bun node_modules/dprint/bin.cjs check
git add src/editor/uix/commands.ts src/editor/status-bar/index.ts src/editor/view-header/ src/ui/pages/settings/tabs/GeneralSettings.svelte README.md
git commit -m "feat: comment mode toggle command, mode-cycle entry, and default-mode option"
```

Manual smoke note for the report: command palette "Toggle comment mode" blocks typing with the Notice, allows comment edits; status-bar and header buttons cycle through 4 modes; Settings shows "Comment Mode" as a default option.

---

### Task 3: Frontmatter-enforced modes

**Files:**

- Create: `src/editor/uix/frontmatter-mode.ts` (pure resolver)
- Modify: `src/editor/settings/index.ts` (`editModeEnforcedState` facet + `editModeEnforced` compartment)
- Modify: `src/main.ts` (extension registration, event wiring, `setEditMode` enforced param)
- Modify: `src/editor/uix/commands.ts` (lock BOTH mode toggles while enforced)
- Modify: `README.md` (check off the frontmatter roadmap item + usage snippet)
- Test: `tests/frontmatter_mode.test.ts` (create)

**Interfaces:**

- Produces: `resolveFrontmatterMode(frontmatter: Record<string, unknown> | undefined, author: string): EditMode | null`; `FRONTMATTER_MODE_KEY = "commentator"`; `FRONTMATTER_AUTHORS_KEY = "commentator-authors"`; `editModeEnforcedState: Facet<boolean, boolean>`, `editModeEnforced: Compartment`.
- Consumes: `EditMode` (incl. COMMENT), `setEditMode`, metadataCache/workspace events.

- [ ] **Step 1: Write the failing resolver tests**

Create `tests/frontmatter_mode.test.ts`:

```typescript
import { resolveFrontmatterMode } from "../src/editor/uix/frontmatter-mode";
import { EditMode } from "../src/types";

describe("resolveFrontmatterMode", () => {
	test("maps the three mode strings, case-insensitively", () => {
		expect(resolveFrontmatterMode({ commentator: "suggest" }, "")).toBe(
			EditMode.SUGGEST,
		);
		expect(resolveFrontmatterMode({ commentator: "Comment" }, "")).toBe(
			EditMode.COMMENT,
		);
		expect(resolveFrontmatterMode({ commentator: "off" }, "")).toBe(
			EditMode.OFF,
		);
	});

	test("absent or invalid values yield null (no enforcement)", () => {
		expect(resolveFrontmatterMode(undefined, "")).toBeNull();
		expect(resolveFrontmatterMode({}, "")).toBeNull();
		expect(resolveFrontmatterMode({ commentator: "banana" }, "")).toBeNull();
		expect(resolveFrontmatterMode({ commentator: 3 }, "")).toBeNull();
	});

	test("authors list exempts listed authors, enforces for others", () => {
		const fm = {
			"commentator": "suggest",
			"commentator-authors": ["Alice", "Bob"],
		};
		expect(resolveFrontmatterMode(fm, "Alice")).toBeNull();
		expect(resolveFrontmatterMode(fm, "Mallory")).toBe(EditMode.SUGGEST);
	});

	test("empty local author is never exempted by an authors list", () => {
		const fm = { "commentator": "comment", "commentator-authors": ["Alice"] };
		expect(resolveFrontmatterMode(fm, "")).toBe(EditMode.COMMENT);
	});

	test("malformed authors list is ignored (mode still enforced)", () => {
		expect(
			resolveFrontmatterMode({
				"commentator": "off",
				"commentator-authors": "Alice",
			}, "Alice"),
		).toBe(EditMode.OFF);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test -- tests/frontmatter_mode.test.ts`
Expected: FAIL at import — module does not exist.

- [ ] **Step 3: Implement the resolver**

Create `src/editor/uix/frontmatter-mode.ts`:

```typescript
import { EditMode } from "../../types";

export const FRONTMATTER_MODE_KEY = "commentator";
export const FRONTMATTER_AUTHORS_KEY = "commentator-authors";

const MODE_NAMES: Record<string, EditMode> = {
	suggest: EditMode.SUGGEST,
	comment: EditMode.COMMENT,
	off: EditMode.OFF,
};

/**
 * Resolve a note's enforced edit mode from its frontmatter.
 * `commentator: suggest | comment | off` enforces that mode; the optional
 * `commentator-authors: [...]` list EXEMPTS the named authors (the note's owners
 * write freely; everyone else is held to the declared mode).
 * Returns null when nothing is enforced for this user.
 */
export function resolveFrontmatterMode(
	frontmatter: Record<string, unknown> | undefined,
	author: string,
): EditMode | null {
	if (!frontmatter)
		return null;
	const raw = frontmatter[FRONTMATTER_MODE_KEY];
	if (typeof raw !== "string")
		return null;
	const mode = MODE_NAMES[raw.toLowerCase()];
	if (mode === undefined)
		return null;
	const authors = frontmatter[FRONTMATTER_AUTHORS_KEY];
	if (Array.isArray(authors) && author && authors.map(String).includes(author))
		return null;
	return mode;
}
```

- [ ] **Step 4: Resolver GREEN**

Run: `bun run test -- tests/frontmatter_mode.test.ts` → 5/5 PASS.

- [ ] **Step 5: Enforcement plumbing**

1. `src/editor/settings/index.ts` — after the editMode compartments:

```typescript
export const editModeEnforcedState = Facet.define<boolean, boolean>({
	combine: values => values[0],
});
export const editModeEnforced = new Compartment();
```

2. `src/main.ts` `loadEditorExtensions()` — next to the `editModeValue.of(...)` push:

```typescript
this.editorExtensions.push(
	editModeEnforced.of(editModeEnforcedState.of(false)),
);
```

3. `src/main.ts` `setEditMode` — extend the signature to `setEditMode(view: MarkdownFileInfo | null, mode: number, enforced: boolean = false)`, add an enforcement guard at the top of the method (CRITICAL: the status-bar and header buttons cycle modes through `setEditMode` directly, bypassing any command-level check — this guard is what locks them):

```typescript
if (
	view && view.editor && !enforced &&
	view.editor.cm.state.facet(editModeEnforcedState)
) {
	new Notice(
		"Commentator: the edit mode is enforced by this note's frontmatter and cannot be changed here.",
		4000,
	);
	return;
}
```

and add to the same dispatch's effects:

```typescript
editModeEnforced.reconfigure(editModeEnforcedState.of(enforced)),
```

(Existing callers pass two args — default keeps them unenforced. The guard makes an enforcement-lift possible only via `applyFrontmatterMode`, which passes `enforced` explicitly on both paths.)
Note: `applyFrontmatterMode`'s restore call (`this.setEditMode(view, this.settings.default_edit_mode, false)`) would hit this guard (facet still true, enforced=false) — restore must bypass it. Give the guard an escape: change the restore call to dispatch the un-enforcement FIRST, or simpler, add a private helper the guard doesn't apply to. Cleanest: make `applyFrontmatterMode`'s restore path call `this.setEditMode(view, this.settings.default_edit_mode, false)` AFTER dispatching `editModeEnforced.reconfigure(editModeEnforcedState.of(false))` on the editor directly:

```typescript
else if (currently_enforced) {
	// EXPL: lift enforcement first so the setEditMode guard lets the restore through
	view.editor.cm.dispatch(view.editor.cm.state.update({
		effects: [editModeEnforced.reconfigure(editModeEnforcedState.of(false))],
	}));
	this.setEditMode(view, this.settings.default_edit_mode, false);
}
```

(Adjust `applyFrontmatterMode` in step 4 accordingly.)
4. `src/main.ts` `onload` — register the two events (after the header/status-bar setup):

```typescript
this.registerEvent(this.app.workspace.on("file-open", (file) => {
	if (file) this.applyFrontmatterMode(file);
}));
this.registerEvent(this.app.metadataCache.on("changed", (file) => {
	if (file === this.app.workspace.getActiveFile())
		this.applyFrontmatterMode(file);
}));
```

and add the method:

```typescript
applyFrontmatterMode(file: TFile) {
	const view = this.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view || view.file !== file || !view.editor)
		return;
	const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
	const enforced_mode = resolveFrontmatterMode(frontmatter, this.settings.author);
	const currently_enforced = view.editor.cm.state.facet(editModeEnforcedState);
	if (enforced_mode !== null)
		this.setEditMode(view, enforced_mode, true);
	else if (currently_enforced)
		// EXPL: enforcement was lifted (frontmatter edited/removed) — restore the default
		this.setEditMode(view, this.settings.default_edit_mode, false);
}
```

(Imports: `resolveFrontmatterMode`, `editModeEnforcedState`, `TFile`, `MarkdownView` — check what main.ts already imports. Verify the actual name of the default-mode setting — grep `default_edit_mode` in constants.ts; if it differs, use the real key.)
5. `src/editor/uix/commands.ts` — at the TOP of both toggle callbacks ("Toggle suggestion mode" and "Toggle comment mode"):

```typescript
if (editor.cm.state.facet(editModeEnforcedState)) {
	new Notice(
		"Commentator: the edit mode is enforced by this note's frontmatter and cannot be changed here.",
		4000,
	);
	return;
}
```

(Import `editModeEnforcedState` alongside the other settings imports and `Notice` from obsidian if not present.)

- [ ] **Step 6: README**

Check off `- [ ] Specify suggestion/comment-only mode in frontmatter (based on authorship)` and add a short usage block at the end of the Syntax section (or a new "### Frontmatter" section):

````markdown
### Frontmatter

Enforce an editing mode for a note via frontmatter (overrides the per-editor toggle):

```yaml
---
commentator: suggest   # or: comment, off
commentator-authors: [Alice]   # optional: these authors are exempt from enforcement
---
```
````

- [ ] **Step 7: Full gate and commit**

```bash
bun run build && bun run test 2>&1 | tail -3 && bun run lint > /dev/null && bun node_modules/dprint/bin.cjs check
git add src/editor/uix/frontmatter-mode.ts src/editor/settings/index.ts src/main.ts src/editor/uix/commands.ts tests/frontmatter_mode.test.ts README.md
git commit -m "feat: enforce per-note edit modes from frontmatter with author exemptions"
```

Manual smoke note for the report: note with `commentator: comment` → opens in comment mode, toggles show the lock Notice; removing the key restores the default mode; `commentator-authors` containing your author name exempts you.

---

### Task 4: Phase 3B completion check

- [ ] **Step 1: Clean-state full gate**

```bash
export PATH="$HOME/.bun/bin:$PATH"
rm -rf node_modules && bun install && bun run build && bun run test 2>&1 | tail -3 && bun run lint > /dev/null && echo LINT-OK && bun node_modules/dprint/bin.cjs check && echo DPRINT-OK
```

- [ ] **Step 2: Update execution notes and commit**

Append `## Phase 3B outcomes` to `docs/superpowers/plans/2026-07-11-phase-0-1-execution-notes.md`: comment mode semantics (what's gated vs passes), the annotation's home, frontmatter keys + precedence + exemption semantics, markup_focus backfill, and the accumulated manual smoke checklist items from Tasks 2-3. dprint-fmt the file.

```bash
git add docs/superpowers/plans/2026-07-11-phase-0-1-execution-notes.md
git commit -m "docs: record phase 3b outcomes"
```
