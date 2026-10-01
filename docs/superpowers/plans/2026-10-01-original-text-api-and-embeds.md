# Inkling: Original-Text API and Clean Transclusions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Inkling a public `toOriginalText` API, and make transclusions of notes that contain CriticMarkup display the original text (suggestions shown as rejected, comments hidden) instead of raw markup.

**Architecture:**
- **Pure function:** `src/api/original-text.ts` implements the "original text" rule on top of Inkling's existing parser (`getRangesInText`, range `reject()`/`unwrap()`, `applyToText`).
- **Public API:** `src/api/index.ts` wraps the function and exposes it on the plugin as `plugin.api`.
- **Embed renderer:** a new embed renderer (`src/editor/renderers/embed/`) observes rendered transclusions. For any embed whose source contains CriticMarkup, it re-renders the embed's content from `toOriginalText(source)` with Obsidian's `MarkdownRenderer`.

**Tech Stack:** TypeScript, Obsidian API (minAppVersion 1.7.5), `@fevol/lang-criticmarkup` (Lezer), Jest 30 + ts-jest, Bun scripts, esbuild.

**Spec:** `/Users/andrewbroz/Code/cri/obsidian-transclusion-extractor/docs/superpowers/specs/2026-09-30-inkling-integration-design.md` (§2 and §3 apply to this repo)

## Global Constraints

- **Original-text rule (spec §2):**
  - additions `{++x++}` are removed;
  - deletions `{--x--}` become `x`;
  - substitutions `{~~a~>b~~}` become `a`;
  - comments `{>>x<<}`, including whole reply threads, are removed;
  - highlights `{==x==}` become `x`;
  - metadata (`{…}@@`) is never in the output.
- **Whitespace cleanup:** where a removal leaves two spaces, keep one. A line that becomes empty or whitespace-only because of a removal is dropped; if two blank lines then touch, collapse them to one. All other text stays byte-identical.
- **Public API shape:** `plugin.api = Object.freeze({ version: 1, toOriginalText })`. `version` is bumped only on a breaking change.
- **Display only:** transclusion rendering never writes to any file.
- **No new settings.**
- **Code style:** tabs, double quotes, snake_case locals, and `// EXPL:` comments for non-obvious reasoning, matching the existing code. Run `bun dprint fmt` before each commit.
- **Commits:** conventional messages ending with `Co-Authored-By: Claude <model> <noreply@anthropic.com>`.
- **Merging and release:** work on branch `feat/original-text`. When done, merge directly to `main` and push (no PR). Tag `0.11.0` only after the user's go-ahead.
- **Spike replaced:** the spec's §3b embed-detection spike is replaced by the spec's fallback option 3 (observer plus re-render from source). The reasons:
  - options 1 and 2 depend on undocumented runtime state of the post-processor context, which can't be verified without driving the Obsidian app;
  - option 3 uses only public API and reuses the pure function from Task 1.

## Review Focus

1. **Text with no CriticMarkup** must come back identical (same string), and embeds of such notes must be left exactly as Obsidian rendered them. Tests are in Tasks 1 and 3 (`hasCriticMarkup`).
2. **Metadata** (`{"author":…}@@`, including shorthand keys) never appears in the original text. Tested in Task 1.
3. **Reply threads** (`{==x==}{>>a<<}{>>b<<}`) are removed entirely with no leftover spaces. Tested in Task 1.
4. **A comment on its own line between paragraphs** is removed without leaving a double blank line. Tested in Task 1.
5. **Heading-section embeds** end at the next heading of equal or higher level, and **list-item block embeds** include their child items. Tested in Task 3.

---

## File Map

```
src/api/original-text.ts                       # PURE: toOriginalText, hasCriticMarkup
src/api/index.ts                               # PURE: InklingApi type + createApi()
src/api/suggest.ts                             # DELETE (unused stub)
src/editor/renderers/embed/embed-slice.ts      # PURE: embedSlice() for note / heading / block embeds
src/editor/renderers/embed/original-text-embeds.ts  # Obsidian: observer + re-render
src/main.ts                                    # set this.api; register embed renderer
tests/original_text.test.ts
tests/inkling_api.test.ts
tests/embed_slice.test.ts
README.md                                      # "API for other plugins" + transclusion behaviour
docs/manual-checks/transclusions.md            # manual checklist
```

