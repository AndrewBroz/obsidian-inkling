# Edit-Engine Integrity (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Inkling's edit engine trustworthy — stop it relocating keystrokes, letting edits through untracked, resurrecting deleted text on reject-all, and rebuilding comment threads non-deterministically.

**Architecture:** The codebase's position predicates are all *closed* on both ends, so it cannot distinguish "beside this range" from "inside this range." Three separate user-visible bugs are that one missing distinction. Task 1 adds the vocabulary; Tasks 2–4 cash it in. Tasks 5–7 are independent defects in the same layer.

**Tech Stack:** TypeScript, CodeMirror 6, Obsidian API, Jest (via Bun), Lezer (read-only this phase), dprint, ESLint.

**Spec:** `docs/superpowers/specs/2026-07-14-edit-engine-integrity-design.md`
**Roadmap:** `docs/superpowers/specs/2026-07-14-road-to-1.0-roadmap.md`

## Global Constraints

- **Run tests with `bun run test`. NOT `bun test`.** `bun test` invokes Bun's own runner, which is not Jest and will not work. A single file: `bun run test -- tests/mark_ranges.test.ts`.
- **`main.js` and `styles.css` are gitignored build artifacts.** Never commit them.
- **CriticMarkup ranges cannot nest.** `{++a {++b++} c++}` is not representable. Any output this phase produces must be a flat sequence of ranges.
- **This is a hard fork.** Never open a PR against `Fevol/obsidian-criticmarkup`. If using `gh`, always pass `--repo AndrewBroz/obsidian-inkling`.
- **dprint reformats `docs/**/*.md` if given the chance.** Only `git add` the source and test files you actually changed. Never `git add -A`.
- **Do not weaken a test to make it pass.** If a test in `tests/` encodes the old (buggy) behaviour, this plan tells you explicitly which expectation to change and why. If a test you were not told about starts failing, that is a real regression — stop and report it.
- **Commit messages containing backticks break the shell.** Use `git commit -F <file>` with a heredoc, as shown in each task.
- The five range types are `{++addition++}`, `{--deletion--}`, `{~~old~>new~~}`, `{==highlight==}`, `{>>comment<<}`. A range's `from`/`to` span the **entire markup including brackets**. Content starts at `from + 3` (or after the `@@` metadata terminator).

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/editor/base/ranges/base_range.ts` | Per-range position predicates. Gains `interior`, `overlaps`; `partially_in_range` → `adjoins`, `cursor_inside` → `interior_or_edge`. | 1 |
| `src/editor/base/ranges/grouped_range.ts` | Range-collection queries. Gains `ranges_overlapping_interval`. Fix `unwrap_in_range`'s full-coverage-only retraction. | 1, 6 |
| `src/editor/base/edit-logic/mark.ts` | The split/merge engine. Uses the strict query; splits highlights. | 2, 3 |
| `src/editor/base/edit-logic/add-comment.ts` | Drops its two hand-rolled strict predicates. | 1 |
| `src/editor/base/edit-util/range-state.ts` | Thread reconstruction. Deterministic anchor choice. | 4 |
| `src/editor/uix/extensions/editing-modes/tracked-edit.ts` | **NEW.** The single shared denylist. | 5 |
| `src/editor/uix/extensions/editing-modes/{suggestion,edit,comment}-mode.ts` | Call the shared denylist instead of three copied allowlists. | 5 |
| `src/editor/renderers/gutters/base.ts` | Focus a newly-attached gutter marker (post-`insertBefore`). | 7 |
| `src/editor/renderers/gutters/annotations-gutter/{pending-marker,marker,annotation-gutter}.ts` | Opt into post-attach focus; guard the `offsetTop` read. | 7 |

---

## Task 1: Honest position predicates

The foundation. **Behaviour-preserving on its own** — it adds vocabulary and renames the misleading predicates. Tasks 2 and 4 cash it in.

**Files:**
- Modify: `src/editor/base/ranges/base_range.ts:209-249`
- Modify: `src/editor/base/ranges/grouped_range.ts:74-76`
- Modify: `src/editor/base/edit-logic/add-comment.ts:172`, `:202-203`
- Modify (rename call sites only): `src/editor/base/ranges/base_range.ts:280`, `src/editor/base/edit-handler/cursor.ts:28,39`, `src/editor/renderers/post-process/renderer.ts:73`
- Test: `tests/range_predicates.test.ts` (NEW)

`markup-renderer.ts:145` calls `partially_in_full_range`, which is **not** renamed — leave it alone.

**Interfaces:**
- Produces: `CriticMarkupRange.interior(p: number): boolean`, `CriticMarkupRange.overlaps(start: number, end: number): boolean`, `CriticMarkupRanges.ranges_overlapping_interval(start: number, end: number): CriticMarkupRange[]`. Tasks 2, 3, 4 and 6 consume these.
- Produces: `CriticMarkupRange.adjoins` (was `partially_in_range`), `CriticMarkupRange.interior_or_edge` (was `cursor_inside`) — same bodies, honest names.

- [ ] **Step 1: Write the failing test**

Create `tests/range_predicates.test.ts`:

```ts
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import { CriticMarkupRanges } from "../src/editor/base/ranges";
import { DEFAULT_SETTINGS } from "../src/constants";

// EXPL: These pin the ONE distinction the codebase never had: "beside a range" vs "inside a range".
//       Every predicate used to be closed on both ends, so a cursor touching a range's edge was
//       reported as being INSIDE it. That single lie produced the teleporting keystroke (mark.ts),
//       the comment-draft eligibility flip (add-comment.ts), and thread duplication (range-state.ts).
function rangesOf(doc: string) {
	return new CriticMarkupRanges(getRangesInText(doc, { ...DEFAULT_SETTINGS, enable_metadata: false }));
}

describe("interior vs. the edges", () => {
	//  {  =  =  h  =  =  }
	//  0  1  2  3  4  5  6  7   <- `to` is 7
	const doc = "{==h==}rest";
	const range = () => rangesOf(doc).ranges[0]!;

	test("a position at the range's own `from` is NOT interior — it is beside it", () => {
		expect(range().interior(0)).toBe(false);
		expect(range().touches(0)).toBe(true);
	});

	test("a position at the range's own `to` is NOT interior — it is beside it", () => {
		expect(range().interior(7)).toBe(false);
		expect(range().touches(7)).toBe(true);
	});

	test("a position strictly between the brackets IS interior", () => {
		expect(range().interior(3)).toBe(true); // on the content char 'h'
		expect(range().interior(1)).toBe(true); // inside the opening bracket
	});
});

describe("overlaps: sharing a character, not merely abutting", () => {
	const doc = "{==h==}rest";
	const range = () => rangesOf(doc).ranges[0]!;

	test("an interval that merely abuts the range's start does NOT overlap it", () => {
		expect(range().overlaps(0, 0)).toBe(false);
	});

	test("an interval that merely abuts the range's end does NOT overlap it", () => {
		expect(range().overlaps(7, 9)).toBe(false);
	});

	test("an interval sharing at least one character DOES overlap", () => {
		expect(range().overlaps(0, 1)).toBe(true);
		expect(range().overlaps(6, 9)).toBe(true);
	});

	test("a zero-width interval degenerates to `interior`", () => {
		// This equivalence is load-bearing: a keystroke is a zero-width insertion, and
		// `ranges_overlapping_interval(p, p)` is how mark_ranges asks "am I inside anything?"
		for (const p of [0, 1, 3, 6, 7, 8]) {
			expect(range().overlaps(p, p)).toBe(range().interior(p));
		}
	});
});

