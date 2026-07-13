# PR3: Comment threads with an inline reply box Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Click a thread card in the annotations gutter to get a reply box beneath it (Enter submits, Shift+Enter newlines, Escape/empty-blur dismisses) — including on suggestion cards, which gives comments-on-suggestions — and make new-comment creation *draft-then-insert* so abandoned comments never reach the note.

**Architecture:** The **data model needs no changes.** Threads already parse (`{==anchor==}{>>a<<}{>>b<<}`), `base_range.replies` / `full_thread` are already populated, and the parser's grouping rule (`range-parser.ts:49-54`) is already type-agnostic on the base — so `{++added++}{>>a<<}` is already a legal thread. This PR is entirely UI plus write-path.

Two write paths are added to `add-comment.ts` (`commitReply`, `commitCommentDraft`), each producing exactly **one** transaction from text already in hand. A new `commentDraftField` `StateField` holds a pending comment's `{from, to}` — nothing is written to the note until submit. The gutter renders a provisional card for that draft by joining a second `RangeSet` into its `markers` accessor (which already accepts an array). This deletes the `setTimeout`-focus hack and its `FIXME` in `addCommentToView`.

**Tech Stack:** TypeScript, CodeMirror 6 (`StateField`, `StateEffect`, `RangeSet`, `GutterMarker`), Obsidian (`Component`, `EmbeddableMarkdownEditor`), Jest + jsdom, SCSS.

## Global Constraints

- Source in `src/`, tests in `tests/`. Runner: `bun test`. Type-check: `bun run tsc -noEmit -skipLibCheck`. Lint: `bun eslint src/`. Format: `bun dprint fmt` (tabs).
- **Never hand-edit the repo-root `styles.css` or `main.js`** — both are build artefacts.
- Every comment write must carry `commentModeAnnotation.of(true)`, or the editing-mode guards will reject it when the user is in Comment mode. Copy this from the existing dispatches in `add-comment.ts`.
- Comments explain *why*, not *what* — match the `// EXPL:` convention.
- Metadata (author/timestamp) is applied by `create_range(settings, type, text)`; never hand-assemble `{>>…<<}` strings.

## Interaction contract (fixed; do not re-derive)

| Gesture | Behaviour |
| --- | --- |
| Click a gutter thread card | Reply box appears beneath the last entry, focused |
| **Enter** | Submit the reply |
| **Shift+Enter** | Newline inside the reply |
| **Escape** | Dismiss the box |
| Blur while **empty** | Dismiss the box |
| Blur while **non-empty** | **Leave the box open** — never write on blur |

## File Structure