---

### Task 1: `toOriginalText` and `hasCriticMarkup`

**Files:**
- Create: `src/api/original-text.ts`
- Test: `tests/original_text.test.ts`

**Interfaces:**
- Consumes (existing):
  - `getRangesInText(text: string, settings: PluginSettings): CriticMarkupRange[]` from `src/editor/base/edit-util/range-parser.ts`
  - `applyToText(text, fn, ranges)` from `src/editor/base/edit-util/range-operations.ts`
  - `SuggestionType` from `src/editor/base/ranges/definitions.ts`
  - `CriticMarkupRange` from `src/editor/base/ranges/base_range.ts` (`reject()`, `unwrap()`)
  - `DEFAULT_SETTINGS` from `src/constants.ts`
- Produces:
  - `toOriginalText(markdown: string, settings?: PluginSettings): string`
  - `hasCriticMarkup(markdown: string, settings?: PluginSettings): boolean`

- [ ] **Step 1: Create the branch**

```bash
cd ~/Code/personal/obsidian-inkling && git checkout -b feat/original-text
```

- [ ] **Step 2: Write the failing tests** in `tests/original_text.test.ts`

```ts
import { hasCriticMarkup, toOriginalText } from "../src/api/original-text";

describe("toOriginalText", () => {
	test("removes additions", () => {
		expect(toOriginalText("The {++very ++}cat")).toBe("The cat");
	});

	test("keeps deleted text", () => {
		expect(toOriginalText("Hello {--old --}world")).toBe("Hello old world");
	});

	test("keeps the original side of a substitution", () => {
		expect(toOriginalText("The {~~cat~>dog~~} sat.")).toBe("The cat sat.");
	});

	test("unwraps highlights and removes their comments", () => {
		expect(toOriginalText("The {==cat==}{>>check<<} sat.")).toBe("The cat sat.");
	});

	test("removes whole reply threads", () => {
		expect(toOriginalText("Text {==here==}{>>one<<}{>>two<<} end")).toBe("Text here end");
		expect(toOriginalText("Text{>>one<<}{>>two<<} end")).toBe("Text end");
	});

	test("never leaks metadata", () => {
		expect(toOriginalText(`x {++{"author":"A","time":1}@@added ++}y`)).toBe("x y");
		expect(toOriginalText(`{--{"a":"B"}@@gone--} here`)).toBe("gone here");
		expect(toOriginalText(`{~~{"author":"A"}@@old~>new~~}`)).toBe("old");
	});

	test("drops a comment at the end of a line without a trailing space", () => {
		expect(toOriginalText("Done. {>>c<<}")).toBe("Done.");
	});

	test("drops a comment at the start of a line without a leading space", () => {
		expect(toOriginalText("{>>c<<} Start here")).toBe("Start here");
	});

	test("keeps indentation and list markers", () => {
		expect(toOriginalText("- {>>c<<} item")).toBe("- item");
		expect(toOriginalText("  {>>c<<} indented")).toBe("  indented");
	});

	test("drops a line emptied by a removal and collapses the blank lines around it", () => {
		expect(toOriginalText("Para one.\n\n{>>note<<}\n\nPara two.")).toBe("Para one.\n\nPara two.");
		expect(toOriginalText("Para one.\n\n{++New paragraph.++}\n\nPara two.")).toBe("Para one.\n\nPara two.");
	});

	test("keeps blank lines that no removal touched", () => {
		expect(toOriginalText("A\n\n\nB {++x++}")).toBe("A\n\n\nB");
	});

	test("returns text without markup unchanged", () => {
		const text = "# Title\n\nPlain paragraph with {braces} and ~tildes~.\n";
		expect(toOriginalText(text)).toBe(text);
	});

	test("handles markup that spans lines", () => {
		// EXPL: if the grammar does not parse a multi-line comment as one range, the text is returned unchanged;
		//       the snapshot pins whichever behaviour the parser has.
		expect(toOriginalText("A\n\n{>>line one\nline two<<}\n\nB")).toMatchInlineSnapshot();
	});

	test("pins behaviour for markup inside inline code", () => {
		expect(toOriginalText("Use `{++x++}` literally")).toMatchInlineSnapshot();
	});
});

describe("hasCriticMarkup", () => {
	test("detects markup", () => {
		expect(hasCriticMarkup("a {++b++}")).toBe(true);
		expect(hasCriticMarkup("plain {text}")).toBe(false);
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun run test -- tests/original_text.test.ts`
Expected: FAIL, "Cannot find module '../src/api/original-text'".