describe("ranges_overlapping_interval excludes merely-touching ranges", () => {
	test("a keystroke at position 0, before a highlight that starts at 0, is inside nothing", () => {
		const ranges = rangesOf("{==h==}rest");
		expect(ranges.ranges_in_interval(0, 0)).toHaveLength(1); // the OLD, closed query still sees it
		expect(ranges.ranges_overlapping_interval(0, 0)).toHaveLength(0); // the honest one does not
	});

	test("a keystroke strictly inside the highlight IS inside it", () => {
		const ranges = rangesOf("{==here==}");
		expect(ranges.ranges_overlapping_interval(4, 4)).toHaveLength(1);
	});

	test("an anchor ending exactly where a comment begins does not overlap it", () => {
		//  {==x==}{>>note<<}   — the comment begins exactly where the highlight ends (position 7)
		const ranges = rangesOf("{==x==}{>>note<<}");
		const comment = ranges.ranges[1]!;
		expect(ranges.ranges_overlapping_interval(comment.from, comment.from)).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- tests/range_predicates.test.ts`
Expected: FAIL — `range().interior is not a function`, `ranges.ranges_overlapping_interval is not a function`.

- [ ] **Step 3: Add the two new predicates to `CriticMarkupRange`**

In `src/editor/base/ranges/base_range.ts`, replace lines 209-212 and 239-241.

Replace this:

```ts
	partially_in_range(start: number, end: number) {
		// return this.from < end && start < this.to;
		return !(start > this.to || end < this.from);
	}
```

with this:

```ts
	/**
	 * The position lies strictly between this range's outer brackets: an edit here lands INSIDE the
	 * markup. A position at either edge is BESIDE the range, not in it — use `touches` for that.
	 */
	interior(p: number) {
		return this.from < p && p < this.to;
	}

	/**
	 * This range and [start, end) share at least one character. A range that merely ABUTS the
	 * interval — ends exactly at `start`, or begins exactly at `end` — does NOT overlap it.
	 *
	 * Degenerates correctly for a zero-width interval (a keystroke): `overlaps(p, p) === interior(p)`.
	 */
	overlaps(start: number, end: number) {
		return this.from < end && start < this.to;
	}

	/**
	 * Shares a character with [start, end) OR merely abuts it. This is the CLOSED test — a range
	 * touching the interval's edge matches. Prefer `overlaps` unless you specifically want the
	 * abutting range too.
	 */
	adjoins(start: number, end: number) {
		return !(start > this.to || end < this.from);
	}
```

Then replace this:

```ts
	cursor_inside(cursor: number) {
		return this.from <= cursor && cursor <= this.to;
	}
```

with this:

```ts
	/**
	 * The cursor is inside this range OR sitting on one of its edges. The CLOSED test. Prefer
	 * `interior` unless you specifically mean to include the edges.
	 */
	interior_or_edge(cursor: number) {
		return this.from <= cursor && cursor <= this.to;
	}
```

Leave `touches`, `partially_in_full_range`, `encloses_range`, `cursor_before_range` and `cursor_after_range` exactly as they are.

- [ ] **Step 4: Add the strict collection query**

In `src/editor/base/ranges/grouped_range.ts`, after `ranges_in_interval` (line 74-76), add:

```ts
	/**
	 * Ranges sharing at least one character with [start, end). Excludes ranges that merely abut it.
	 *
	 * The interval tree cannot answer this: `@flatten-js/interval-tree`'s `not_intersect` uses a
	 * strict `<`, so it reports two intervals that merely TOUCH as intersecting. The tree is still a
	 * correct superset index, so search it and then apply the honest test to its results.
	 */
	ranges_overlapping_interval(start: number, end: number): CriticMarkupRange[] {
		return (this.tree.search([start, end]) as CriticMarkupRange[])
			.filter(range => range.overlaps(start, end));
	}
```

Leave `ranges_in_interval` in place — several callers legitimately want the closed semantics (e.g. `alter-suggestion.ts` accepting every range in a region). Add a doc comment above it:

```ts
	/** CLOSED: also returns ranges that merely ABUT [start, end]. See `ranges_overlapping_interval`. */
```

- [ ] **Step 5: Rename the four call sites of the renamed predicates**

`cursor_inside` → `interior_or_edge`:
- `src/editor/base/ranges/base_range.ts:280`
- `src/editor/base/edit-handler/cursor.ts:28`
- `src/editor/base/edit-handler/cursor.ts:39`

`partially_in_range` → `adjoins`:
- `src/editor/renderers/post-process/renderer.ts:73`

Do **not** change behaviour at these sites — the bodies are unchanged, only the names.

- [ ] **Step 6: Delete the two hand-rolled strict predicates in `add-comment.ts`**

These exist only because the shared predicate lied. They are the bug's own confession.

At `src/editor/base/edit-logic/add-comment.ts:172`, replace:

```ts
	const covering = ranges.ranges_in_interval(pos, pos).find(range => range.from < pos && pos < range.to);
```

with:

```ts
	const covering = ranges.ranges_overlapping_interval(pos, pos)[0];
```

At `src/editor/base/edit-logic/add-comment.ts:202-203`, replace the whole `if` (including its preceding `EXPL:` comment block, which explains why the shared predicate was wrong — that reason no longer exists):

```ts
	if (ranges.ranges_in_interval(draft.from, draft.to).some(range => range.from < draft.to && draft.from < range.to))
		return "the selected text now contains tracked changes or comments";
```

with:

```ts
	if (ranges.ranges_overlapping_interval(draft.from, draft.to).length)
		return "the selected text now contains tracked changes or comments";
```

Leave `add-comment.ts:41` (the draft-OPEN eligibility check) on `ranges_in_interval` **for now** — Task 2 changes it, and changing it here would make this task's "no behaviour change" property false.

- [ ] **Step 7: Run the new test and the full suite**

Run: `bun run test -- tests/range_predicates.test.ts`
Expected: PASS — all 10 new tests.

Run: `bun run test`
Expected: PASS. The suite was 1281 passing across 27 suites before this task; expect 28 suites now. **If any pre-existing test fails, stop and report it** — this task is behaviour-preserving, so a failure means a rename hit a call site that actually needed the other semantics. That is a finding, not a nuisance: report which site and what it was really asking.

- [ ] **Step 8: Commit**

```bash
git add src/editor/base/ranges/base_range.ts src/editor/base/ranges/grouped_range.ts \
        src/editor/base/edit-logic/add-comment.ts src/editor/base/edit-handler/cursor.ts \
        src/editor/renderers/post-process/renderer.ts tests/range_predicates.test.ts
cat > /tmp/msg.txt <<'EOF'
refactor(ranges): give the code a word for "beside" as distinct from "inside"

Every position predicate was closed on both ends, so a cursor touching a
range's edge was reported as being inside it. Callers that needed the
strict answer could not get it: add-comment.ts hand-rolled the test inline,
twice, with a comment explaining why the shared predicate was wrong.

Adds interior() and overlaps(); renames the closed predicates to say what
they actually do (adjoins, interior_or_edge). No behaviour change --
this is the vocabulary the next three commits spend.
EOF
git commit -F /tmp/msg.txt
```

---

## Task 2: Kill the teleporting keystroke

**Files:**
- Modify: `src/editor/base/edit-logic/mark.ts:479`
- Modify: `src/editor/base/edit-logic/add-comment.ts:41`
- Modify: `src/editor/uix/extensions/comment-pill.ts:49`
- Test: `tests/mark_ranges.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `CriticMarkupRanges.ranges_overlapping_interval` (Task 1).

- [ ] **Step 1: Write the failing test**

Append to `tests/mark_ranges.test.ts`. Use the file's existing `mark(...)` helper (it wraps `mark_ranges` and applies the resulting changes to the text — read the top of the file for its exact signature before writing).

```ts
describe("edges: a keystroke beside a range is not a keystroke inside it", () => {
	// EXPL: THE TELEPORTING KEYSTROKE. Typing at position 0, immediately before a highlight that
	//       begins at position 0, used to relocate the character to the FAR SIDE of the highlight:
	//       "{==h==}rest" + "x" gave "{==h==}{++x++}rest".
	//
	//       Cause: mark_ranges asked ranges_in_interval(0, 0), whose closed-interval search returns
	//       the highlight (it TOUCHES 0). The ignore-loop then treated the highlight as an atomic
	//       island: its guard `if (last_range_start < range.from)` was `0 < 0` — false — so it
	//       emitted no edit for "before the range", then set last_range_start = range.to, jumping
	//       the insertion point clean past the highlight.
	test("typing immediately BEFORE a highlight inserts before it, not after it", () => {
		expect(mark("{==h==}rest", 0, 0, "x", SuggestionType.ADDITION)).toBe("{++x++}{==h==}rest");
	});

	test("typing immediately AFTER a highlight inserts after it", () => {
		expect(mark("rest{==h==}", 11, 11, "x", SuggestionType.ADDITION)).toBe("rest{==h==}{++x++}");
	});

	test("typing immediately BEFORE a comment inserts before it", () => {
		expect(mark("{>>c<<}rest", 0, 0, "x", SuggestionType.ADDITION)).toBe("{++x++}{>>c<<}rest");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- tests/mark_ranges.test.ts`
Expected: FAIL. The first test receives `"{==h==}{++x++}rest"` — the character teleported past the highlight. That failure message *is* the bug.

- [ ] **Step 3: Switch `mark_ranges` to the honest query**

In `src/editor/base/edit-logic/mark.ts`, change line 479:

```ts
	const in_range = ranges.ranges_in_interval(from, to);
```

to:

```ts
	// EXPL: STRICT. A range that merely ABUTS this operation is beside it, not in it. The closed
	//       query returned a highlight starting exactly at `from`, which the ignore-loop below then
	//       jumped the whole operation past — silently relocating the user's keystroke.
	const in_range = ranges.ranges_overlapping_interval(from, to);
```

Change nothing else in this function. The bracket-snapping at lines 483-486 still works: a *selection* whose edge lands inside a bracket genuinely overlaps the range (positive-width intersection), so `left_range`/`right_range` are still found. Only the zero-width-at-the-boundary case changes, and there snapping was wrong anyway.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- tests/mark_ranges.test.ts`
Expected: the three new tests PASS.

The existing test `"KNOWN RESIDUAL: partial coverage of an addition still folds the covered slice"` must **still pass unchanged** — Task 6 owns that one. If it broke here, stop and report.

- [ ] **Step 5: Align the two comment-anchor eligibility checks**

Both of these ask "does my selection touch existing markup?" and both should now use the strict answer, so that a selection abutting a range can still be cleanly wrapped (it can — `{==sel==}` placed against a neighbouring range's edge is perfectly valid).

`src/editor/base/edit-logic/add-comment.ts:41`:

```ts
		if (ranges.ranges_in_interval(selection.from, selection.to).length === 0) {
```
becomes
```ts
		if (ranges.ranges_overlapping_interval(selection.from, selection.to).length === 0) {
```

`src/editor/uix/extensions/comment-pill.ts:49`:

```ts
	return ranges.ranges_in_interval(selection.from, selection.to).length === 0;
```
becomes
```ts
	return ranges.ranges_overlapping_interval(selection.from, selection.to).length === 0;
```

This closes the eligibility flip: the draft-open check (`:41`) and the draft-commit check (`:202`, fixed in Task 1) now use the same predicate, so a draft can no longer be eligible at open and ineligible at commit.

- [ ] **Step 6: Run the full suite**

Run: `bun run test`
Expected: PASS.

`tests/comment_pill.test.ts` and `tests/add_comment.test.ts` contain tests asserting the pill is hidden for "overlapping" selections. Re-read each failure carefully: if a test selects text that merely **abuts** a range and asserts the pill is hidden, that expectation encoded the bug — the pill *should* now appear, because such a selection wraps perfectly well. Update it and note why in the test. If a test selects text that genuinely **shares characters** with a range and the pill now appears, that is a real regression — stop and report.

- [ ] **Step 7: Commit**

```bash
git add src/editor/base/edit-logic/mark.ts src/editor/base/edit-logic/add-comment.ts \
        src/editor/uix/extensions/comment-pill.ts tests/mark_ranges.test.ts \
        tests/comment_pill.test.ts tests/add_comment.test.ts
cat > /tmp/msg.txt <<'EOF'
fix(mark): typing beside a highlight no longer teleports the character past it

Typing at position 0, immediately before a highlight beginning at position 0,
relocated the character to the far side of the highlight. mark_ranges asked a
closed-interval query, which returned the highlight because it TOUCHES that
position; the ignore-loop then treated it as an atomic island and jumped the
insertion point past it.

Also aligns the comment-draft eligibility checks at open and at commit onto the
same predicate, so a draft can no longer be eligible when opened and ineligible
when submitted.
EOF
git commit -F /tmp/msg.txt
```

---

## Task 3: Typing inside a highlight splits it

With Task 2 done, the *edge* teleport is gone but the *interior* one remains: the highlight is now correctly returned by the strict query, but `should_ignore_range` still treats it as incompatible and the ignore-loop still jumps past it.

**Files:**
- Modify: `src/editor/base/edit-logic/mark.ts:492-503` (the ignore-loop)
- Test: `tests/mark_ranges.test.ts`

**Interfaces:**
- Consumes: `CriticMarkupRange.split_range(cursor): [string, string]` — already exists at `base_range.ts:343`. Returns `[closing_affix, opening_affix]`: for a highlight, `["==}", "{=="]`, with the metadata block re-emitted on the opening affix if the range had one.

- [ ] **Step 1: Write the failing test**

Append to `tests/mark_ranges.test.ts`:

```ts
describe("interior: an edit inside a highlight splits it", () => {
	//  {  =  =  h  e  r  e  =  =  }
	//  0  1  2  3  4  5  6  7  8  9   <- `to` is 10; content "here" is 3..7
	//
	// EXPL: CriticMarkup cannot nest, so a tracked change inside a highlight has nowhere to live.
	//       The old code teleported it out of the highlight's far side. Splitting keeps BOTH the
	//       highlight and the tracked change, losslessly, in valid CriticMarkup.
	//       Phase 2's overlap dialect expresses this properly as {==#a1 h{++x++}ere==#a1}.
	test("typing inside a highlight splits it around the addition", () => {
		expect(mark("{==here==}", 4, 4, "x", SuggestionType.ADDITION)).toBe("{==h==}{++x++}{==ere==}");
	});

	test("typing at the very start of a highlight's CONTENT does not split — nothing is left of it", () => {
		// position 3 is the first content char; the left half would be empty, so emit no empty range
		expect(mark("{==here==}", 3, 3, "x", SuggestionType.ADDITION)).toBe("{++x++}{==here==}");
	});

	test("typing at the very end of a highlight's CONTENT does not split — nothing is right of it", () => {
		expect(mark("{==here==}", 7, 7, "x", SuggestionType.ADDITION)).toBe("{==here==}{++x++}");
	});

	test("deleting inside a highlight splits it around the deletion", () => {
		// delete "er" (content offsets 4..6)
		expect(mark("{==here==}", 4, 6, "", SuggestionType.DELETION)).toBe("{==h==}{--er--}{==e==}");
	});

	test("a comment is NOT split — typing inside one edits the comment's prose", () => {
		// A comment's body is prose, not document text. Editing it is editing the comment.
		expect(mark("{>>note<<}", 5, 5, "x", SuggestionType.ADDITION)).toBe("{>>nxote<<}");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- tests/mark_ranges.test.ts`
Expected: FAIL. The first test receives `"{==here==}{++x++}"` — teleported out of the interior.

- [ ] **Step 3: Split incompatible HIGHLIGHT ranges in the ignore-loop**

In `src/editor/base/edit-logic/mark.ts`, the ignore-loop currently reads:

```ts
	if (!force) {
		for (const range of in_range) {
			if (should_ignore_range(range, type, metadata_fields)) {
				if (last_range_start < range.from) {
					const adj_type = type === SuggestionType.SUBSTITUTION ? SuggestionType.DELETION : type;
					const edit = mark_range(ranges, text, last_range_start, range.from, "", adj_type, metadata_fields);
					if (edit) range_operations.push(edit!);
				}
				last_range_start = range.to;
			}
		}
	}
```

An incompatible range that the operation lands **strictly inside** must be split, not jumped over. Add that branch:

```ts
	if (!force) {
		for (const range of in_range) {
			if (should_ignore_range(range, type, metadata_fields)) {
				// EXPL: The operation lands strictly INSIDE an incompatible range. CriticMarkup cannot
				//       nest, so there is nowhere for the tracked change to live *within* the highlight.
				//       Splitting the highlight around it keeps both, losslessly. The old code jumped
				//       last_range_start past range.to here, which silently relocated the user's edit to
				//       the far side of the highlight.
				//
				//       COMMENT is excluded on purpose: a comment's body is prose, not document text, so
				//       typing inside one is editing the comment — not making a tracked change to the note.
				if (range.type === SuggestionType.HIGHLIGHT && range.encloses_range(from, to, true)) {
					const edit = split_around(ranges, text, range, from, to, inserted, type, metadata_fields);
					if (edit) range_operations.push(...edit);
					last_range_start = range.to;
					continue;
				}
				if (last_range_start < range.from) {
					const adj_type = type === SuggestionType.SUBSTITUTION ? SuggestionType.DELETION : type;
					const edit = mark_range(ranges, text, last_range_start, range.from, "", adj_type, metadata_fields);
					if (edit) range_operations.push(edit!);
				}
				last_range_start = range.to;
			}
		}
	}
```

Note `mark_ranges` must then **not** fall through to its trailing `mark_range` call for an operation fully consumed by a split. Guard the tail:

```ts
	if (last_range_start > to)
		to = last_range_start;

	// A split consumed the whole operation; there is nothing left to mark.
	if (last_range_start >= to && range_operations.length)
		return range_operations;

	const edit = mark_range(ranges, text, last_range_start, to, inserted, type, metadata_fields);
	if (edit) range_operations.push(edit);
```

- [ ] **Step 4: Implement `split_around`**

Add above `mark_ranges` in `src/editor/base/edit-logic/mark.ts`:

```ts
/**
 * Replace an incompatible range that strictly encloses [from, to) with: its left half, the new
 * tracked range, its right half. Either half is omitted when it would be empty.
 *
 * `split_range(cursor)` returns [closing_affix, opening_affix] — for a highlight, ["==}", "{=="],
 * with any metadata block re-emitted on the opening affix.
 */
function split_around(
	ranges: CriticMarkupRanges,
	text: Text,
	range: CriticMarkupRange,
	from: number,
	to: number,
	inserted: string,
	type: MarkType,
	metadata_fields?: MetadataFields,
): EditorSuggestion[] | undefined {
	const [close_affix, open_affix] = range.split_range(from);

	const left_content = range.unwrap_slice(0, from - range.from);
	const right_content = range.unwrap_slice(to - range.from, range.to - range.from);

	const middle = mark_range(ranges, text, from, to, inserted, type, metadata_fields);
	if (!middle) return undefined;

	const left = left_content ? range.text.slice(0, 3) + left_content + close_affix : "";
	const right = right_content ? open_affix + right_content + close_affix : "";

	return [{
		from: range.from,
		to: range.to,
		insert: left + middle.insert + right,
		start: range.from + left.length + (middle.start - from),
		end: range.from + left.length + (middle.end - from),
	}];
}
```

`EditorSuggestion`'s `start`/`end` are the post-edit cursor positions; they are shifted by the length of the emitted left half. `unwrap_slice(a, b)` takes offsets **relative to the range's own text** and returns the content with brackets and metadata stripped — check its signature at `base_range.ts:196-207` and adjust the two calls above if the offsets differ from what is written here.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test -- tests/mark_ranges.test.ts`
Expected: all five new tests PASS, and every pre-existing test in the file still passes.

- [ ] **Step 6: Run the full suite**

Run: `bun run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/editor/base/edit-logic/mark.ts tests/mark_ranges.test.ts
cat > /tmp/msg.txt <<'EOF'
fix(mark): an edit inside a highlight splits it instead of escaping it

CriticMarkup cannot nest, so a tracked change inside a highlight had nowhere to
live -- and mark_ranges responded by relocating it to the far side of the
highlight. Split the highlight around the change instead: {==here==} + "x" after
the h is now {==h==}{++x++}{==ere==}. Nothing is lost and the result is valid
CriticMarkup.

Comments are deliberately not split: a comment's body is prose, so typing in one
is editing the comment, not tracking a change to the note.
EOF
git commit -F /tmp/msg.txt
```

---

## Task 4: Deterministic thread reconstruction

**Files:**
- Modify: `src/editor/base/edit-util/range-state.ts:122-148`
- Test: `tests/thread_reconstruction.test.ts` (NEW)

**Interfaces:**
- Consumes: nothing new. This is the third instance of the Task 1 disease, fixed in place.

- [ ] **Step 1: Write the failing test**

Create `tests/thread_reconstruction.test.ts`. It must build the **same document** via **different edit histories** and assert the thread structure is identical — the non-determinism is the bug, so determinism is the assertion. Drive the real `rangeParser` StateField (as `tests/focus_nesting.test.ts` does) rather than calling the reconstruction function directly; the bug only manifests through incremental edits.

```ts
import { EditorState } from "@codemirror/state";
import { rangeParser } from "../src/editor/base";
import { DEFAULT_SETTINGS } from "../src/constants";
import { providePluginSettingsExtension } from "../src/editor/uix/extensions";
import type { CommentRange } from "../src/editor/base/ranges";

// EXPL: range-state.ts asked `tree.search([head.from, head.from])[0]` for a thread's anchor. A
//       closed-interval point search returns BOTH the head comment (which begins there) and the
//       anchor before it (which ends there -- touching counts). `[0]` then picked one in
//       INTERVAL-TREE TRAVERSAL ORDER, which is not document order and which changes as the tree
//       rebalances during editing. So the same document could rebuild its threads differently on
//       different keystrokes -- and since `.replies.length = 0` cleared only whichever range it
//       happened to pick, the other kept its stale replies. That is the duplication.
function stateWith(doc: string) {
	const settings = { ...DEFAULT_SETTINGS, enable_metadata: false };
	return EditorState.create({
		doc,
		extensions: [rangeParser, providePluginSettingsExtension(<any> { settings })],
	});
}

/** A structural fingerprint of every thread in the document: base position -> reply positions. */
function threadShape(state: EditorState) {
	const ranges = state.field(rangeParser).ranges;
	return ranges.ranges
		.filter(r => r.base_range === r)
		.map(base => `${base.from}:[${base.replies.map(r => r.from).join(",")}]`)
		.sort()
		.join(" ");
}

const TARGET = "{==anchor==}{>>one<<}{>>two<<} tail";

describe("thread reconstruction is deterministic", () => {
	test("a thread parsed from scratch has the anchor as its base and both comments as replies", () => {
		const shape = threadShape(stateWith(TARGET));
		// anchor at 0; the two comments are its replies at 12 and 21
		expect(shape).toBe("0:[12,21] 33:[]".replace(" 33:[]", "")); // no other base ranges
	});

	test("the same document reached by INCREMENTAL EDITS has the identical thread shape", () => {
		// Build it up one insertion at a time — this is what rebalances the interval tree.
		let state = stateWith("{==anchor==} tail");
		state = state.update({ changes: { from: 12, to: 12, insert: "{>>one<<}" } }).state;
		state = state.update({ changes: { from: 21, to: 21, insert: "{>>two<<}" } }).state;

		expect(state.doc.toString()).toBe(TARGET);
		expect(threadShape(state)).toBe(threadShape(stateWith(TARGET)));
	});

	test("editing text near the thread does not duplicate its replies", () => {
		let state = stateWith(TARGET);
		// type into the trailing text, repeatedly — each keystroke re-runs reconstruction
		for (let i = 0; i < 8; i++)
			state = state.update({ changes: { from: state.doc.length, to: state.doc.length, insert: "x" } }).state;

		const ranges = state.field(rangeParser).ranges;
		const base = ranges.ranges.find(r => r.base_range === r)!;
		expect(base.replies).toHaveLength(2); // NOT 4, NOT 16
		expect(new Set(base.replies.map(r => r.from)).size).toBe(2); // no duplicates
	});

	test("a BARE comment thread (no anchor) has the head comment as its own base", () => {
		const state = stateWith("text {>>one<<}{>>two<<}");
		const ranges = state.field(rangeParser).ranges;
		const head = ranges.ranges[0] as CommentRange;
		expect(head.attached_comment).toBeNull();
		expect(head.replies).toHaveLength(1);
	});
});
```

Before running, verify the exact positions in `TARGET` by counting characters; correct the numbers in the first test if they are off. The *structure* of the assertions is what matters.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- tests/thread_reconstruction.test.ts`
Expected: at least one FAIL. The duplication test is the one that catches the bug most reliably; if all four pass on the first run, the tree happened to be balanced in our favour — increase the loop count in test 3 to 40 and interleave insertions *before* the thread as well as after, to force rebalancing.

- [ ] **Step 3: Make the anchor choice explicit and deterministic**

In `src/editor/base/edit-util/range-state.ts`, replace lines 141-147:

```ts
			for (const thread of comment_threads) {
				const head = thread[0];
				const adjacent_range = value.ranges.tree.search([head.from, head.from])[0] as CriticMarkupRange;
				adjacent_range!.replies.length = 0;
				for (const comment of thread.slice(adjacent_range === head ? 1 : 0))
					comment.add_reply(adjacent_range);
			}
```

with:

```ts
			for (const thread of comment_threads) {
				const head = thread[0];

				// EXPL: The anchor is the range immediately to the LEFT of the head -- the one whose `to`
				//       is the head's `from`. It is never the head itself.
				//
				//       This used to be `search([head.from, head.from])[0]`. A closed-interval point
				//       search returns BOTH the head (it begins there) and the anchor (it ends there --
				//       touching counts), and `[0]` picked one in interval-tree TRAVERSAL order, which is
				//       not document order and which shifts as the tree rebalances during editing. So the
				//       same document rebuilt its threads differently on different keystrokes, and since
				//       only the picked range's `replies` was cleared, the other kept its stale ones.
				//       That was the duplication.
				const anchor = (value.ranges.tree.search([head.from, head.from]) as CriticMarkupRange[])
					.find(range => range !== head && range.to === head.from);

				// No anchor => this is a bare thread and the head is its own base.
				const base = anchor ?? head;

				base.replies.length = 0;
				for (const comment of thread.slice(base === head ? 1 : 0))
					comment.add_reply(base);
			}
```

Delete the `FIXME: Rare cases of comment ranges in threads being duplicated due to editor changes` on line 122 — it is now fixed.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- tests/thread_reconstruction.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full suite**

Run: `bun run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/editor/base/edit-util/range-state.ts tests/thread_reconstruction.test.ts
cat > /tmp/msg.txt <<'EOF'
fix(threads): comment threads no longer duplicate their replies on edit

Thread reconstruction asked a closed-interval point search for a thread's
anchor, which returns both the anchor (it ends at that position) and the head
comment (it begins there) -- then took [0], picking one in interval-tree
traversal order. That order is not document order and it shifts as the tree
rebalances, so the same document rebuilt its threads differently on different
keystrokes; because only the picked range's replies were cleared, the other kept
its stale ones.

Choose the anchor explicitly: the range whose `to` is the head's `from`, never
the head itself. Closes the third and last instance of the closed-interval bug.
EOF
git commit -F /tmp/msg.txt
```

---

## Task 5: Suggest mode fails closed

**Files:**
- Create: `src/editor/uix/extensions/editing-modes/tracked-edit.ts`
- Modify: `src/editor/uix/extensions/editing-modes/suggestion-mode.ts:116-126`
- Modify: `src/editor/uix/extensions/editing-modes/edit-mode.ts:42`
- Modify: `src/editor/uix/extensions/editing-modes/comment-mode.ts:22-23`
- Test: `tests/tracked_edit.test.ts` (NEW)

**Interfaces:**
- Produces: `is_exempt_from_tracking(tr: Transaction): boolean` and `pluginEditAnnotation: Annotation<boolean>`, both from `src/editor/uix/extensions/editing-modes/tracked-edit.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/tracked_edit.test.ts`. The property under test is **fail-closed**: an *unknown* userEvent must be tracked. That is what pins the denylist and stops anyone reverting to an allowlist.

```ts
import { Annotation, EditorState, Transaction } from "@codemirror/state";
import { is_exempt_from_tracking, pluginEditAnnotation } from "../src/editor/uix/extensions/editing-modes/tracked-edit";

// EXPL: Suggest mode used an ALLOWLIST of userEvents (input / paste / delete). Anything unrecognised
//       passed through UNTRACKED, silently -- which is how a dragged selection ("move.drop", see
//       @codemirror/view dropText) and image paste escaped a mode whose entire promise is that every
//       edit is tracked. The same list was copied into three files and was correct in only one of
//       them (comment-mode.ts alone included "move").
//
//       These tests pin the INVERSION: unknown means tracked.
function txWith(userEvent?: string, annotate?: Annotation<any>) {
	const state = EditorState.create({ doc: "hello" });
	return state.update({
		changes: { from: 5, to: 5, insert: "!" },
		userEvent,
		annotations: annotate ? [annotate] : undefined,
	});
}

describe("tracked edits fail CLOSED", () => {
	test("a dragged selection (move.drop) is tracked", () => {
		expect(is_exempt_from_tracking(txWith("move.drop"))).toBe(false);
	});

	test("an edit with NO userEvent at all is tracked (image paste)", () => {
		expect(is_exempt_from_tracking(txWith(undefined))).toBe(false);
	});

	test("an edit with a userEvent nobody has ever heard of is tracked", () => {
		// The whole point. A future Obsidian or plugin edit path must not be silently exempt.
		expect(is_exempt_from_tracking(txWith("some.future.event"))).toBe(false);
	});

	test("the ordinary events are still tracked", () => {
		for (const e of ["input.type", "input.paste", "delete.backward", "input.drop"])
			expect(is_exempt_from_tracking(txWith(e))).toBe(false);
	});
});

describe("the denylist exempts only what it must", () => {
	test("undo is exempt", () => {
		expect(is_exempt_from_tracking(txWith("undo"))).toBe(true);
	});

	test("redo is exempt", () => {
		expect(is_exempt_from_tracking(txWith("redo"))).toBe(true);
	});

	test("our own transactions are exempt, so the filter cannot recurse", () => {
		expect(is_exempt_from_tracking(txWith("input.type", pluginEditAnnotation.of(true)))).toBe(true);
	});

	test("a remote (collaborative) change is exempt", () => {
		expect(is_exempt_from_tracking(txWith("input.type", Transaction.remote.of(true)))).toBe(true);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- tests/tracked_edit.test.ts`
Expected: FAIL — cannot resolve `src/editor/uix/extensions/editing-modes/tracked-edit`.

- [ ] **Step 3: Create the shared denylist**

Create `src/editor/uix/extensions/editing-modes/tracked-edit.ts`:

```ts
import { Annotation, Transaction } from "@codemirror/state";

/**
 * Marks a transaction as originating from Inkling itself. The editing-mode transaction filters must
 * not re-process their own output, or they recurse.
 */
export const pluginEditAnnotation = Annotation.define<boolean>();

/**
 * Is this doc-changing transaction exempt from suggestion/edit/comment tracking?
 *
 * This is a DENYLIST on purpose. The three editing modes each used to carry their own ALLOWLIST of
 * userEvents, and an edit matching none of them passed through UNTRACKED -- silently. That is how a
 * dragged selection (`move.drop`, see @codemirror/view's dropText) and image paste (routed through
 * Obsidian's own file handling, so carrying no userEvent at all) escaped Suggest mode, whose entire
 * promise is that every edit is tracked.
 *
 * The three copies of that allowlist were not even in agreement: comment-mode.ts alone included
 * "move". Adding "move" to the other two would have fixed today's symptom and left the mechanism --
 * a fourth copy would be the next bug.
 *
 * So: anything we do not recognise is TRACKED, not exempted. Only these four things are exempt.
 */
export function is_exempt_from_tracking(tr: Transaction): boolean {
	return tr.isUserEvent("undo") ||
		tr.isUserEvent("redo") ||
		tr.annotation(Transaction.remote) === true ||
		tr.annotation(pluginEditAnnotation) === true;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- tests/tracked_edit.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Call it from all three editing modes**

`src/editor/uix/extensions/editing-modes/suggestion-mode.ts` — replace lines 116-126:

```ts
		const is_recognized_edit_operation = tr.isUserEvent("input") || tr.isUserEvent("paste") ||
			tr.isUserEvent("delete");

		// ISSUE: Pasting an image yields no userEvent that could be used to determine the type, so the
		//      operation type needs to be determined via the changed ranges. However, a change of the state
		//      *will* result in the new transaction being filtered through the suggestion mode filter again (recursion)
		// TODO: Currently, a only transactions with valid userEvents editevents considered
		//       Somehow, someway, image pastes need to get an userevent attached (monkey-around insertFiles?)
		// TODO: Dragging and dropping a selection also doesn't seem to fire a userEvent
		if (!is_recognized_edit_operation)
			return tr;
```

with:

```ts
		if (is_exempt_from_tracking(tr))
			return tr;
```

Add the import. Delete the three stale comments — `move.drop` *does* fire a userEvent, so the `TODO` at the old line 124 was simply wrong, and the recursion concern is now handled by `pluginEditAnnotation`.

`src/editor/uix/extensions/editing-modes/edit-mode.ts:42` — replace:

```ts
		if (!(tr.isUserEvent("input") || tr.isUserEvent("paste") || tr.isUserEvent("delete")))
```
with:
```ts
		if (is_exempt_from_tracking(tr))
```
(note the inverted sense — the old check bailed when *not* recognised; the new one bails when exempt).

`src/editor/uix/extensions/editing-modes/comment-mode.ts:22-23` — replace:

```ts
			!(tr.isUserEvent("input") || tr.isUserEvent("delete") ||
				tr.isUserEvent("paste") || tr.isUserEvent("move"))
```
with:
```ts
			is_exempt_from_tracking(tr)
```
Its existing `if (tr.annotation(commentModeAnnotation))` guard on line 17 stays — that is a different, mode-specific concern.

- [ ] **Step 6: Annotate the plugin's own transactions**

Every transaction the editing-mode filters *produce* must carry `pluginEditAnnotation.of(true)`, or the filter will re-process its own output. In `suggestion-mode.ts` and `edit-mode.ts`, find where the filter returns its rewritten `TransactionSpec` (search for `return {` with a `changes:` key near the end of the filter) and add to it:

```ts
			annotations: [pluginEditAnnotation.of(true)],
```

If the spec already has an `annotations` array, append to it rather than replacing it.

- [ ] **Step 7: Verify no infinite recursion**

Run: `bun run test`
Expected: PASS. A recursion bug here manifests as a hang or a stack overflow, not a quiet failure — if the suite hangs, `pluginEditAnnotation` is not being attached to the filter's own output. Fix Step 6 rather than reverting.

- [ ] **Step 8: Commit**

```bash
git add src/editor/uix/extensions/editing-modes/ tests/tracked_edit.test.ts
cat > /tmp/msg.txt <<'EOF'
fix(modes): suggestion mode tracks every edit, not an allowlist of them

The three editing modes each carried their own allowlist of CodeMirror
userEvents, and an edit matching none of them passed through UNTRACKED --
silently. That is how a dragged selection and an image paste escaped Suggest
mode, whose entire promise is that every edit is tracked.

The upstream comment blamed drag-and-drop for firing no userEvent. It does fire
one: @codemirror/view's dropText sends "move.drop" for an in-editor move. Nobody
had allowlisted it -- except comment-mode.ts, which was the one of the three
copies that happened to include "move".

Replaces all three copies with one denylist. Anything we do not recognise is now
tracked, not exempted.
EOF
git commit -F /tmp/msg.txt
```

---

## Task 6: Partial coverage of a pending addition retracts

**Files:**
- Modify: `src/editor/base/ranges/grouped_range.ts:127-139`
- Modify: `tests/mark_ranges.test.ts:120-129` (replace the `KNOWN RESIDUAL` test)

**Interfaces:**
- Consumes: `CriticMarkupRange.overlaps` (Task 1).

- [ ] **Step 1: Replace the `KNOWN RESIDUAL` test with the correct expectation**

`tests/mark_ranges.test.ts` currently contains, at lines 120-129, a test that **encodes the bug**:

```ts
// BUG: Partial coverage of a pending addition still folds the covered slice —
//      reject-all resurrects it ("abcef" instead of "abef"). Full-coverage retraction
//      only, by design of the Phase 3A fix; scheduled for a later phase.
//      Do NOT "fix" this expectation without implementing partial-coverage retraction.
test("KNOWN RESIDUAL: partial coverage of an addition still folds the covered slice", () => {
	const output = mark("ab{++cd++}ef", 0, 6, "", SuggestionType.DELETION);
	expect(output).toBe("{~~abc~>d~~}ef");
	expect(reject_all(output)).toBe("abcef"); // ideal would be "abef"
});
```

This is the later phase. Delete that test entirely and put this in its place:

```ts
describe("partial coverage of a pending addition RETRACTS it", () => {
	// EXPL: "{++cd++}" means c and d were never in the base document -- they are pending. Deleting
	//       across part of that addition used to FOLD the covered slice into the deletion's old-text,
	//       so reject-all resurrected a character that never existed.
	//
	//       reject_all is the oracle here: rejecting everything must return the BASE document, and the
	//       base document never contained "c".
	test("deleting across the front of an addition drops the covered slice", () => {
		//        a b { + + c d + + } e f
		//        0 1 2 3 4 5 6 7 8 9
		// delete [0, 6) -- that is "ab" plus the addition's "c"
		const output = mark("ab{++cd++}ef", 0, 6, "", SuggestionType.DELETION);
		expect(output).toBe("{--ab--}{++d++}ef");
		expect(reject_all(output)).toBe("abef"); // "ab" restored, "d" dropped, "c" GONE
		expect(accept_all(output)).toBe("def"); // "ab" deleted, "d" kept
	});

	test("deleting across the back of an addition drops the covered slice", () => {
		// delete from inside the addition (after "c") through "ef"
		const output = mark("ab{++cd++}ef", 6, 12, "", SuggestionType.DELETION);
		expect(output).toBe("ab{++c++}{--ef--}");
		expect(reject_all(output)).toBe("abef");
		expect(accept_all(output)).toBe("abc");
	});

	test("FULL coverage still retracts (no regression)", () => {
		const output = mark("ab{++cd++}ef", 2, 10, "", SuggestionType.DELETION);
		expect(reject_all(output)).toBe("abef");
		expect(accept_all(output)).toBe("abef");
	});

	test("a substitution's inserted half is a pending addition too", () => {
		// {~~old~>new~~}: "new" is pending, "old" is base. Deleting across part of "new" must not
		// resurrect it on reject.
		const output = mark("x{~~old~>new~~}y", 0, 12, "", SuggestionType.DELETION);
		expect(reject_all(output)).toBe("xoldy");
	});
});
```

Verify `reject_all` and `accept_all` are imported at the top of `tests/mark_ranges.test.ts` — the deleted test used `reject_all`, so it is already there; add `accept_all` if missing. Verify the character offsets by counting; correct them if they are off, but **do not change the expected `reject_all` values** — those are the invariant.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- tests/mark_ranges.test.ts`
Expected: FAIL. The first test receives `"{~~abc~>d~~}ef"`, whose `reject_all` is `"abcef"` — the resurrected `c`.

- [ ] **Step 3: Retract on ANY coverage, not only full coverage**

In `src/editor/base/ranges/grouped_range.ts`, `unwrap_in_range` currently guards retraction on **full** coverage:

```ts
			if (drop_pending_additions && from <= range.from && range.to <= to) {
				// EXPL: A pending addition consumed by a deletion/substitution mark is a retracted
				//       suggestion — its text was never in the base document, so folding it into
				//       the new range would make reject-all resurrect it.
				if (range.type === SuggestionType.ADDITION) {
					// contributes nothing
				} else if (range.type === SuggestionType.SUBSTITUTION)
					output += range.unwrap_parts()[0];
				else
					output += range.unwrap_slice(Math.max(0, from), to);
			} else {
				output += range.unwrap_slice(Math.max(0, from), to);
			}
```

`from <= range.from && range.to <= to` is the full-coverage test. Partial coverage falls to the `else`, which folds the covered slice of the addition into the output — and that output becomes the new deletion's old-text. Replace the whole block with:

```ts
			if (drop_pending_additions && range.overlaps(from, to)) {
				// EXPL: A pending addition consumed by a deletion/substitution mark is a RETRACTED
				//       suggestion — its text was never in the base document, so folding it into the new
				//       range would make reject-all resurrect it.
				//
				//       This used to require FULL coverage (`from <= range.from && range.to <= to`), so a
				//       partial deletion across an addition folded the covered slice in and reject-all
				//       brought back a character the user had never committed. Any overlap retracts now;
				//       the UNCOVERED remainder survives as an addition via mark_range's split affixes.
				if (range.type === SuggestionType.ADDITION) {
					// contributes nothing — the covered slice is retracted
				} else if (range.type === SuggestionType.SUBSTITUTION) {
					// only the base ("old") half was ever in the document; the inserted half is pending
					output += range.unwrap_parts()[0];
				} else {
					output += range.unwrap_slice(Math.max(0, from), to);
				}
			} else {
				output += range.unwrap_slice(Math.max(0, from), to);
			}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- tests/mark_ranges.test.ts`
Expected: the four new tests PASS.

If `mark_range`'s split affixes do not preserve the uncovered remainder as its own `{++d++}` range, the *output string* assertions will fail even though the `reject_all` invariant holds. In that case the affix construction in `split_left_range` / `split_right_range` (`mark.ts:127-173`) needs the retracted slice's length subtracted from its offsets. **The `reject_all` / `accept_all` expectations are the contract; the exact output string is negotiable** — if you must change an expected output string, prove the invariants still hold and say so in the commit message.

- [ ] **Step 5: Run the full suite**

Run: `bun run test`
Expected: PASS. The `"marking over pending additions consumes them (reject-all safety)"` block (`tests/mark_ranges.test.ts:65-119`) covers full coverage and must not regress.

- [ ] **Step 6: Commit**

```bash
git add src/editor/base/ranges/grouped_range.ts tests/mark_ranges.test.ts
cat > /tmp/msg.txt <<'EOF'
fix(ranges): deleting across part of a pending addition retracts the covered slice

Text inside {++...++} was never in the base document. Deleting across only PART
of an addition folded the covered slice into the deletion's old-text, so
reject-all resurrected a character the user had never committed:

  "ab{++cd++}ef", delete [0,6)  ->  "{~~abc~>d~~}ef"
  reject_all                    ->  "abcef"     <- the "c" never existed

Retraction required full coverage; it now happens on any overlap. reject_all is
the oracle: rejecting everything must return the base document.

  now: "{--ab--}{++d++}ef"  ->  reject_all "abef", accept_all "def"

Replaces the KNOWN RESIDUAL test that encoded the old behaviour.
EOF
git commit -F /tmp/msg.txt
```

---

## Task 7: Pill click focuses the draft; the draft card stops crashing

**Files:**
- Modify: `src/editor/renderers/gutters/base.ts:164-216` (`GutterElement.setMarkers`)
- Modify: `src/editor/renderers/gutters/annotations-gutter/pending-marker.ts:51-104`
- Modify: `src/editor/renderers/gutters/annotations-gutter/marker.ts:470-503, 612-620`
- Modify: `src/editor/renderers/gutters/annotations-gutter/annotation-gutter.ts:219`
- Modify: `src/ui/embeddable-editor.ts:251-255`
- Test: `tests/pending_card.test.ts` (extend the existing file)

**Interfaces:**
- Produces: an optional `afterAttach(dom: HTMLElement): void` method on `GutterMarker` subclasses, called by `GutterElement.setMarkers` **after** `insertBefore`.

- [ ] **Step 1: Write the failing test**

Extend `tests/pending_card.test.ts`. The bug is a *timing* bug, so assert on `isConnected` at focus time — that is what actually differs.

```ts
// EXPL: THE PILL-FOCUS BUG. `.focus()` was called inside PendingAnnotationMarker.toDOM(), on the
//       node toDOM() is in the middle of building. But toDOM()'s RETURN VALUE is exactly what
//       GutterElement.setMarkers passes to insertBefore -- so nothing inside toDOM() can ever run
//       after attachment, and HTMLElement.focus() on a disconnected node is a SILENT no-op per the
//       HTML spec. No throw, no warning, activeElement simply does not move.
//
//       (This is why clicking an EXISTING card worked: that path runs in a live click handler on an
//       already-attached node.)
test("the pending card's reply box is focused only once it is attached to the document", () => {
	const focused_while: boolean[] = [];
	// spy on the editor's focus() to record whether its DOM was connected at the time
	// (see the existing helpers at the top of this file for how a PendingAnnotationMarker is built)
	const marker = makePendingMarker({
		onFocus: (el: HTMLElement) => focused_while.push(el.isConnected),
	});

	const dom = marker.toDOM(view);
	expect(focused_while).toHaveLength(0); // MUST NOT have focused yet — it is not attached

	document.body.appendChild(dom);
	marker.afterAttach(dom);

	expect(focused_while).toEqual([true]); // focused, and connected when it happened
});
```

Read the existing helpers at the top of `tests/pending_card.test.ts` and adapt the construction above to match them. If no `onFocus` seam exists, add one to `ReplyBox`'s options rather than reaching into `EmbeddableMarkdownEditor` internals.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- tests/pending_card.test.ts`
Expected: FAIL — `marker.afterAttach is not a function`, and/or the focus already fired during `toDOM()` while disconnected.

- [ ] **Step 3: Call `afterAttach` after the node is attached**

In `src/editor/renderers/gutters/base.ts`, `GutterElement.setMarkers` currently does:

```ts
			if (marker.toDOM && view) {
				if (matched) domPos = domPos!.nextSibling;
				else this.dom.insertBefore(marker.toDOM(view), domPos);
			}
```

Change it to hold the node, attach it, and only then notify the marker:

```ts
			if (marker.toDOM && view) {
				if (matched) {
					domPos = domPos!.nextSibling;
				} else {
					// EXPL: `marker.toDOM(view)` is evaluated BEFORE insertBefore attaches its result, so a
					//       marker cannot focus (or measure) its own DOM from inside toDOM() -- the node is
					//       still disconnected, and HTMLElement.focus() on a disconnected node is a silent
					//       no-op. Anything that needs a live node goes in afterAttach().
					const dom = marker.toDOM(view);
					this.dom.insertBefore(dom, domPos);
					(marker as GutterMarker & { afterAttach?: (dom: HTMLElement) => void })
						.afterAttach?.(dom as HTMLElement);
				}
			}
```

- [ ] **Step 4: Move the pending marker's focus into `afterAttach`**

In `src/editor/renderers/gutters/annotations-gutter/pending-marker.ts`:

Pass `focus: false` when constructing the `ReplyBox` inside `toDOM()` (line ~68 — it currently relies on `ReplyBox`'s default `focus: true`, which fires during `component.load()` while the node is detached).

Then add to `PendingAnnotationMarker`:

```ts
	/**
	 * Called by GutterElement.setMarkers once this marker's DOM is actually in the document.
	 * Focusing from inside toDOM() is a silent no-op: the node is not attached yet.
	 */
	afterAttach(dom: HTMLElement) {
		// The draft can be torn down between toDOM() and here (Escape, a selection change, a
		// gutter reflow), and this reply box may no longer be the live one.
		if (!dom.isConnected || this.reply_box !== this.component_reply_box_at_build) return;
		this.reply_box?.focus();
	}
```

Add a `focus()` method to `ReplyBox` (`reply-box.ts`) that forwards to its `EmbeddableMarkdownEditor`, and store the box built by the current `toDOM()` call so the staleness check above has something to compare against. **Do not use `setTimeout`** — the legacy comment path already does (`add-comment.ts:128`, with its own `FIXME`), and the draft flow exists specifically to escape that pattern.

- [ ] **Step 5: Fix the same latent bug on the existing card**

`src/editor/renderers/gutters/annotations-gutter/marker.ts:618-619` has the same shape:

```ts
		if (reopen) this.showReplyBox();
		return this.annotation_thread;
```

`showReplyBox()` builds and focuses a box before `annotation_thread` is returned to `insertBefore` — so a card rebuilt mid-reply (a "re-home") fails to refocus. Move it:

```ts
		this.reopen_on_attach = reopen;
		return this.annotation_thread;
	}

	afterAttach(dom: HTMLElement) {
		if (!dom.isConnected || !this.reopen_on_attach) return;
		this.reopen_on_attach = false;
		this.showReplyBox();
	}
```

This is very likely the same defect as the known "half-typed reply is lost when the thread's own markup is edited" symptom. **Verify that:** with this fixed, type a reply, edit the thread's markup so the card re-homes, and check whether the text survives. Report which it is in your task report.

- [ ] **Step 6: Guard the `offsetTop` crash**

`src/editor/renderers/gutters/annotations-gutter/annotation-gutter.ts:219` carries
`FIXME: offsetTop not defined error (repr: when interacting in phantom comment note)` and reads:

```ts
			const marker_offset = (element.dom.children[markerIndex] as HTMLElement).offsetTop;
```

`children[markerIndex]` can be `undefined` while a draft card is alive, throwing a `TypeError`. Guard and bail:

```ts
			// EXPL: The child can be absent while a pending (draft) comment card is alive — the marker
			//       list and the DOM children can disagree for one frame during the draft's lifecycle.
			//       Bail rather than throw; the next update will place it.
			const marker_el = element.dom.children[markerIndex] as HTMLElement | undefined;
			if (!marker_el) return;
			const marker_offset = marker_el.offsetTop;
```

Match the surrounding function's control flow — if it is inside a loop, `continue` rather than `return`. Delete the `FIXME` on line 219.

- [ ] **Step 7: Run the tests**

Run: `bun run test -- tests/pending_card.test.ts`
Expected: PASS.

Run: `bun run test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/editor/renderers/gutters/ src/ui/embeddable-editor.ts src/ui/ tests/pending_card.test.ts
cat > /tmp/msg.txt <<'EOF'
fix(gutter): clicking the comment pill focuses the draft box

focus() was called inside PendingAnnotationMarker.toDOM(), on the node toDOM()
was still building. But toDOM()'s return value is exactly what
GutterElement.setMarkers hands to insertBefore -- so nothing inside toDOM() can
run after attachment, and HTMLElement.focus() on a disconnected node is a silent
no-op per the HTML spec. The call was structurally unable to work. (Clicking an
existing card worked because that path runs in a live click handler on an
already-attached node.)

Adds an afterAttach() hook called once the marker's DOM is in the document, with
a staleness guard -- Escape or a selection change can tear the draft down in
between. Also fixes the same latent bug on AnnotationMarker's reopen path, and
guards the offsetTop read that the draft card was crashing on.
EOF
git commit -F /tmp/msg.txt
```

---

## Task 8: Release

**Files:**
- Modify: `manifest.json`, `package.json`, `versions.json` (via the bump script)

- [ ] **Step 1: Run the full suite and the linter one final time**

```bash
bun run test && bun run lint && bun run build
```
Expected: all pass. `main.js` and `styles.css` are produced and are **gitignored** — do not add them.

- [ ] **Step 2: Bump the version**

```bash
bun run scripts/release/bump-version.ts 0.10.0
```
Minor, not patch: Task 3 (highlight splitting) and Task 5 (fail-closed tracking) change behaviour users will notice.

- [ ] **Step 3: Push the commit, then the tag — SEPARATELY**

```bash
git push origin main
git push origin 0.10.0
```

**Never use `git push --follow-tags`.** GitHub silently skips workflow runs for *every* tag when more than three tags arrive in one push, and `--follow-tags` will drag along any backlog of unpushed annotated tags. The release workflow will then not run, for any of them, with no error anywhere. Push the tag alone.

- [ ] **Step 4: Verify the release actually built**

```bash
gh run list --repo AndrewBroz/obsidian-inkling --limit 3
```
Expected: a run triggered by `push` for tag `0.10.0`. If nothing appears, the tag push did not trigger the workflow — check how many tags went up.

---

## Verification the tests cannot do

Every check below needs a real Obsidian vault and a human. They are the reason this phase exists; do not mark the plan complete without them.

1. **The teleport.** Type `{==h==}rest` into a note. Put the cursor at the very start. In Suggest mode, type `x`. The `x` must appear *before* the highlight.
2. **Drag-and-drop.** In Suggest mode, select a word and drag it somewhere else in the same note. It must be recorded as a deletion at the source and an addition at the target — not an untracked move.
3. **Image paste.** In Suggest mode, paste an image. It must be tracked as an addition.
4. **Reject-all safety.** Add some text in Suggest mode, then delete across *part* of what you just added. Reject all. The text you deleted must not come back.
5. **Thread duplication.** Make a comment thread with two replies. Type in the paragraph next to it for a while. The replies must not multiply.
6. **The pill.** Select text, click the comment pill. The cursor must land in the draft box, ready to type.
7. **Undo.** Commit a comment. One Ctrl+Z must remove the whole thing.

---

## Task 3b: Partial overlap of a highlight no longer silently drops the edit

**Added mid-execution**, after Task 3's review found this. Task 3 fixed *strict enclosure* (the operation
entirely inside a highlight). A **partial** overlap still hits the old ignore-loop and is silently truncated.

**Files:**
- Modify: `src/editor/base/edit-logic/mark.ts` (the ignore-loop and the Task 3 early-out)
- Modify: `tests/mark_ranges.test.ts` and `tests/__snapshots__/mark_ranges.test.ts.snap`

**The defect** — all three confirmed live on `main` and still live after Task 3:

```
mark("x{==here==}y", 1, 11, "", DELETION)    // select EXACTLY the highlight, press Delete
  -> nothing happens at all. The document is unchanged.

mark("{==here==}rest", 5, 12, "", DELETION)  // select from inside the highlight through the text
  -> "{==here==}{--re--}st"    // the chars INSIDE the highlight are silently not deleted

mark("ab{==cd==}ef", 0, 12, "", DELETION)    // select everything, press Delete
  -> "{--ab--}{==cd==}{--ef--}"  // "cd" survives, untouched, inside its highlight
```

The last is currently PINNED GREEN by the characterization snapshot
`mark_ranges characterization (snapshot-pinned) deletion across highlight range`. That snapshot records
what the code does, not what is right. It must be updated, deliberately, with the reason in the commit.

**Root cause (same as everything else this phase):** the ignore-loop's guard `if (last_range_start < range.from)`
emits an edit for the region *before* an incompatible range, then jumps `last_range_start = range.to`. For a
partial overlap the region inside the range is never marked by anyone.

**The design.** A HIGHLIGHT partially covered by an operation is **split at the coverage boundary**, exactly as
Task 3 splits a strictly-enclosing one. The covered part of the highlight's content is marked; the uncovered
part stays highlighted.

```
"ab{==cd==}ef", delete [0,12)   ->  "{--ab--}{--cd--}{--ef--}"   (or a single merged {--abcdef--})
   the whole selection is deleted, and no highlight survives because none of its content survives

"{==here==}rest", delete [5,12) ->  "{==h==}{--ere--}{--rest--}"  (or merged)
   "h" stays highlighted; "ere" and "rest" are deleted
```

The exact merging of adjacent same-type ranges is `mark_range`'s existing job — do not reimplement it.

**COMMENTS ARE NOT SPLIT** (same rule as Task 3): a comment's body is prose. A selection partially covering a
comment must leave the comment's text alone.

**The oracle.** For every case, `reject_all(output)` must equal the original base document, and `accept_all(output)`
must equal what the user meant. Assert both on every test — the output string is secondary.

- [ ] **Step 1:** Write failing tests for all three cases above, plus the comment case, asserting `reject_all` and
      `accept_all` alongside the output string.
- [ ] **Step 2:** Run them; confirm they fail with the *silently-truncated* outputs quoted above.
- [ ] **Step 3:** Extend the Task 3 early-out (or the ignore-loop) to handle partial coverage of a HIGHLIGHT.
- [ ] **Step 4:** Run; confirm pass. Update the `deletion across highlight range` snapshot with `-u` and
      **state in the commit message why the snapshot changed**.
- [ ] **Step 5:** Full suite. Commit.
