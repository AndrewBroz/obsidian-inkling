# Edit-Engine Integrity (Phase 1) — Design

**Parent:** `2026-07-14-road-to-1.0-roadmap.md`
**Status:** approved 2026-07-14
**Goal:** Make the edit engine trustworthy. Every change here is orthogonal to the Phase 2 parser
fork and would be required under any range model.

Inkling currently relocates keystrokes, lets edits through untracked, resurrects deleted text on
reject-all, and rebuilds comment threads non-deterministically. This phase fixes that. It ships as a
release before the parser fork begins.

---

## 1. Honest position predicates

### The defect

Every position predicate is closed on both ends, so the codebase cannot distinguish *beside* from
*inside*.

```ts
// base_range.ts:239
cursor_inside(cursor) { return this.from <= cursor && cursor <= this.to; }   // closed

// base_range.ts:209
partially_in_range(start, end) {
    // return this.from < end && start < this.to;      ← correct, commented out
    return !(start > this.to || end < this.from);      ← ships; a merely-touching range matches
}
```

The interval tree agrees, at the library level
(`@flatten-js/interval-tree`, `main.umd.js:86`):

```js
not_intersect(other) { return (this.high < other.low || other.high < this.low); }  // strict <
```

so `at_cursor`, `ranges_in_interval` and `contains_range` all report a range that merely *touches* a
point as *containing* it.

### The design

Give the code the missing word. Add to `CriticMarkupRange`:

```ts
/**
 * The position lies strictly between this range's outer brackets: an edit here lands INSIDE the
 * markup. A position at either edge is BESIDE the range, not in it — use `touches` for that.
 */
interior(p: number): boolean {
    return this.from < p && p < this.to;
}

/**
 * This range and [start, end) share at least one character. A range that merely abuts the interval
 * (ends exactly at `start`, or begins exactly at `end`) does NOT overlap it.
 *
 * Degenerates correctly for a zero-width interval: `overlaps(p, p)` === `interior(p)`.
 */
overlaps(start: number, end: number): boolean {
    return this.from < end && start < this.to;
}
```

`touches` (`base_range.ts:235`) already exists and is already correct; keep it.

Rename the existing closed-interval predicates to say what they actually do, so no future caller
reaches for the wrong one by accident:

- `partially_in_range` → `adjoins` ("shares a character **or** merely abuts").
- `cursor_inside` → `interior_or_edge`.

Both keep their current bodies. Every existing call site is then reviewed and moved to the predicate
that answers the question it is actually asking. On `CriticMarkupRanges`, add:

```ts
/** Ranges sharing at least one character with [start, end). Excludes ranges that merely abut. */
ranges_overlapping_interval(start: number, end: number): CriticMarkupRange[] {
    return (this.tree.search([start, end]) as CriticMarkupRange[])
        .filter(range => range.overlaps(start, end));
}
```

The interval tree stays as the index (it is a correct *superset* filter); the strict test is applied
to its results.

Finally, delete the hand-rolled strict check in `add-comment.ts:202-203` and call
`ranges_overlapping_interval`. It exists only because the shared predicate lied; it is the bug's own
confession.

### What this fixes

**(a) The teleporting keystroke.** Document `{==h==}rest`, cursor at 0, Suggest mode, type `x`:

```
expected:  {++x++}{==h==}rest
actual:    {==h==}{++x++}rest      ← the keystroke is relocated past the whole highlight
```

`mark_ranges` (`mark.ts:479`) asks `ranges_in_interval(0, 0)`, which returns the highlight (it
*touches* 0). The ignore-loop (`mark.ts:492-503`) then treats the highlight as an atomic island. Its
guard is `if (last_range_start < range.from)` — with both `0`, that is false, so no edit is emitted
for "before the range"; it sets `last_range_start = range.to`, jumping the insertion point past the
highlight.

Switching `mark.ts:479` to `ranges_overlapping_interval` fixes it: `overlaps(0, 0)` on a range with
`from === 0` is `0 < 0 && 0 < 7` → false. The highlight is not returned, the ignore-loop does
nothing, and the character is inserted where the user typed it.

