# PR2: Flat, Obsidian-native comment cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the outlined comment cards with flat, tinted surfaces that match Obsidian's native chrome (callouts, hover popovers, menus), in both the annotations gutter and the sidebar Annotations View.

**Architecture:** Pure SCSS. No TypeScript, no DOM structure, no class-name changes — every selector below already exists and is already applied by `marker.ts` / `AnnotationThread.svelte`. Outlines are expressed today in three different ways (`border`, `border-color`, and `box-shadow: 0 0 0 2px` rings); all three are replaced by **surface tint** — background colour carries state instead of a stroke.

**Tech Stack:** SCSS (compiled by `esbuild-sass-plugin` into `styles.css`), Obsidian CSS variables.

## Global Constraints

- Styles live in `src/assets/*.scss` and are bundled into the repo-root `styles.css` by the build. **Never hand-edit `styles.css`** — it is generated.
- Use Obsidian's CSS custom properties (`--background-secondary`, `--radius-m`, `--text-muted`, …). Do not introduce hard-coded colours; the plugin must follow the user's theme in both light and dark mode.
- Keep the existing `// EXPL:` comment conventions. Several rules in `annotation-gutter.scss` carry hard-won explanations (notably the `:nth-child(1 of S)` rounding rule) — **preserve those comments and those selectors**.
- Format with `bun dprint fmt`.

## Design tokens

| Purpose | Token |
| --- | --- |
| Card surface | `var(--background-secondary)` |
| Card corner | `var(--radius-m)` |
| Focused / hovered card surface | `var(--background-modifier-hover)` composited over the card surface |
| Active (being edited) surface | `var(--background-modifier-active-hover)` |
| Hairline separator between replies | `1px solid var(--background-modifier-border)` |

> **On `--background-modifier-hover`:** this is a *semi-transparent overlay* token, not an opaque
> surface (`rgba(var(--mono-rgb-100), 0.075)`). The codebase already got burned by this — see the
> long `EXPL:` in `editor.scss:217-229`, where using it as a `background-color` made the comment
> pill 92.5% see-through. Layer it as a `background-image` (a solid-colour `linear-gradient`) over
> an opaque `background-color`, exactly as the pill now does.

## File Structure

- `src/assets/annotation-gutter.scss` — the gutter thread card and its per-annotation entries. *(Owns the in-editor card.)*
- `src/assets/view.scss` — the sidebar Annotations View cards. *(Owns the sidebar card; restyled so the two surfaces agree.)*

---

### Task 1: Flatten the annotations-gutter thread card

**Files:**
- Modify: `src/assets/annotation-gutter.scss:29-43` (`.cmtr-anno-gutter-thread`), `:45-47` (`.cmtr-anno-gutter-thread-highlight`), `:79-83` (reply separator), `:98-109` (annotation hover / focus / editing)

**Interfaces:**
- Consumes: nothing.
- Produces: no JS surface. Class names are unchanged, so `marker.ts` needs no edits.

- [ ] **Step 1: Flatten the card container**

There is no unit test for visual styling; verification is by eye (Step 4) — do not fabricate a
snapshot test that only asserts the CSS text back to itself.

In `src/assets/annotation-gutter.scss`, replace `.cmtr-anno-gutter-thread` (`:29-43`) and
`.cmtr-anno-gutter-thread-highlight` (`:45-47`):

```scss
// EXPL: Flat by design. Obsidian's own comment-adjacent surfaces (callouts, hover popovers,
//       menus) carry no outline — they read as tinted surfaces lifted off the background. The
//       previous 2px border clashed with every theme, and state (focus) was expressed by
//       swapping the border's COLOR, which is invisible to anyone who reads shape before hue.
//       State now rides on the surface itself.
.cmtr-anno-gutter-thread {
  width: 100%;
  position: relative;

  border: none;
  border-radius: var(--radius-m);

  background-color: var(--background-secondary);

  color: var(--text-muted);

  transition: background-color 100ms ease-in-out 0ms;
}

// EXPL: `--background-modifier-hover` is a SEMI-TRANSPARENT overlay token, not an opaque surface
//       (`rgba(var(--mono-rgb-100), 0.075)`) — see the pill's write-up in editor.scss. Painting
//       it as `background-color` would make the card translucent and let the note's text show
//       through. Layering it as a `background-image` over the opaque base keeps the composite
//       opaque, and lets the focused card read as "lifted" without a stroke.
.cmtr-anno-gutter-thread-highlight {
  background-image: linear-gradient(
    var(--background-modifier-hover),
    var(--background-modifier-hover)
  );
}
```

- [ ] **Step 2: Replace the ring-based hover/focus states on individual annotations**

Still in `src/assets/annotation-gutter.scss`, replace `.cmtr-anno-gutter-annotation:hover`
(`:98-102`) and the `:focus` / editing rule (`:104-109`):

```scss
// EXPL: These were `box-shadow: 0 0 0 2px` rings — an outline in all but name, and the reason a
//       hovered reply grew a hard stroke inside an otherwise flat card. Hover/focus now tint the
//       entry's own surface. `z-index` is retained: entries scroll within a fixed-height card, and
//       the sticky metadata row (below) must not paint over the active entry.
.cmtr-anno-gutter-annotation:hover {
  background-image: linear-gradient(
    var(--background-modifier-hover),
    var(--background-modifier-hover)
  );
  z-index: 20;
}

.cmtr-anno-gutter-annotation:focus,
.cmtr-anno-gutter-annotation-editing.cmtr-anno-gutter-annotation-editing {
  background-color: var(--background-modifier-active-hover);
  z-index: 25;
}
```

The focus ring is **not** lost — it moves to the text input itself. `EmbeddableMarkdownEditor`
renders a real CodeMirror editor (`.cmtr-anno-gutter-annotation-editor.cm-editor`), which already
takes Obsidian's native input focus treatment. Ringing the *container* as well was doubling it.