- `src/editor/base/edit-logic/add-comment.ts` — *modify.* Add `commitReply` and `commitCommentDraft`; rewrite the selection path of `addCommentToView` to dispatch a draft. *(Owns every comment write path.)*
- `src/editor/uix/extensions/comment-draft.ts` — **create.** `commentDraftField`, `setCommentDraft` / `clearCommentDraft` effects. *(Owns pending-draft state; no DOM.)*
- `src/editor/uix/extensions/index.ts` — *modify.* Re-export the above.
- `src/main.ts:156` — *modify.* Register `commentDraftField`.
- `src/editor/renderers/gutters/annotations-gutter/reply-box.ts` — **create.** `ReplyBox`, an Obsidian `Component` wrapping an `EmbeddableMarkdownEditor`. *(Owns the box's DOM + key handling; shared by real cards and the provisional card.)*
- `src/editor/renderers/gutters/annotations-gutter/marker.ts` — *modify.* Mount a `ReplyBox` on click.
- `src/editor/renderers/gutters/annotations-gutter/pending-marker.ts` — **create.** `PendingAnnotationMarker`, the provisional card. *(Owns the not-yet-in-the-document card.)*
- `src/editor/renderers/gutters/annotations-gutter/index.ts:36` — *modify.* Join the pending `RangeSet` into `markers`.
- `src/editor/uix/extensions/comment-pill.ts` — *modify.* Hide the pill while a draft is open.
- `src/assets/annotation-gutter.scss` — *modify.* Style the reply box and provisional card.

---

### Task 1: Reply box on existing thread cards

Delivers the whole "reply to a thread, comment on a suggestion" feature on its own. Shippable without Tasks 2–4.

**Files:**
- Modify: `src/editor/base/edit-logic/add-comment.ts`
- Create: `src/editor/renderers/gutters/annotations-gutter/reply-box.ts`
- Modify: `src/editor/renderers/gutters/annotations-gutter/marker.ts:430-517` (`onCommentThreadClick`, `toDOM`, `destroy`)
- Test: `tests/comment_reply.test.ts` (create)

**Interfaces:**
- Consumes: `create_range(settings, SuggestionType.COMMENT, text): string`, `pluginSettingsField`, `commentModeAnnotation`, `CriticMarkupRange.base_range`, `CriticMarkupRange.full_range_back` — all already exported from `src/editor/base` / `src/editor/uix`.
- Produces:
  - `export function commitReply(view: EditorView, range: CriticMarkupRange, text: string): boolean` — inserts one comment at the end of `range`'s thread; returns `false` (and writes nothing) for blank text.
  - `export class ReplyBox extends Component` with constructor `(app: App, container: HTMLElement, opts: { placeholder: string; onCommit: (text: string) => boolean; onDismiss: () => void })` and method `focus(): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/comment_reply.test.ts`:

```ts
import { EditorView } from "@codemirror/view";

import { rangeParser, SuggestionType } from "../src/editor/base";
import { commitReply } from "../src/editor/base/edit-logic/add-comment";
import { createRangeState } from "./helpers";

// EXPL: add_metadata false keeps outputs deterministic (no timestamps in the markup)
const NO_META = { add_metadata: false };

function viewWith(doc: string) {
	return new EditorView({ state: createRangeState(doc, NO_META) });
}

function baseRange(view: EditorView) {
	return view.state.field(rangeParser).ranges.ranges[0];
}

describe("commitReply", () => {
	test("appends a comment to the end of an existing comment thread", () => {
		const view = viewWith("{==hello==}{>>first<<} world");
		expect(commitReply(view, baseRange(view), "second")).toBe(true);
		expect(view.state.doc.toString()).toBe("{==hello==}{>>first<<}{>>second<<} world");

		const base = baseRange(view);
		expect(base.type).toBe(SuggestionType.HIGHLIGHT);
		expect(base.replies).toHaveLength(2);
		expect(base.replies[1].unwrap()).toBe("second");
	});

	// EXPL: The whole point of "comments on suggestions". The parser's grouping rule is already
	//       type-agnostic on the base (range-parser.ts:49-54), so an addition takes a thread the
	//       same way a highlight does — this test pins that the write path does not special-case
	//       comment/highlight bases and quietly refuse suggestions.
	test("starts a thread on an addition (comments on suggestions)", () => {
		const view = viewWith("a {++new++} b");
		expect(commitReply(view, baseRange(view), "why?")).toBe(true);
		expect(view.state.doc.toString()).toBe("a {++new++}{>>why?<<} b");
		expect(baseRange(view).replies).toHaveLength(1);
	});

	test("starts a thread on a deletion", () => {
		const view = viewWith("a {--old--} b");
		expect(commitReply(view, baseRange(view), "why?")).toBe(true);
		expect(view.state.doc.toString()).toBe("a {--old--}{>>why?<<} b");
	});

	// EXPL: Replying to a REPLY must retarget the thread's base, not nest — threads are flat
	//       (comment_range.ts:35-43). Appending at the reply's own `to` would be identical here by
	//       luck; using base_range.full_range_back is what keeps it correct for a mid-thread reply.
	test("replying to a reply appends to the thread's base, not to the reply", () => {
		const view = viewWith("{==hi==}{>>one<<}{>>two<<}");
		const reply = view.state.field(rangeParser).ranges.ranges[1];
		expect(commitReply(view, reply, "three")).toBe(true);
		expect(view.state.doc.toString()).toBe("{==hi==}{>>one<<}{>>two<<}{>>three<<}");
		expect(baseRange(view).replies).toHaveLength(3);
	});

	test("blank text writes nothing and reports failure", () => {
		const view = viewWith("{==hello==}{>>first<<}");
		const before = view.state.doc.toString();
		expect(commitReply(view, baseRange(view), "   \n ")).toBe(false);
		expect(view.state.doc.toString()).toBe(before);
	});
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test tests/comment_reply.test.ts`
Expected: FAIL — `commitReply` is not exported from `add-comment.ts`.

- [ ] **Step 3: Implement `commitReply`**

In `src/editor/base/edit-logic/add-comment.ts`, add below the existing `addCommentToView`:

```ts
/**
 * Append a comment to the end of `range`'s thread, in ONE transaction, from text already in hand.
 *
 * EXPL: Always targets `base_range.full_range_back`, never the passed range's own `to` — threads
 *       are flat (comment_range.ts:35-43), so replying to a mid-thread reply must still land at
 *       the END of the thread. Works for every base type: the parser's adjacency rule is
 *       type-agnostic, which is what makes "comment on a suggestion" fall out for free.
 * @returns false (writing nothing) if the text is blank.
 */
export function commitReply(editor: EditorView, range: CriticMarkupRange, text: string): boolean {
	if (!text.trim())
		return false;

	const settings = editor.state.field(pluginSettingsField);
	const cursor = range.base_range.full_range_back;

	editor.dispatch(editor.state.update({
		changes: { from: cursor, to: cursor, insert: create_range(settings, SuggestionType.COMMENT, text) },
		annotations: [commentModeAnnotation.of(true)],
	}));
	return true;
}
```

All imports it needs (`EditorView`, `CriticMarkupRange`, `SuggestionType`, `create_range`, `pluginSettingsField`, `commentModeAnnotation`) are **already imported at the top of this file** — add none.

- [ ] **Step 4: Run the test and verify it passes**

Run: `bun test tests/comment_reply.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit the write path**

```bash
git add src/editor/base/edit-logic/add-comment.ts tests/comment_reply.test.ts
git commit -m "feat: commitReply write path for comment threads

One transaction, text already in hand, always appended at the thread
base's full_range_back so a reply to a mid-thread reply still lands at
the end (threads are flat). Type-agnostic on the base, so additions,
deletions, and substitutions take comment threads the same way
highlights do."
```

- [ ] **Step 6: Create the `ReplyBox` component**

Create `src/editor/renderers/gutters/annotations-gutter/reply-box.ts`:

```ts
import { type App, Component } from "obsidian";

import { EmbeddableMarkdownEditor } from "../../../../ui/embeddable-editor";

export interface ReplyBoxOptions {
	placeholder: string;
	/** Returns true if the text was accepted and written; false for blank/rejected input. */
	onCommit: (text: string) => boolean;
	onDismiss: () => void;
}

/**
 * The always-one-click-away reply input at the foot of a gutter thread card.
 *
 * EXPL: Enter submits and Shift+Enter newlines, which inverts EmbeddableMarkdownEditor's default
 *       (`onEnter` ships as "Mod+Enter submits, bare Enter newlines" — embeddable-editor.ts:66-70).
 *       Returning true from onEnter means "handled, don't insert a newline"; returning false lets
 *       CodeMirror insert one. That single hook is the whole keybinding — no custom keymap.
 *
 * EXPL: Blur NEVER writes. It dismisses only when the box is empty; a blur with text in it leaves
 *       the box standing, so clicking into the note to check a word cannot silently commit a
 *       half-written reply. This deliberately diverges from AnnotationNode's editor, which saves on
 *       blur — that one is editing text the document already holds, this one is composing text the
 *       document has never seen.
 */
export class ReplyBox extends Component {
	editor: EmbeddableMarkdownEditor | null = null;

	constructor(
		public app: App,
		public container: HTMLElement,
		public options: ReplyBoxOptions,
	) {
		super();
	}

	onload() {
		super.onload();

		this.editor = this.addChild(
			new EmbeddableMarkdownEditor(this.app, this.container, {
				value: "",
				cls: "cmtr-anno-gutter-reply-editor",
				placeholder: this.options.placeholder,
				focus: true,
				filteredExtensions: [this.app.plugins.plugins["inkling"].editorExtensions],

				onEnter: (editor, _mod, shift) => {
					if (shift)
						return false;
					this.options.onCommit(editor.get());
					return true;
				},

				onEscape: () => {
					this.options.onDismiss();
				},

				onBlur: (editor) => {
					if (!editor.get().trim())
						this.options.onDismiss();
				},
			}),
		);
	}

	onunload() {
		super.onunload();
		this.editor = null;
		this.container.remove();
	}

	focus() {
		this.editor?.editor?.cm.focus();
	}
}
```

- [ ] **Step 7: Mount the reply box on thread cards**

In `src/editor/renderers/gutters/annotations-gutter/marker.ts`:

Add to the imports from `../../../base` (the existing block at `:8-22`): `commitReply`.
Add a new import: `import { ReplyBox } from "./reply-box";`

Add a field to `class AnnotationMarker` (alongside `annotation_thread` at `:412`):

```ts
	reply_box: ReplyBox | null = null;
```

Add this method to `AnnotationMarker`:

```ts
	// EXPL: Google-Docs behaviour — focusing a thread reveals its reply input. Idempotent: a second
	//       click on an already-open card must not stack a second editor onto the card.
	showReplyBox() {
		if (this.reply_box)
			return;

		const { app } = this.view.state.field(editorInfoField);
		const container = this.annotation_thread.createDiv({ cls: "cmtr-anno-gutter-reply" });

		this.reply_box = this.component.addChild(
			new ReplyBox(app, container, {
				placeholder: "Reply…",
				onCommit: (text) => commitReply(this.view, this.annotation, text),
				onDismiss: () => this.hideReplyBox(),
			}),
		);
	}

	hideReplyBox() {
		if (!this.reply_box)
			return;
		this.component.removeChild(this.reply_box);
		this.reply_box = null;
	}
```

Then, in the existing `onCommentThreadClick` (`:430-445`), add `this.showReplyBox();` as the last
statement of the method (after the `classList.toggle(...)` line).

Finally, in `destroy` (`:546`), add `this.hideReplyBox();` as the first statement so a card torn
down with an open box does not leak its editor.

> On `commitReply` succeeding: the dispatch changes the document, which rebuilds the gutter and
> throws this marker away — so there is nothing to clear. The `onCommit` callback deliberately does
> not call `hideReplyBox()`; the card it belongs to is already gone.

- [ ] **Step 8: Type-check, lint, and run the full suite**

Run: `bun test && bun run tsc -noEmit -skipLibCheck && bun eslint src/ && bun dprint fmt`
Expected: all green.

- [ ] **Step 9: Manually verify**

Run: `bun run build:dev:hr`. In a vault note:
1. Click an existing comment card → a focused reply box appears beneath the last reply.
2. Type `looks good` and press **Enter** → the note gains `{>>looks good<<}` at the end of the thread; the card shows it.
3. Click the card, type `abc`, press **Shift+Enter** → a newline is inserted; the reply is *not* submitted.
4. Click the card, type `abc`, then click into the note → **the box stays open with `abc` still in it.** Nothing was written.
5. Click the card, type nothing, click away → the box disappears; the note is unchanged.
6. Click the card, type `abc`, press **Escape** → the box disappears; the note is unchanged.
7. **Click a suggestion card (an addition or deletion)** → reply box appears; Enter writes `{++x++}{>>…<<}`. This is comments-on-suggestions.

- [ ] **Step 10: Commit**

```bash
git add src/editor/renderers/gutters/annotations-gutter/reply-box.ts \
        src/editor/renderers/gutters/annotations-gutter/marker.ts
git commit -m "feat: inline reply box on annotation gutter thread cards

Clicking a thread card reveals a focused reply input beneath it. Enter
submits, Shift+Enter newlines, Escape or an empty blur dismisses. A blur
with text left in the box keeps the box open and writes nothing, so
clicking into the note can never silently commit a half-written reply.

Because the parser's thread rule is type-agnostic on the base, suggestion
cards get this too: clicking an addition or deletion and typing starts a
comment thread on it."
```

---

### Task 2: Comment draft state (logic only, not yet wired)

No user-visible change. Task 3 consumes it.

**Files:**
- Create: `src/editor/uix/extensions/comment-draft.ts`
- Modify: `src/editor/uix/extensions/index.ts`
- Modify: `src/editor/base/edit-logic/add-comment.ts` (add `commitCommentDraft`)
- Test: `tests/comment_draft.test.ts` (create)

**Interfaces:**
- Consumes: `commitReply`'s imports (already present in `add-comment.ts`).
- Produces:
  - `export interface CommentDraft { from: number; to: number }`
  - `export const setCommentDraft: StateEffectType<CommentDraft>`
  - `export const clearCommentDraft: StateEffectType<null>`
  - `export const commentDraftField: StateField<CommentDraft | null>`
  - `export function commitCommentDraft(editor: EditorView, text: string): boolean` (in `add-comment.ts`)

- [ ] **Step 1: Write the failing test**

Create `tests/comment_draft.test.ts`:

```ts
import { EditorView } from "@codemirror/view";

import { rangeParser, SuggestionType } from "../src/editor/base";
import { commitCommentDraft } from "../src/editor/base/edit-logic/add-comment";
import { clearCommentDraft, commentDraftField, setCommentDraft } from "../src/editor/uix/extensions/comment-draft";
import { createRangeState } from "./helpers";

const NO_META = { add_metadata: false };

function viewWith(doc: string) {
	return new EditorView({ state: createRangeState(doc, NO_META, [commentDraftField]) });
}

describe("commentDraftField", () => {
	test("starts empty and holds a draft anchor when set", () => {
		const view = viewWith("hello world");
		expect(view.state.field(commentDraftField)).toBeNull();

		view.dispatch({ effects: setCommentDraft.of({ from: 0, to: 5 }) });
		expect(view.state.field(commentDraftField)).toEqual({ from: 0, to: 5 });
	});

	test("clears on the clear effect", () => {
		const view = viewWith("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 0, to: 5 }) });
		view.dispatch({ effects: clearCommentDraft.of(null) });
		expect(view.state.field(commentDraftField)).toBeNull();
	});

	// EXPL: The draft must SURVIVE an unrelated edit, not be discarded by it. Discarding on any
	//       docChanged would contradict the "blur with text leaves the box open" rule: a user who
	//       types a draft, then clicks into the note to fix a word, would silently lose it. The
	//       anchor is a position pair, and mapping position pairs through a ChangeSet is exactly
	//       what CM6's `tr.changes.mapPos` is for.
	test("maps the anchor through an unrelated edit elsewhere in the note", () => {
		const view = viewWith("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 6, to: 11 }) }); // "world"
		view.dispatch({ changes: { from: 0, to: 0, insert: "XX" } });
		expect(view.state.field(commentDraftField)).toEqual({ from: 8, to: 13 });
	});

	// EXPL: The one case that DOES kill a draft — the text it was anchored to is gone, so there is
	//       nothing left to comment on and the mapped range collapses to empty.
	test("clears when its anchored text is deleted outright", () => {
		const view = viewWith("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 6, to: 11 }) }); // "world"
		view.dispatch({ changes: { from: 6, to: 11, insert: "" } });
		expect(view.state.field(commentDraftField)).toBeNull();
	});
});

describe("commitCommentDraft", () => {
	test("writes highlight + comment in ONE transaction and clears the draft", () => {
		const view = viewWith("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 0, to: 5 }) });

		const before = view.state.doc.length;
		let transactions = 0;
		// EXPL: A second transaction here would put junk in the undo stack — "one Ctrl+Z undoes the
		//       comment" is the property being pinned, not merely the resulting text.
		const counted = new EditorView({
			state: view.state,
			dispatch: (tr, v) => {
				transactions += 1;
				v.update([tr]);
			},
		});

		expect(commitCommentDraft(counted, "nice")).toBe(true);
		expect(transactions).toBe(1);
		expect(counted.state.doc.toString()).toBe("{==hello==}{>>nice<<} world");
		expect(counted.state.field(commentDraftField)).toBeNull();
		expect(before).toBe(11);

		const ranges = counted.state.field(rangeParser).ranges.ranges;
		expect(ranges[0].type).toBe(SuggestionType.HIGHLIGHT);
		expect(ranges[0].replies).toHaveLength(1);
		expect(ranges[0].replies[0].unwrap()).toBe("nice");
	});

	test("blank text writes nothing, and leaves the draft open", () => {
		const view = viewWith("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 0, to: 5 }) });
		expect(commitCommentDraft(view, "  ")).toBe(false);
		expect(view.state.doc.toString()).toBe("hello world");
		expect(view.state.field(commentDraftField)).toEqual({ from: 0, to: 5 });
	});

	test("with no draft open, writes nothing", () => {
		const view = viewWith("hello world");
		expect(commitCommentDraft(view, "nice")).toBe(false);
		expect(view.state.doc.toString()).toBe("hello world");
	});
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test tests/comment_draft.test.ts`
Expected: FAIL — the module `src/editor/uix/extensions/comment-draft` does not exist.

- [ ] **Step 3: Create the draft state field**

Create `src/editor/uix/extensions/comment-draft.ts`:

```ts
import { StateEffect, StateField } from "@codemirror/state";

/** The document span a not-yet-written comment is anchored to. */
export interface CommentDraft {
	from: number;
	to: number;
}

export const setCommentDraft = StateEffect.define<CommentDraft>();
export const clearCommentDraft = StateEffect.define<null>();

/**
 * Holds the anchor of a comment the user is composing but has NOT submitted.
 *
 * EXPL: The document is this plugin's only storage, so the old flow wrote `{==sel==}{>>@@<<}` the
 *       instant the pill was clicked and then chased it with a setTimeout to focus the editor it
 *       had just created (the FIXME in add-comment.ts). Abandoning that comment left an empty range
 *       in the user's note and two junk entries in the undo stack. Keeping the pending anchor in a
 *       StateField instead means the note is written exactly once, on submit, with the text already
 *       in hand — and an abandoned comment is a no-op, not a cleanup.
 */
export const commentDraftField = StateField.define<CommentDraft | null>({
	create: () => null,

	update(draft, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setCommentDraft))
				return effect.value;
			if (effect.is(clearCommentDraft))
				return null;
		}

		if (!draft || !tr.docChanged)
			return draft;

		// EXPL: Map, do not discard. Discarding on any docChanged would contradict the reply box's
		//       "blur with text leaves the box open" rule — a user who types a draft, clicks into
		//       the note to fix a word, and comes back would find their draft silently gone. The
		//       anchor only dies when the text it points AT is deleted, at which point the mapped
		//       span collapses to empty and there is genuinely nothing left to comment on.
		const from = tr.changes.mapPos(draft.from, 1);
		const to = tr.changes.mapPos(draft.to, -1);
		return from < to ? { from, to } : null;
	},
});
```

- [ ] **Step 4: Implement `commitCommentDraft`**

In `src/editor/base/edit-logic/add-comment.ts`, add this import at the top:

```ts
import { clearCommentDraft, commentDraftField } from "../../uix/extensions/comment-draft";
```

and add the function below `commitReply`:

```ts
/**
 * Write the open comment draft to the note: highlight + comment, in ONE transaction.
 *
 * EXPL: Single dispatch on purpose — one Ctrl+Z takes the whole comment back out. The old flow
 *       needed two (insert empty markup, then save the text into it), so undo left the user with a
 *       stray `{>>@@<<}`.
 * @returns false (writing nothing, draft left open) if there is no draft or the text is blank.
 */
export function commitCommentDraft(editor: EditorView, text: string): boolean {
	const draft = editor.state.field(commentDraftField);
	if (!draft || !text.trim())
		return false;

	const settings = editor.state.field(pluginSettingsField);
	const anchor_text = editor.state.sliceDoc(draft.from, draft.to);
	const insert = create_range(settings, SuggestionType.HIGHLIGHT, anchor_text) +
		create_range(settings, SuggestionType.COMMENT, text);

	editor.dispatch(editor.state.update({
		changes: { from: draft.from, to: draft.to, insert },
		effects: [clearCommentDraft.of(null)],
		annotations: [commentModeAnnotation.of(true)],
	}));
	return true;
}
```

- [ ] **Step 5: Re-export from the extensions barrel**

In `src/editor/uix/extensions/index.ts`, add the import and the matching entries to the `export {}`
block (keep both lists alphabetical, as they already are):

```ts
import { clearCommentDraft, commentDraftField, setCommentDraft } from "./comment-draft";
```

Add `clearCommentDraft`, `commentDraftField`, and `setCommentDraft` to the export block.

- [ ] **Step 6: Run the tests and verify they pass**

Run: `bun test tests/comment_draft.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Full suite, type-check, lint, commit**

Run: `bun test && bun run tsc -noEmit -skipLibCheck && bun eslint src/ && bun dprint fmt`

```bash
git add src/editor/uix/extensions/comment-draft.ts \
        src/editor/uix/extensions/index.ts \
        src/editor/base/edit-logic/add-comment.ts \
        tests/comment_draft.test.ts
git commit -m "feat: comment draft state field and single-transaction commit

Holds a pending comment's anchor without writing anything to the note.
The anchor maps through unrelated edits rather than being discarded, and
dies only when the text it points at is deleted. commitCommentDraft
writes highlight + comment in one transaction, so a single undo takes the
whole comment back out."
```

---

### Task 3: Provisional card + pill wiring

Makes Task 2 visible and retires the empty-markup flow.

**Files:**
- Create: `src/editor/renderers/gutters/annotations-gutter/pending-marker.ts`
- Modify: `src/editor/renderers/gutters/annotations-gutter/index.ts:36`
- Modify: `src/editor/base/edit-logic/add-comment.ts` (selection path of `addCommentToView`)
- Modify: `src/editor/uix/extensions/comment-pill.ts` (`pill_eligible`)
- Modify: `src/main.ts:156`
- Test: `tests/add_comment.test.ts` (**update an existing test — its expectation changes**)

**Interfaces:**
- Consumes: `commentDraftField`, `setCommentDraft`, `clearCommentDraft`, `commitCommentDraft` (Task 2); `ReplyBox` (Task 1).
- Produces: `export const pendingAnnotationMarkers: StateField<RangeSet<PendingAnnotationMarker>>`.

- [ ] **Step 1: Update the existing `addCommentToView` selection test**

`tests/add_comment.test.ts` currently asserts that a clean selection immediately writes
`{==hello==}{>><<}`. That is the behaviour being deliberately removed. **Replace** the first test in
the `describe("addCommentToView with a selection")` block with:

```ts
	// EXPL: This used to assert the doc immediately became "{==hello==}{>><<}". That flow is gone:
	//       a clean selection now opens a DRAFT and writes nothing until the user submits, so an
	//       abandoned comment leaves no empty range in the note and no junk in the undo stack.
	//       The write itself is covered by tests/comment_draft.test.ts (commitCommentDraft).
	test("a clean selection opens a draft and writes nothing to the document", () => {
		const view = viewWith("hello world", 0, 5);
		addCommentToView(view, undefined);
		expect(view.state.doc.toString()).toBe("hello world");
		expect(view.state.field(commentDraftField)).toEqual({ from: 0, to: 5 });
	});
```

and add `commentDraftField` to that file's imports, and to the extensions passed by its `viewWith`
helper (`createRangeState(doc, NO_META, [commentDraftField])`).

Leave the "selection overlapping existing markup falls back to cursor behavior" test **unchanged** —
that path still inserts a bare comment at the cursor, which is correct.

- [ ] **Step 2: Run it and verify it fails**

Run: `bun test tests/add_comment.test.ts`
Expected: FAIL — the doc still becomes `{==hello==}{>><<}`.

- [ ] **Step 3: Rewrite the selection path of `addCommentToView`**

In `src/editor/base/edit-logic/add-comment.ts`, replace the whole `if (!range && !selection.empty)`
block (`:26-51`) with:

```ts
	// EXPL: GDocs-style anchored comment. A clean selection no longer writes markup here — it opens
	//       a DRAFT (comment-draft.ts) that the gutter renders a provisional card for, and the note
	//       is written once, on submit, by commitCommentDraft. CriticMarkup cannot nest, so a
	//       selection touching existing markup has nowhere clean to wrap and falls through to the
	//       plain at-cursor comment below.
	if (!range && !selection.empty) {
		const ranges = editor.state.field(rangeParser).ranges;
		if (ranges.ranges_in_interval(selection.from, selection.to).length === 0) {
			editor.dispatch({
				effects: setCommentDraft.of({ from: selection.from, to: selection.to }),
				scrollIntoView: scroll,
			});
			return;
		}
	}
```

Add `setCommentDraft` to the `comment-draft` import you created in Task 2. The now-unused imports
`EditorSelection` and `annotationGutterFocusAnnotation` may still be needed by the at-cursor path
below — **do not remove any import without checking**; run `bun eslint src/`, which will flag
genuinely unused ones.

This deletes the first of the two `activeWindow.setTimeout` focus hacks. The second (in the
at-cursor path) stays: that path still inserts an empty comment and must still focus it.

- [ ] **Step 4: Create the provisional marker**

Create `src/editor/renderers/gutters/annotations-gutter/pending-marker.ts`:

```ts
import { RangeSet, StateField } from "@codemirror/state";
import { EditorView, GutterMarker } from "@codemirror/view";

import { Component, editorEditorField, editorInfoField } from "obsidian";

import { commitCommentDraft } from "../../../base/edit-logic/add-comment";
import { clearCommentDraft, commentDraftField } from "../../../uix/extensions/comment-draft";
import { ReplyBox } from "./reply-box";

/**
 * The gutter card for a comment that is not in the document yet.
 *
 * EXPL: Duck-types AnnotationMarker's `annotation.from`. AnnotationGutterUpdateContext.addElement
 *       sorts a card's markers with an UNCHECKED cast —
 *       `(markers as unknown as AnnotationMarker[]).sort((a, b) => a.annotation.from - b.annotation.from)`
 *       (annotation-gutter.ts:283-284). A marker without that shape sorts as NaN and scrambles the
 *       order of every card sharing its block, so this field is load-bearing, not decorative.
 */
export class PendingAnnotationMarker extends GutterMarker {
	annotation: { from: number; to: number };
	component: Component = new Component();
	preventUnload = false;

	constructor(from: number, to: number, public view: EditorView) {
		super();
		this.annotation = { from, to };
	}

	eq(other: PendingAnnotationMarker) {
		return this.annotation.from === other.annotation.from && this.annotation.to === other.annotation.to;
	}

	toDOM() {
		const { app } = this.view.state.field(editorInfoField);

		const thread = createDiv({ cls: ["cmtr-anno-gutter-thread", "cmtr-anno-gutter-thread-pending"] });

		// EXPL: Echo the text being commented on, the way Docs does — the card floats in the gutter
		//       with no markup in the note to point back at it yet.
		thread.createDiv({
			cls: "cmtr-anno-gutter-pending-quote",
			text: this.view.state.sliceDoc(this.annotation.from, this.annotation.to),
		});

		const container = thread.createDiv({ cls: "cmtr-anno-gutter-reply" });
		this.component.addChild(
			new ReplyBox(app, container, {
				placeholder: "Comment…",
				onCommit: (text) => commitCommentDraft(this.view, text),
				onDismiss: () => this.view.dispatch({ effects: clearCommentDraft.of(null) }),
			}),
		);
		this.component.load();

		return thread;
	}

	destroy(dom: HTMLElement) {
		this.component.unload();
		super.destroy(dom);
	}
}

/**
 * EXPL: A second RangeSet rather than a branch inside annotationGutterMarkers: that field only
 *       recomputes on docChanged (marker.ts:640-641), and a draft's whole point is that it changes
 *       nothing in the document. The gutter's `markers` accessor already takes an array of
 *       RangeSets (base.ts:60), so joining one in costs nothing.
 */
export const pendingAnnotationMarkers = StateField.define<RangeSet<PendingAnnotationMarker>>({
	create: () => RangeSet.empty,

	update(_set, tr) {
		const draft = tr.state.field(commentDraftField);
		if (!draft)
			return RangeSet.empty;

		// EXPL: `editorEditorField` is Obsidian's own StateField holding the EditorView — the same
		//       way marker.ts:554 gets a view inside annotationGutterMarkers' StateField, which
		//       otherwise has no access to one.
		const view = tr.state.field(editorEditorField);
		const marker = new PendingAnnotationMarker(draft.from, draft.to, view);
		return RangeSet.of([marker.range(draft.from, draft.to)]);
	},
});
```

**On rebuilding every update:** this recreates the marker on each transaction while a draft is open.
`GutterMarker.eq` (implemented above on `from`/`to`) is what CodeMirror uses to decide whether to
re-render, so an unchanged draft anchor will *not* tear down and rebuild the card's DOM — which
matters, because rebuilding it would destroy the `ReplyBox` the user is typing into. **Step 9, check
5 is the test of exactly this** — if the half-typed `abc` vanishes when you edit another paragraph,
`eq` is not doing its job.

- [ ] **Step 5: Join the pending markers into the gutter**

In `src/editor/renderers/gutters/annotations-gutter/index.ts`, change the `markers` accessor
(`:36`):

```ts
		markers: v => [v.state.field(annotationGutterMarkers), v.state.field(pendingAnnotationMarkers)],
```

and add `pendingAnnotationMarkers` to the extension array returned at `:43`:

```ts
	return { extension: [annotationGutterMarkers, pendingAnnotationMarkers, extension], config };
```

importing it from `./pending-marker`.

- [ ] **Step 6: Hide the pill while a draft is open**

In `src/editor/uix/extensions/comment-pill.ts`, add to `pill_eligible` (`:23`), immediately after
the `state.readOnly` guard:

```ts
	// EXPL: A draft already has a card and a focused input in the gutter; leaving the pill floating
	//       over the same selection would offer to start a second comment on it.
	if (state.field(commentDraftField, false))
		return false;
```

Import `commentDraftField` from `./comment-draft`. Pass `false` as the second argument to
`state.field` so the pill still works in states where the draft field was never installed (the unit
tests construct exactly such states).

- [ ] **Step 7: Register the draft field**

In `src/main.ts`, beside the existing `this.editorExtensions.push(commentPill);` (`:156`):

```ts
		this.editorExtensions.push(commentDraftField);
```

and add `commentDraftField` to the import block from `./editor/uix/extensions` at `:51`.

- [ ] **Step 8: Run the tests, type-check, lint**

Run: `bun test && bun run tsc -noEmit -skipLibCheck && bun eslint src/ && bun dprint fmt`
Expected: all green, including the updated `tests/add_comment.test.ts`.

- [ ] **Step 9: Manually verify**

Run: `bun run build:dev:hr`. In a vault note:
1. Select text → the pill appears → click it. **The note does not change.** A provisional card
   appears in the gutter, quoting the selection, with a focused input.
2. Type `first thought`, press **Enter** → the note becomes `{==selection==}{>>first thought<<}` and
   a normal card replaces the provisional one.
3. Press **Ctrl/Cmd+Z once** → the whole comment is gone. (Previously this took two undos and left
   a stray `{>>@@<<}`.)
4. Select text → click the pill → press **Escape**. The card disappears; **the note is byte-for-byte
   unchanged** (check with `git diff` on the vault file if it is in a repo).
5. Select text → click the pill → type `abc` → click into the note and edit a *different* paragraph.
   The provisional card and the text `abc` **survive**.
6. Select text → click the pill → type `abc` → select and delete the text you were commenting on.
   The provisional card disappears.
7. While a provisional card is open, the pill is not showing.

- [ ] **Step 10: Commit**

```bash
git add src/editor/renderers/gutters/annotations-gutter/pending-marker.ts \
        src/editor/renderers/gutters/annotations-gutter/index.ts \
        src/editor/base/edit-logic/add-comment.ts \
        src/editor/uix/extensions/comment-pill.ts \
        src/main.ts \
        tests/add_comment.test.ts
git commit -m "feat: draft-then-insert for new comments

Clicking the pill no longer writes {==sel==}{>>@@<<} into the note and
then chases it with a setTimeout to focus the editor it just created.
It opens a draft: the gutter renders a provisional card with a focused
input, and the note is written exactly once, on submit, with the text
already in hand. Abandoning a comment is now a no-op rather than a
cleanup, and one undo takes a committed comment back out.

Removes the first of add-comment.ts's two setTimeout focus hacks."
```

---

### Task 4: Style the reply box and provisional card

**Files:**
- Modify: `src/assets/annotation-gutter.scss`

**Interfaces:**
- Consumes: the class names emitted by Tasks 1 and 3 — `.cmtr-anno-gutter-reply`,
  `.cmtr-anno-gutter-reply-editor`, `.cmtr-anno-gutter-thread-pending`,
  `.cmtr-anno-gutter-pending-quote`.
- Produces: no JS surface.

> If PR2 (flat cards) has already landed, these rules must use its tokens
> (`--background-secondary`, `--radius-m`, tint-not-stroke). If it has not, use whatever the card
> currently uses and let PR2 rebase over it. **Do not re-litigate the card design here.**

- [ ] **Step 1: Add the styles**

Append to `src/assets/annotation-gutter.scss`:

```scss
// ================================================
// 	     Editor Comment Gutter Reply Box
// ================================================

// EXPL: Separated from the entries above by the same hairline the entries use between themselves,
//       so the box reads as the next item in the thread rather than a detached widget.
.cmtr-anno-gutter-reply {
  padding: var(--size-2-2);
  border-top: 1px solid var(--background-modifier-border);
}

.cmtr-anno-gutter-reply-editor.cm-editor {
  min-height: auto;
  background-color: var(--background-primary);
  border-radius: var(--radius-s);
  padding: var(--size-2-1) var(--size-2-2);
}

// EXPL: The provisional card has no markup in the note behind it yet, so it quotes the text it is
//       about — the user needs to see what they are commenting on. Same muted-quote language the
//       Annotations View uses for anchored highlights (`.cmtr-view-range-anchor-quote`, view.scss).
.cmtr-anno-gutter-pending-quote {
  font-size: var(--font-smaller);
  color: var(--text-muted);
  padding: var(--size-2-2) var(--size-2-2) 0;

  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
```

- [ ] **Step 2: Build and verify by eye**

Run: `bun run build:dev:hr`

In **both light and dark themes**:
1. Click a comment card → the reply box sits below a hairline, its input reading as an input.
2. Select text → click the pill → the provisional card shows a muted two-line-clamped quote of the
   selection above a focused input.
3. A long selection (several sentences) → the quote clamps to two lines and does not blow out the
   card's height.
4. The input is legible and opaque in both themes.

- [ ] **Step 3: Commit**

```bash
git add src/assets/annotation-gutter.scss styles.css
git commit -m "style: reply box and provisional comment card"
```

---

## Self-review notes

- **Spec coverage.** Reply box on gutter cards → Task 1. Comments on suggestions → Task 1 (falls out
  of the type-agnostic base; explicitly tested). Draft-then-insert + provisional card → Tasks 2–3.
  Draft lifecycle (Escape / empty-blur / commit clears; maps through edits; dies when its text dies)
  → Task 2's tests. Enter/Shift+Enter/blur contract → Task 1's `ReplyBox`. Pill hidden while
  drafting → Task 3, Step 6. Styles → Task 4.
- **No placeholders.** The one open question (how a `StateField` reaches an `EditorView`) is
  resolved: `editorEditorField`, exactly as `marker.ts:554` does it.
- **The riskiest seam** is `GutterMarker.eq` on the provisional card. Get it wrong and CodeMirror
  rebuilds the card's DOM on every keystroke elsewhere in the note, destroying the `ReplyBox`
  mid-compose. Task 3, Step 9 check 5 is the trip-wire for it.
- **Out of scope, as agreed:** always-visible Reply/Resolve buttons, avatars, relative timestamps,
  reply boxes in the hover tooltip and the sidebar. The existing context menus keep working.
