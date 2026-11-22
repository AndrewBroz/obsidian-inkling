# Comments on code blocks

Approved by the owner on 2026-11-21 ("option C").

## Why

Inkling never writes markup inside a fenced code block, which 0.13 settled. People still need to comment on code. The
comment therefore lives just outside the block and remembers what it was about.

## Behaviour

**Writing.**
- In any mode where commenting is allowed, the user selects code inside a block, or puts the cursor in it, and uses
  Add comment or the pill.
- In Comment mode, code stays read-only like all other text, but commenting works.
- The draft card opens beside the block, as other drafts do.
- On submit, Inkling writes a standalone comment on its own line directly after the closing fence. Nothing is
  written inside the block.

**What the comment remembers** lives in its attribute block. The format can't hold line breaks, so keep these fields
to one line each:
- `quote`: the selected text. For a selection within one line, the exact selection. For a multi-line selection, the
  selected part of its first line.
- `line`: the 1-based line within the block where the selection starts. Omitted when nothing is selected.
- `lines`: the number of lines selected, written only when it's more than 1.
- No selection (cursor only) means the comment is about the whole block, and none of these fields are written.

Example: ```` ```js ```` … ```` ``` ```` followed on the next line by
`{>>Why not const?<<}{author=Andrew time=1795300000 quote="let x = 1" line=2}`.

**Association.** A comment thread whose first comment starts on the line directly after a closing fence belongs to
that block. A blank line, or any other text in between, breaks the link. Replies attach as usual.

**Display.**
- The card lines up with the block and shows the quote as a short monospace snippet, or nothing extra for a
  whole-block comment.
- Selecting or focusing the card highlights the matching code in the block. That's a decoration only; the text
  never changes. With no quote, the whole block is outlined.

## When the code changes

| Situation | Behaviour |
|---|---|
| Quote still in the block | Highlight it wherever it now is. With several occurrences, pick the one whose line is closest to `line`. For `lines` > 1, highlight from the match to the end of that many lines. |
| Quote no longer in the block | The card shows the original quote, marked "This code has changed". Focusing it outlines the whole block. |
| Block deleted | The comment stays as an ordinary standalone comment and still shows its quote. |
| Text inserted between the fence and the comment | The link is lost, and the comment becomes an ordinary comment with its quote. |
| Resolved (remove on resolve) | The comment is removed as usual, including its now-empty line. |

The comment is never lost and never silently wrong.

## Compatibility

`quote`, `line` and `lines` are ordinary attribute fields. Inkling 0.13+ reads them, and older Inkling versions just
show an extra card field. `config/critic.py` strips comments together with their blocks. No new syntax.

## Copy

Use plain language in the UI: "This code has changed". The README describes how to comment on code in user terms.
The format reference may name the fields.
