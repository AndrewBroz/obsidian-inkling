# Comment threads, flat cards, and the pill's left-margin dead zone

**Date:** 2026-07-13
**Status:** Approved, not yet implemented

Three independent changes, shipped as three separate commits/PRs. They touch
disjoint files and can land in any order.

1. **Bug** — the add-comment pill does not appear when the selection sits near
   the left edge of the text.
2. **Style** — comment cards carry outlines; Obsidian's own surfaces are flat.
3. **Feature** — comment threads with an inline reply box, including threads on
   suggestions.

---

## 1. The pill's left-margin dead zone

### Root cause

`createGutterViewPlugin` (`src/editor/renderers/gutters/base.ts:517-522`)
registers the gutter's `EditorView.scrollMargins` source:

```ts
return view.textDirection == Direction.LTR
    ? { left: value.dom.offsetWidth }
    : { right: value.dom.offsetWidth };
```

The ternary branches on **text direction** where it should branch on **gutter
side**. Every gutter therefore reports its width as a *left* margin in LTR —
including the annotations gutter, which renders on the **right**:
`AnnotationGutterView` overrides `insertGutters` to place its DOM *after* the
content (`annotation-gutter.ts:89-91`), whereas the base class inserts it
*before* (`base.ts:379`).

CodeMirror derives the editor's visible rect from those margins and hides any
tooltip anchored outside it (`@codemirror/view` `writeMeasure`):

```js
visible.left = scrollDOM.left + margins.left
// ...
if (pos.right < Math.max(visible.left, space.left) - .1) {
    dom.style.top = Outside;   // -10000px
    continue;
}
```

So a selection whose head lands within the leftmost *annotation-gutter-width*
pixels of the text has its pill banished offscreen. The dead zone scales with
the gutter: widening the annotations gutter makes the bug worse.

### Fix

Teach the gutter view plugin which side it sits on and emit the matching margin.

| side | LTR | RTL |
| --- | --- | --- |
| `before` (left in LTR) | `{ left: width }` | `{ right: width }` |
| `after` (right in LTR) | `{ right: width }` | `{ left: width }` |

The diff gutter is `before` (it uses the base `insertGutters`); the annotations
gutter is `after`. This also repairs horizontal `scrollIntoView`, which has been
reserving space on the wrong side for as long as the annotations gutter has
existed.

### Rejected alternative

Setting `clip: false` on the pill's `Tooltip` disables CM6's hide check and
would make the pill reappear. Rejected: it treats the symptom, leaves the bogus
margin in place for every other tooltip and for scroll behaviour, and would
suppress the pill's *legitimate* hiding when its anchor scrolls out of view.

### Verification

- Unit-test the `scrollMargins` source: `{right}` for the annotations gutter,
  `{left}` for the diff gutter, both flipped under RTL.
- Regression case in `tests/comment_pill.test.ts`: a selection near the left
  edge yields a pill that is not clipped.
- Manual check in a vault: select the first word of a line, confirm the pill.

---

## 2. Flat, Obsidian-native comment cards

Obsidian's comment-adjacent surfaces (callouts, hover popovers) are flat —
tinted fills, no outlines. The cards clash. Drop the boxes and use surface tint.