- [ ] **Step 3: Soften the reply separator and align the corner radius**

Still in `src/assets/annotation-gutter.scss`:

Replace the separator rule (`:79-83`) — dashed reads as "provisional"; Obsidian uses solid
hairlines for menu separators:

```scss
.cmtr-anno-gutter-annotation:not(
    :nth-last-child(1 of .cmtr-anno-gutter-annotation)
  ) {
  border-bottom: 1px solid var(--background-modifier-border);
}
```

Then, in the two `:nth-child(1 of …)` / `:nth-last-child(1 of …)` rounding rules (`:69-77`),
change `var(--radius-l)` to `var(--radius-m)` in all four `border-*-radius` declarations, so the
entries' corners match the container's new radius.

**Leave the long `// EXPL:` comment above those rules exactly as it is** — it documents why the
`of <selector>` form is load-bearing (the actions row is the DOM's literal first child, so plain
`:first-child` silently never matched). That reasoning is still true.

- [ ] **Step 4: Build and verify by eye**

Run: `bun run build:dev:hr`

In a vault note, check each of the following in **both light and dark themes** (Settings →
Appearance → toggle base colour scheme):

1. A single-comment card — flat tinted surface, no outline, corners match.
2. A thread with two or more replies — solid hairline between replies, no dashed line.
3. Click the card to focus it — surface tints, no accent-coloured border appears.
4. Hover a single reply inside a thread — that reply tints, no 2px ring.
5. Double-click a reply to edit it — the *input* takes a focus ring; the container does not.
6. A card on a suggestion (addition/deletion) — same flat treatment.

Confirm the card is fully **opaque** in every state (no note text bleeding through) — that is the
specific failure mode `--background-modifier-hover` causes when misused as a `background-color`.

- [ ] **Step 5: Commit**

```bash
git add src/assets/annotation-gutter.scss styles.css
git commit -m "style: flatten annotation gutter cards to match Obsidian chrome

Obsidian's comment-adjacent surfaces (callouts, popovers, menus) carry no
outline. The gutter cards did, in three different guises: a 2px border on
the container, an accent border-color for focus, and 0 0 0 2px box-shadow
rings on hover/edit. All three are replaced by surface tint, so state
rides on the background rather than a stroke. The reply separator goes
from dashed to a solid hairline, matching Obsidian menu separators.

The focus ring is not lost, only relocated: the embedded CodeMirror input
already takes Obsidian's native input focus treatment, so ringing its
container too was doubling it.
"
```

---

### Task 2: Flatten the sidebar Annotations View cards

**Files:**
- Modify: `src/assets/view.scss:6-14` (`.cmtr-view-range`), `:44-48` (`.cmtr-view-range-completed`), and the `.cmtr-view-range:hover` rule immediately below

**Interfaces:**
- Consumes: the design tokens fixed in Task 1 (`--background-secondary`, `--radius-m`), so the two surfaces agree.
- Produces: no JS surface.

- [ ] **Step 1: Flatten the sidebar card**

In `src/assets/view.scss`, replace `.cmtr-view-range` (`:6-14`):

```scss
// EXPL: Kept in lockstep with `.cmtr-anno-gutter-thread` (annotation-gutter.scss) — the sidebar
//       and the in-editor gutter show the SAME threads, so a user switching between them should
//       not see two different card languages.
.cmtr-view-range {
  border: none;
  border-radius: var(--radius-m);
  background: var(--background-secondary);
  margin: 2px 8px 8px 2px;
  max-height: 400px;
  overflow-y: scroll;
  word-wrap: break-word;
}
```

- [ ] **Step 2: Re-express the "completed" state without a border**

Still in `src/assets/view.scss`, replace `.cmtr-view-range-completed` (`:44-48`). It currently
leans on `border-style: dashed`, which has nothing to attach to once the border is gone:

```scss
// EXPL: Resolved threads previously signalled themselves with a dashed BORDER; with the card
//       flattened there is no border to dash. A recessed (rather than raised) surface carries the
//       same "settled, no longer active" meaning without a stroke, and keeps the muted text.
.cmtr-view-range-completed {
  background: var(--background-primary-alt);
  color: var(--text-muted);
}
```

- [ ] **Step 3: Check the hover rule directly below and convert any stroke it uses**

Read `.cmtr-view-range:hover` in `src/assets/view.scss` (it begins at `:50`). If it expresses hover
with a `border`, `border-color`, or a `box-shadow: 0 0 0 Npx` ring, replace that declaration with
the same opaque-safe tint used everywhere else in this PR:

```scss
  background-image: linear-gradient(
    var(--background-modifier-hover),
    var(--background-modifier-hover)
  );
```

Leave any non-stroke declarations in that rule untouched.

- [ ] **Step 4: Build and verify by eye**

Run: `bun run build:dev:hr`

Open the Annotations View (the sidebar suggestion/comment list) and check, in **both light and
dark themes**:

1. A normal thread card — flat, no outline, radius matches the gutter card from Task 1.
2. A **resolved** thread (toggle the Resolved filter) — recessed surface, muted text, no dashed
   border.
3. Hover a card — tints; no stroke appears.
4. Put the sidebar next to a note with the gutter open — the two card styles should read as one
   design system.

- [ ] **Step 5: Commit**

```bash
git add src/assets/view.scss styles.css
git commit -m "style: flatten Annotations View cards to match the gutter

The sidebar and the in-editor gutter render the same threads, so they now
share one card language: no outline, tinted surface, matching radius.
The resolved state loses its dashed border (there is no border left to
dash) and instead recedes to --background-primary-alt, which carries the
same 'settled' meaning without a stroke.
"
```