**(b) Thread duplication** (`range-state.ts:143`) — see §4.

**(c) Comment-draft eligibility flipping** between open (`add-comment.ts:41`, closed) and commit
(`:202`, strict), because both now use the same predicate.

---

## 2. Suggest mode must fail closed

### The defect

```ts
// suggestion-mode.ts:116-126
const is_recognized_edit_operation = tr.isUserEvent("input") || tr.isUserEvent("paste") ||
    tr.isUserEvent("delete");
if (!is_recognized_edit_operation)
    return tr;                      // ← passes through, COMPLETELY UNTRACKED
```

An **allowlist**. Anything unrecognised sails through untracked, silently. That is the wrong default
for a feature whose entire promise is "every edit is tracked."

The upstream comment (`suggestion-mode.ts:124`) says drag-and-drop "doesn't seem to fire a
userEvent". **That is wrong.** CodeMirror's `dropText` (`@codemirror/view`, `dist/index.js:4866`):

```js
userEvent: del ? "move.drop" : "input.drop"
```

Dragging text in from *outside* fires `input.drop`, and `isUserEvent("input")` prefix-matches, so
that path already works. Dragging a selection *within* the editor is a **move**, fires `move.drop`,
matches none of the three, and is dropped on the floor. Image paste (routed through Obsidian's own
file handling, not CM6's paste) likewise carries no userEvent.

**The same list is copied three times, and is correct in one of them.** `comment-mode.ts:22-23` has
four entries — it includes `"move"`:

```ts
// comment-mode.ts:22-23  — tracks drag-and-drop
!(tr.isUserEvent("input") || tr.isUserEvent("delete") ||
    tr.isUserEvent("paste") || tr.isUserEvent("move"))

// suggestion-mode.ts:116-117 and edit-mode.ts:42 — three entries. No "move".
```

So Comment mode tracks a dragged selection and Suggest mode does not. This is not a subtle oversight;
it is one list, duplicated three times, fixed once. Adding `"move"` to the other two copies would fix
today's symptom and leave the mechanism — a fourth copy is the next bug.

These are not two special cases. They are two things that fell through a hole.

### The design

Invert to a denylist, **defined once** and shared by all three editing modes:

```ts
// src/editor/uix/extensions/editing-modes/tracked-edit.ts  (new)

/**
 * A doc-changing transaction is a tracked edit unless it is one of ours, or one we must not
 * re-process.
 *
 * This is a DENYLIST on purpose. The three editing modes previously each carried their own
 * allowlist of userEvents, and an edit matching none of them passed through UNTRACKED — silently.
 * That is how a dragged selection (`move.drop`) and image paste escaped Suggest mode, and it would
 * have swallowed every future edit path Obsidian or another plugin introduces. Anything we do not
 * recognise must be TRACKED, not exempted.
 */
export function is_exempt_from_tracking(tr: Transaction): boolean {
    return tr.isUserEvent("undo") || tr.isUserEvent("redo") ||
        tr.annotation(Transaction.remote) === true ||
        tr.annotation(pluginEditAnnotation) === true;
}
```

The plugin's own transactions must carry `pluginEditAnnotation` so the filter does not recurse — the
recursion the existing comment at `suggestion-mode.ts:119-121` warns about. This follows the pattern
already in use for `commentModeAnnotation` (`comment-mode.ts:8,17`), which exists for exactly this
reason.

`suggestion-mode.ts:116`, `edit-mode.ts:42`, and `comment-mode.ts:22` all call the shared predicate.
Three copies of a list become one rule.

Classification stays as it is: `getEditorRanges` already decomposes a transaction into changed
ranges, and the existing loop (`suggestion-mode.ts:139-142`) derives ADDITION / DELETION /
SUBSTITUTION from whether each range deleted and/or inserted. A `move.drop` decomposes into a
deletion at the source and an insertion at the target, which is precisely correct.

**Verification is behavioural, not unit-only:** a test must assert that a transaction with an
*unknown* userEvent still gets tracked, so the fail-closed property is pinned and cannot regress to
an allowlist.

---

## 3. Partial coverage of a pending addition must retract

### The defect

Already documented in the suite as a known bug (`tests/mark_ranges.test.ts:120-129`):

```ts
test("KNOWN RESIDUAL: partial coverage of an addition still folds the covered slice", () => {
    const output = mark("ab{++cd++}ef", 0, 6, "", SuggestionType.DELETION);
    expect(output).toBe("{~~abc~>d~~}ef");
    expect(reject_all(output)).toBe("abcef");   // ideal would be "abef"
});
```

`{++cd++}` means `c` and `d` are *pending* — never in the base document. Deleting `ab` plus the `c`
folds `c` into the deletion side of a substitution, so **`reject_all` resurrects a character that
never existed.** `drop_pending_additions` / `unwrap_in_range` (`grouped_range.ts:127-139`,
`mark.ts:369-394`) only retract on *full* coverage.

### The design

When a mark operation covers part of an ADDITION, the covered slice is **retracted** (dropped
outright), not folded into the new markup. Only the *uncovered* remainder survives as an addition.

```
before:  ab{++cd++}ef        delete [0, 6)  — that is "ab" plus the addition's "c"
after:   {--ab--}{++d++}ef

accept_all → "def"    (deletion applied, addition kept)          ✓ unchanged
reject_all → "abef"   ("ab" restored, "d" dropped, "c" gone)     ✓ FIXED (was "abcef")
```

`SubstitutionRange` needs the same treatment on its inserted half, which is a pending addition by
another name.

Replace the `KNOWN RESIDUAL` test with the corrected expectation, and add the symmetric cases:
partial coverage from the right, coverage of the middle, and full coverage (which must not regress).

---

## 4. Thread duplication

### The defect

```ts
// range-state.ts:143-146
const adjacent_range = value.ranges.tree.search([head.from, head.from])[0] as CriticMarkupRange;
adjacent_range!.replies.length = 0;
for (const comment of thread.slice(adjacent_range === head ? 1 : 0))
    comment.add_reply(adjacent_range);
```

A closed-interval point search at `head.from` returns **both** the head comment (which begins there)
and the anchor before it (which ends there — touching counts). `[0]` then picks one in
**interval-tree traversal order, which is not document order** and which changes as the tree is
rebalanced during editing.

So the same document can rebuild its threads *differently* on different keystrokes. The duplication
follows directly: `.replies.length = 0` clears only the range it happened to pick, so when the pick
flips between the anchor and the head, the other retains its stale replies. This is the
`FIXME: Rare cases of comment ranges in threads being duplicated due to editor changes`
(`range-state.ts:122`).

### The design

Make the choice explicit and deterministic. The anchor of a thread is *the range that ends exactly
where the head begins* — and it is never the head itself:

```ts
// The anchor is the range immediately to the LEFT of the head — the one whose `to` is the head's
// `from`. A closed-interval search at `head.from` also returns the head itself (it begins there),
// and the tree's result order is traversal order, not document order — so picking [0] chose
// non-deterministically between the two, and cleared only whichever it picked. Be explicit.
const anchor = value.ranges.tree.search([head.from, head.from])
    .find(r => r !== head && r.to === head.from) as CriticMarkupRange | undefined;
const base = anchor ?? head;   // no anchor ⇒ this is a bare thread; the head is its own base
```

Then clear `base.replies` exactly once and attach. A test must construct the thread twice from
different edit histories and assert the same result both times — the non-determinism is the bug, so
determinism is the assertion.

---

## 5. Typing strictly inside a highlight splits it

### The defect

Once §1 stops the *edge* teleport, the *interior* case remains. Document `{==here==}`, cursor after
`h` (position 4), type `x`. The highlight now correctly *is* returned by
`ranges_overlapping_interval(4, 4)` (`0 < 4 && 4 < 10`). But `should_ignore_range` (`mark.ts:34-55`)
treats a HIGHLIGHT as incompatible with any other type, and the ignore-loop again jumps
`last_range_start` to `range.to` — teleporting the character out of the highlight's far side.

### The design

Split the highlight and place the tracked change between the halves:

```
before:  {==here==}     cursor after 'h'
type x:  {==h==}{++x++}{==ere==}
```

Nothing is lost, the tracked change survives accept/reject, and the result is valid CriticMarkup.
`CriticMarkupRange.split_range(cursor)` already exists (`base_range.ts:343`) and is already used for
ADDITION/DELETION/SUBSTITUTION; this extends the same treatment to HIGHLIGHT.

The cost is honest and accepted: one highlight becomes two in the raw text. **Phase 2's overlap
dialect expresses this properly** — `{==#a1 h{++x++}ere==#a1}` — so this is a stepping stone, not a
dead end.

COMMENT ranges are *not* split: a comment's body is prose, not document text, and typing inside one
is editing the comment, not the note.

---

## 6. Two UI bugs

### Pill click does not focus the draft box

`.focus()` is called on a DOM node that is not in the document yet. The whole chain is synchronous
inside one `dispatch()`:

```
pill click → addCommentToView → editor.dispatch(setCommentDraft)
  → pendingAnnotationMarkers builds a PendingAnnotationMarker
    → GutterElement.setMarkers:  this.dom.insertBefore( marker.toDOM(view), domPos )
                                                        └─ toDOM() runs FIRST…
        → component.load() → ReplyBox.onload() → EmbeddableMarkdownEditor.onload()
          → this.editor?.focus()          ← detached node. Silent no-op per the HTML spec.
        → return thread                    ← …and only NOW does insertBefore attach it.
```

`toDOM()`'s return value is exactly what `insertBefore` is waiting on, so **nothing inside `toDOM()`
can ever run after attachment.** (This is why clicking an *existing* card works: that path runs in a
live click handler on an already-attached node.)

**Fix:** focus after the node is attached, in `base.ts:210`'s caller, guarded by a
"is this still the live marker" check — Escape or a selection change can tear the draft down in
between. Do **not** reach for `setTimeout`: the legacy comment path already does that
(`add-comment.ts:128`, with its own `FIXME`), and the draft flow exists specifically to escape that
pattern.

The same latent bug exists at `marker.ts:618` (`if (reopen) this.showReplyBox()`, also pre-attach),
which is very likely the same defect as the known "half-typed reply lost on re-home" symptom. Fix
both; verify they are one bug.

### `offsetTop` crash on the draft card

```
FIXME: offsetTop not defined error (repr: when interacting in phantom comment note)
```
`annotation-gutter.ts:219` — `moveGutter` reads
`(element.dom.children[markerIndex] as HTMLElement).offsetTop`, and `children[markerIndex]` can be
`undefined` while a draft card is alive, throwing a `TypeError`. Fevol wrote this FIXME about *his*
phantom comments; our draft card points a new feature straight at it. Guard the read and bail
cleanly.

---

## Testing

- **Characterisation first.** The teleport, the thread non-determinism, and the retraction bug get
  failing tests *before* any fix, driving the real pipeline (as `tests/focus_nesting.test.ts` does)
  rather than a synthetic reproduction. A prior regression in this repo was caused by trusting a
  hand-built probe over the system it was meant to reproduce; do not repeat it.
- **Fail-closed is a property, not a case.** Assert that an *unknown* userEvent is tracked.
- **Determinism is a property.** Build the same thread from two different edit histories; assert
  identical structure.
- **Reject-all is the oracle for §3.** `reject_all(output)` must equal the original base text for
  every partial-coverage case. That is the invariant the bug violates.

## Out of scope

Parser fork and overlap (Phase 2). Comment-surface unification, reading-view threads, bare-comment
identity, the connector line (Phase 3). The hygiene list (Phase 4).