| Element | Today | Becomes |
| --- | --- | --- |
| `.cmtr-anno-gutter-thread` (`annotation-gutter.scss:33`) | `border: 2px solid var(--background-modifier-border)` | no border; `background: var(--background-secondary)`, `border-radius: var(--radius-m)` |
| Focused thread (`:46`) | accent `border-color` | accent-tinted **background** |
| Editing annotation (`:106`) | `box-shadow: 0 0 0 2px var(--comment-border-color)` | ring moves onto the text input itself (Obsidian's native input focus) |
| Reply separator (`:82`) | `1px dashed` | solid hairline in `--background-modifier-border`, matching Obsidian menu separators |
| Sidebar `.cmtr-view-range` (`view.scss:7`) | `border: 1px solid` | same flat treatment, so both surfaces agree |

Inline text decorations (`.cmtr-comment`, `.cmtr-highlight`) are already
flat background-only and are left alone.

### Verification

Visual, in a vault: light and dark themes, a focused thread, a thread being
edited, and a multi-reply thread.

---

## 3. Comment threads with an inline reply box

### What already exists

The data model already supports threads and needs **no change**.

- A thread is a run of strictly text-adjacent ranges where every range after the
  first is a comment: `{==anchor==}{>>a<<}{>>b<<}`.
- The grouping rule (`range-parser.ts:49-54`) is **type-agnostic on the base**,
  so `{++added++}{>>a<<}` and `{--cut--}{>>a<<}` are already legal threads.
- `base_range`, `replies`, and `full_thread` (`base_range.ts:62-72`) are
  populated; threads are flat, one level deep (a reply to a reply re-targets the
  base — `comment_range.ts:35-43`).
- The annotations gutter already renders one card per base range containing
  every range in `full_thread` (`marker.ts:560-611`).
- `"Add reply"` already exists in the gutter, tooltip, and sidebar context menus
  for every range type.

The gap is purely one of affordance and write path: replying means digging
through a `…` menu, and creating a comment writes empty markup into the note.

### Reply to an existing thread

Clicking a gutter thread card reveals a reply box pinned beneath the last
comment in that card.

- **Enter** commits. **Shift+Enter** inserts a newline.
- **Escape**, or **blur while empty**, dismisses the box.
- **Blur with text** leaves the box open — nothing is written by accident.
- Committing inserts `create_range(settings, COMMENT, text)` at
  `range.full_range_back` — the position the existing `"Add reply"` menu item
  already uses.

Because the card exists for suggestion bases too, **comments on suggestions come
for free**: click an addition's card, type, press Enter.

### New thread from the pill: draft-then-insert

Today `addCommentToView` (`add-comment.ts:26-50`) writes
`{==highlight==}{>>@@<<}` into the note the instant the pill is clicked, then
chases it with a `setTimeout` to focus the editor it just created (`:38-48`,
carrying a `FIXME` that admits the hack). Abandoning that comment leaves an empty
range in the document and two junk entries in the undo stack.

Instead, the pill dispatches a **pending draft**:

- A `StateField` holds the pending selection's `{ from, to }` — nothing more.
- The gutter renders a provisional card for it, via a second `RangeSet` joined
  into the gutter's `markers` accessor (`annotations-gutter/index.ts:36`).
- On **Enter**, a single transaction inserts `{==selection==}{>>text<<}` with the
  text already in hand.
- On **Escape** or **empty blur**, the field clears and the note is untouched.

This removes the `setTimeout` focus dance entirely: the document is written once,
on commit, and there is no such thing as an abandoned empty comment. For a fork
whose headline is data-safety, "never write markup the user did not ask for" is
the right invariant.

### Draft lifecycle

The pending field clears on Escape, on empty blur, and on commit.

It does **not** clear on `docChanged`. Discarding the draft whenever the document
changes would contradict "blur with text leaves the box open": a user who starts a
comment, types a draft, then clicks into the note to edit a word would silently
lose it. Instead the anchor is **mapped through `tr.changes`**, which is what
`ChangeSet` is for. The one case that does clear the field is the anchored text
being deleted outright — the mapped range collapses to empty, and there is nothing
left to comment on.

The reply box is its own editor, so typing in it never touches the note.

The pill hides while a draft is open.

### Out of scope (YAGNI)

- Promoting Reply/Resolve to always-visible buttons on the card.
- Card avatars, relative timestamps, indented replies.
- Reply boxes in the hover tooltip and the sidebar view.

The trigger is scoped to the gutter card. The existing context menus keep
working everywhere else.

### Verification

- Unit tests: committing a reply inserts a comment at `full_range_back`;
  committing a draft inserts highlight+comment as **one** transaction; an
  abandoned draft dispatches **no** document change; a draft anchor survives an
  unrelated edit elsewhere in the note, and clears when its anchored text is
  deleted.
- Manual: reply to a comment, reply to an addition, start and abandon a new
  comment, confirm the note is byte-identical after abandoning.