- [ ] **Step 4: Implement `src/api/original-text.ts`**

```ts
import { DEFAULT_SETTINGS } from "../constants";
import { applyToText } from "../editor/base/edit-util/range-operations";
import { getRangesInText } from "../editor/base/edit-util/range-parser";
import type { CriticMarkupRange } from "../editor/base/ranges/base_range";
import { SuggestionType } from "../editor/base/ranges/definitions";
import type { PluginSettings } from "../types";

// EXPL: Placeholder for a range that disappears entirely, so the whitespace it leaves behind
//       can be tidied without touching whitespace elsewhere in the text.
const REMOVED = "\u0000";

function parse(markdown: string, settings: PluginSettings) {
	// EXPL: Metadata must always be parsed, otherwise `{"author":…}@@` would be treated as range content.
	return getRangesInText(markdown, { ...settings, enable_metadata: true });
}

function originalOf(range: CriticMarkupRange): string {
	switch (range.type) {
		case SuggestionType.ADDITION:
		case SuggestionType.DELETION:
		case SuggestionType.SUBSTITUTION:
			return range.reject();
		case SuggestionType.HIGHLIGHT:
			return range.unwrap();
		default:
			// EXPL: Comments are never document text.
			return "";
	}
}

export function hasCriticMarkup(markdown: string, settings: PluginSettings = DEFAULT_SETTINGS): boolean {
	return parse(markdown, settings).length > 0;
}

/**
 * The note as it reads before review: suggestions rejected, comments removed, highlights unwrapped.
 */
export function toOriginalText(markdown: string, settings: PluginSettings = DEFAULT_SETTINGS): string {
	const ranges = parse(markdown, settings);
	if (!ranges.length) return markdown;
	const marked = applyToText(markdown, (range) => originalOf(range) || REMOVED, ranges);
	return tidy(marked);
}

function tidy(marked: string): string {
	const out: string[] = [];
	let collapse_next_blank = false;
	for (const line of marked.split("\n")) {
		const emptied = line.includes(REMOVED) && line.split(REMOVED).join("").trim() === "";
		if (emptied) {
			// EXPL: Dropping a line that sat between two blank lines would leave them touching.
			collapse_next_blank = out.length > 0 && out[out.length - 1].trim() === "";
			continue;
		}
		if (collapse_next_blank && line.trim() === "") {
			collapse_next_blank = false;
			continue;
		}
		collapse_next_blank = false;
		out.push(line.includes(REMOVED) ? tidyLine(line) : line);
	}
	return out.join("\n");
}

function tidyLine(line: string): string {
	return line.replace(/ ?\u0000(?: ?\u0000)*( ?)/g, (match: string, trailing: string, offset: number) => {
		const leading = match.startsWith(" ");
		const at_start = line.slice(0, offset).trim() === "";
		const at_end = line.slice(offset + match.length) === "";
		if (at_start) return leading ? " " : "";
		if (at_end) return "";
		return leading || trailing ? " " : "";
	});
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test -- tests/original_text.test.ts`
Expected: PASS. Jest fills in the two inline snapshots on this first run; check the written values make sense, and mention them in your report.

- [ ] **Step 6: Run the full suite, format and commit**

Run: `bun run test && bun dprint fmt && bun run build`
Expected: all tests pass and the build succeeds.

```bash
git add src/api/original-text.ts tests/original_text.test.ts
git commit -m "feat: add toOriginalText (suggestions rejected, comments removed)" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

### Task 2: Public API on the plugin

**Files:**
- Create: `src/api/index.ts`
- Delete: `src/api/suggest.ts`
- Modify: `src/main.ts` (class field and `onload`)
- Modify: `README.md`
- Test: `tests/inkling_api.test.ts`

**Interfaces:**
- Consumes: `toOriginalText` (Task 1); `DEFAULT_SETTINGS`; `PluginSettings`.
- Produces:
  - `interface InklingApi { readonly version: 1; toOriginalText(markdown: string): string }`
  - `createApi(get_settings: () => PluginSettings): InklingApi`
  - plugin field `api: InklingApi`

- [ ] **Step 1: Write the failing test** in `tests/inkling_api.test.ts`

```ts
import { DEFAULT_SETTINGS } from "../src/constants";
import { createApi } from "../src/api";

describe("createApi", () => {
	test("exposes version 1 and toOriginalText", () => {
		const api = createApi(() => DEFAULT_SETTINGS);
		expect(api.version).toBe(1);
		expect(api.toOriginalText("a {++b ++}c")).toBe("a c");
	});

	test("is frozen", () => {
		const api = createApi(() => DEFAULT_SETTINGS);
		expect(Object.isFrozen(api)).toBe(true);
	});

	test("reads settings at call time", () => {
		let calls = 0;
		const api = createApi(() => (calls++, DEFAULT_SETTINGS));
		api.toOriginalText("x");
		api.toOriginalText("y");
		expect(calls).toBe(2);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- tests/inkling_api.test.ts`
Expected: FAIL, cannot find module `../src/api`.

- [ ] **Step 3: Implement `src/api/index.ts` and delete the stub**

```ts
import type { PluginSettings } from "../types";
import { toOriginalText } from "./original-text";

/**
 * Stable API for other plugins: `app.plugins.getPlugin("inkling")?.api`.
 * EXPL: `version` only changes on a breaking change; consumers should check `version >= 1`.
 */
export interface InklingApi {
	readonly version: 1;
	toOriginalText(markdown: string): string;
}

export function createApi(get_settings: () => PluginSettings): InklingApi {
	return Object.freeze({
		version: 1 as const,
		toOriginalText: (markdown: string) => toOriginalText(markdown, get_settings()),
	});
}
```

Run: `git rm src/api/suggest.ts` (nothing imports it; confirm first with `grep -rn "api/suggest" src tests`, which should print nothing).

- [ ] **Step 4: Wire it into the plugin**

In `src/main.ts`:
- Add `import { createApi, type InklingApi } from "./api";`.
- Add a class field next to `settings`: `api!: InklingApi;`.
- In `onload()`, directly after `await this.migrateSettings(await this.loadData());`, add:

```ts
		// EXPL: Public API for other plugins (e.g. Transclusion Extractor); see README "API for other plugins".
		this.api = createApi(() => this.settings);
```

- [ ] **Step 5: Document it in `README.md`** by adding this section before the license/credits section:

````markdown
## API for other plugins

Other plugins can turn CriticMarkup into the note's original text: suggestions shown as rejected, comments removed, highlights unwrapped.

```ts
const api = app.plugins.getPlugin("inkling")?.api;
if (api && api.version >= 1) {
	const original = api.toOriginalText(markdown);
}
```

`version` changes only on a breaking change. Transclusions of notes containing CriticMarkup are displayed using this original text.
````

- [ ] **Step 6: Run the tests, build and commit**

Run: `bun run test && bun dprint fmt && bun run build`
Expected: all tests pass and the build succeeds.

```bash
git add -A src/api src/main.ts README.md tests/inkling_api.test.ts
git commit -m "feat: expose toOriginalText as a versioned plugin API" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

### Task 3: `embedSlice`, the source text a transclusion shows

**Files:**
- Create: `src/editor/renderers/embed/embed-slice.ts`
- Test: `tests/embed_slice.test.ts`

**Interfaces:**
- Produces:
  - `type EmbedTarget = { kind: "note"; frontmatter_end: number | null } | { kind: "heading"; headings: HeadingLike[]; index: number } | { kind: "block"; start: number; end: number; list_items?: ListItemLike[]; list_line?: number }`
  - `embedSlice(text: string, target: EmbedTarget): string`
  - `HeadingLike = { level: number; position: { start: { line: number; offset: number } } }`
  - `ListItemLike = { parent: number; position: { start: { line: number; offset: number }; end: { line: number; offset: number } } }`

- [ ] **Step 1: Write the failing tests** in `tests/embed_slice.test.ts`

```ts
import { embedSlice } from "../src/editor/renderers/embed/embed-slice";

const h = (level: number, offset: number) => ({ level, position: { start: { line: 0, offset } } });
const li = (line: number, parent: number, end: number) => ({
	parent,
	position: { start: { line, offset: 0 }, end: { line, offset: end } },
});

describe("embedSlice", () => {
	test("whole note without frontmatter", () => {
		expect(embedSlice("Body", { kind: "note", frontmatter_end: null })).toBe("Body");
	});

	test("whole note skips frontmatter and the newline after it", () => {
		const text = "---\na: 1\n---\nBody";
		expect(embedSlice(text, { kind: "note", frontmatter_end: 12 })).toBe("Body");
	});

	test("heading section ends at the next heading of equal or higher level", () => {
		const text = "# A\nx\n## B\ny\n### C\nz\n## D\nw";
		const headings = [h(1, 0), h(2, 6), h(3, 13), h(2, 21)];
		expect(embedSlice(text, { kind: "heading", headings, index: 1 })).toBe("## B\ny\n### C\nz\n");
	});

	test("last heading section runs to the end", () => {
		const text = "# A\nx\n## D\nw";
		expect(embedSlice(text, { kind: "heading", headings: [h(1, 0), h(2, 6)], index: 1 })).toBe("## D\nw");
	});

	test("block slice", () => {
		expect(embedSlice("aa\nPara ^p\nbb", { kind: "block", start: 3, end: 10 })).toBe("Para ^p");
	});

	test("list-item block includes its children", () => {
		const text = "- Alpha\n- Main ^m\n  - Child\n- Omega";
		const items = [li(0, -1, 7), li(1, -1, 17), li(2, 1, 27), li(3, -1, 35)];
		expect(embedSlice(text, { kind: "block", start: 8, end: 17, list_items: items, list_line: 1 }))
			.toBe("- Main ^m\n  - Child");
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- tests/embed_slice.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `src/editor/renderers/embed/embed-slice.ts`**

```ts
interface Loc {
	line: number;
	offset: number;
}

export interface HeadingLike {
	level: number;
	position: { start: Loc };
}

export interface ListItemLike {
	/** Line of the parent list item; negative for top-level items. */
	parent: number;
	position: { start: Loc; end: Loc };
}

export type EmbedTarget =
	| { kind: "note"; frontmatter_end: number | null }
	| { kind: "heading"; headings: HeadingLike[]; index: number }
	| { kind: "block"; start: number; end: number; list_items?: ListItemLike[]; list_line?: number };

/** The part of a note's source that Obsidian shows for a transclusion of `target`. */
export function embedSlice(text: string, target: EmbedTarget): string {
	switch (target.kind) {
		case "note":
			return target.frontmatter_end === null ? text : text.slice(target.frontmatter_end).replace(/^\r?\n/, "");
		case "heading": {
			const { headings, index } = target;
			const level = headings[index].level;
			let end = text.length;
			for (let j = index + 1; j < headings.length; j++) {
				if (headings[j].level <= level) {
					end = headings[j].position.start.offset;
					break;
				}
			}
			return text.slice(headings[index].position.start.offset, end);
		}
		case "block": {
			let end = target.end;
			if (target.list_items && target.list_line !== undefined)
				end = Math.max(end, listItemEnd(target.list_items, target.list_line));
			return text.slice(target.start, end);
		}
	}
}

function listItemEnd(items: ListItemLike[], root_line: number): number {
	const members = new Set([root_line]);
	let end = -1;
	for (const item of [...items].sort((a, b) => a.position.start.line - b.position.start.line)) {
		const line = item.position.start.line;
		if (line === root_line || (line > root_line && members.has(item.parent))) {
			members.add(line);
			end = Math.max(end, item.position.end.offset);
		}
	}
	return end;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- tests/embed_slice.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

Run: `bun run test && bun dprint fmt`

```bash
git add src/editor/renderers/embed/embed-slice.ts tests/embed_slice.test.ts
git commit -m "feat: compute the source slice shown by a transclusion" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

### Task 4: Render transclusions as original text

**Files:**
- Create: `src/editor/renderers/embed/original-text-embeds.ts`
- Modify: `src/main.ts` (`onload`)
- Create: `docs/manual-checks/transclusions.md`

**Interfaces:**
- Consumes:
  - `toOriginalText`, `hasCriticMarkup` (Task 1)
  - `embedSlice`, `EmbedTarget` (Task 3)
  - Obsidian: `MarkdownRenderer.render`, `resolveSubpath`, `MarkdownView`, `TFile`, `Vault.cachedRead`, `Vault.getFileByPath`, `MetadataCache.getFirstLinkpathDest`, `MetadataCache.getFileCache`
- Produces: `registerOriginalTextEmbeds(plugin: CommentatorPlugin): void`

- [ ] **Step 1: Check the Obsidian APIs used**

Run: `grep -n "export function resolveSubpath\|static render(\|getFileByPath\|getFirstLinkpathDest\|frontmatterPosition" node_modules/obsidian/obsidian.d.ts`
Expected: all five exist. `MarkdownRenderer.render(app, markdown, el, sourcePath, component)` is static and returns `Promise<void>`. If any signature differs, adapt the code below minimally and note it in the report.

- [ ] **Step 2: Implement `src/editor/renderers/embed/original-text-embeds.ts`**

```ts
import { type App, MarkdownRenderer, MarkdownView, resolveSubpath, TFile } from "obsidian";

import { hasCriticMarkup, toOriginalText } from "../../../api/original-text";
import type CommentatorPlugin from "../../../main";
import { embedSlice, type EmbedTarget } from "./embed-slice";

const EMBED_SELECTOR = ".internal-embed.markdown-embed[src]";
const RENDERED_CLASS = "inkling-original-embed";

/**
 * EXPL: Transclusions are rendered by Obsidian as read-only HTML, outside Inkling's editor extensions, so raw
 *       CriticMarkup leaks into them. This observer re-renders the content of any transclusion whose source
 *       contains CriticMarkup from the note's original text (suggestions rejected, comments removed).
 *       Display only: no file is ever written.
 */
export function registerOriginalTextEmbeds(plugin: CommentatorPlugin): void {
	let frame: number | null = null;
	const in_flight = new WeakSet<HTMLElement>();

	const scan = async () => {
		for (const embed of Array.from(document.body.querySelectorAll<HTMLElement>(EMBED_SELECTOR))) {
			if (in_flight.has(embed)) continue;
			in_flight.add(embed);
			try {
				await renderOriginal(plugin, embed);
			} catch (e) {
				console.error("Inkling: could not render transclusion as original text", e);
			} finally {
				in_flight.delete(embed);
			}
		}
	};

	const schedule = () => {
		if (frame !== null) return;
		frame = window.requestAnimationFrame(() => {
			frame = null;
			void scan();
		});
	};

	const observer = new MutationObserver(schedule);
	observer.observe(document.body, { childList: true, subtree: true });
	plugin.register(() => {
		observer.disconnect();
		if (frame !== null) window.cancelAnimationFrame(frame);
	});
	plugin.app.workspace.onLayoutReady(schedule);
}

async function renderOriginal(plugin: CommentatorPlugin, embed: HTMLElement): Promise<void> {
	const app = plugin.app;
	const content = embed.querySelector<HTMLElement>(":scope > .markdown-embed-content");
	if (!content) return;
	const host = hostPath(app, embed);
	if (!host) return;

	const src = embed.getAttribute("src") ?? "";
	const hash = src.indexOf("#");
	const linkpath = hash === -1 ? src : src.slice(0, hash);
	const subpath = hash === -1 ? "" : src.slice(hash);
	const file = linkpath ? app.metadataCache.getFirstLinkpathDest(linkpath, host) : app.vault.getFileByPath(host);
	if (!(file instanceof TFile) || file.extension !== "md") return;

	// EXPL: Lets nested transclusions resolve their links relative to this note.
	embed.dataset.inklingPath = file.path;

	const signature = `${file.path}${subpath}@${file.stat.mtime}`;
	const container = content.querySelector<HTMLElement>(".markdown-preview-sizer")
		?? content.querySelector<HTMLElement>(".markdown-preview-view")
		?? content;
	const rendered = container.querySelector<HTMLElement>(`:scope > .${RENDERED_CLASS}`);
	if (rendered?.dataset.signature === signature) return;
	if (content.dataset.inklingPlain === signature) return;

	const target = embedTarget(app, file, subpath);
	if (!target) return;
	const slice = embedSlice(await app.vault.cachedRead(file), target);
	if (!hasCriticMarkup(slice, plugin.settings)) {
		// EXPL: Leave Obsidian's own rendering untouched when there is nothing to clean.
		content.dataset.inklingPlain = signature;
		return;
	}

	const wrapper = createDiv({ cls: RENDERED_CLASS });
	wrapper.dataset.signature = signature;
	await MarkdownRenderer.render(app, toOriginalText(slice, plugin.settings), wrapper, file.path, plugin);
	container.empty();
	container.appendChild(wrapper);
}

function hostPath(app: App, embed: HTMLElement): string | null {
	const parent = embed.parentElement?.closest<HTMLElement>(".internal-embed[data-inkling-path]");
	if (parent?.dataset.inklingPath) return parent.dataset.inklingPath;
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view;
		if (view instanceof MarkdownView && view.file && view.containerEl.contains(embed)) return view.file.path;
	}
	return null;
}

function embedTarget(app: App, file: TFile, subpath: string): EmbedTarget | null {
	const cache = app.metadataCache.getFileCache(file);
	if (!subpath) return { kind: "note", frontmatter_end: cache?.frontmatterPosition?.end.offset ?? null };
	if (!cache) return null;
	const sub = resolveSubpath(cache, subpath);
	if (!sub) return null;
	if (sub.type === "heading") {
		const headings = cache.headings ?? [];
		const index = headings.findIndex(h => h.position.start.offset === sub.current.position.start.offset);
		return index === -1 ? null : { kind: "heading", headings, index };
	}
	if (sub.type === "block") {
		return {
			kind: "block",
			start: sub.block.position.start.offset,
			end: sub.block.position.end.offset,
			list_items: sub.list ? cache.listItems : undefined,
			list_line: sub.list?.position.start.line,
		};
	}
	return null;
}
```

- [ ] **Step 3: Register it in `src/main.ts`**

Add `import { registerOriginalTextEmbeds } from "./editor/renderers/embed/original-text-embeds";`. In `onload()`, directly after the `if (this.settings.post_processor) { … }` block, add:

```ts
		// EXPL: Transclusions always show the note's original text (independent of the post-processor setting).
		registerOriginalTextEmbeds(this);
```

- [ ] **Step 4: Write the manual checklist** `docs/manual-checks/transclusions.md`

```markdown
# Manual check: transclusions show original text

Create `Reviewed.md`:

    # Reviewed

    The {~~cat~>dog~~} sat on the {++red ++}mat. ^r1

    {==Important==}{>>Is this right?<<}{>>Yes.<<} findings were {--not --}confirmed.

and `Host.md`:

    ![[Reviewed]]

    ![[Reviewed#^r1]]

    ![[Reviewed#Reviewed]]

Check:

- **Reading view and Live Preview of `Host.md`:** every transclusion shows "The cat sat on the mat." and "Important findings were not confirmed." There are no braces, comment icons or highlight colours.
- **`Reviewed.md` itself:** it still shows suggestions and comments exactly as before (the editor and Reading view are unchanged).
- **Live updates:** edit `Reviewed.md` (accept the substitution). `Host.md` updates and shows "The dog sat on the mat."
- **Plain notes:** transclude a note without CriticMarkup. It renders exactly as before, including its internal links.
- **Nested transclusions:** a transclusion inside a transcluded note also shows original text.
- **Source unchanged:** `git diff` (or File recovery) shows `Reviewed.md` was never modified by viewing `Host.md`.
```

- [ ] **Step 5: Build, run the tests and commit**

Run: `bun run test && bun dprint fmt && bun run build && bun eslint src/`
Expected: tests pass, and the build and lint are clean.

```bash
git add src/editor/renderers/embed/original-text-embeds.ts src/main.ts docs/manual-checks/transclusions.md
git commit -m "feat: show transclusions as original text" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

### Task 5: Merge (release after go-ahead)

- [ ] **Step 1: Verify and merge to `main`** (no PR, per the user's preference)

```bash
cd ~/Code/personal/obsidian-inkling && bun run test && bun run build && git checkout main && git pull && git merge --no-ff feat/original-text -m "Merge feat/original-text: original-text API and clean transclusions" && bun run test && git push && git branch -d feat/original-text
```

- [ ] **Step 2: Release 0.11.0. Ask the user first.** If approved, run Inkling's own release script, `bun run scripts/release/bump-version.ts` (read it first to see its arguments). Confirm the GitHub Action publishes the 0.11.0 assets.
