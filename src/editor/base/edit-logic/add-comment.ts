import { EditorSelection, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { Notice } from "obsidian";

import { CriticMarkupRange, SuggestionType } from "../ranges";

import { rangeParser } from "../edit-util";
import { create_range } from "../edit-util/range-create";

import {
	annotationGutterFocusAnnotation,
	annotationGutterFoldAnnotation,
} from "../../renderers/gutters/annotations-gutter";
import { pendingAnnotationMarkers } from "../../renderers/gutters/annotations-gutter/pending-marker";
import { pluginSettingsField } from "../../uix";
import {
	clearCommentDraft,
	type CommentDraft,
	commentDraftField,
	setCommentDraft,
} from "../../uix/extensions/comment-draft";
import { commentModeAnnotation } from "../../uix/extensions/editing-modes";

export function addCommentToView(
	editor: EditorView,
	range: CriticMarkupRange | undefined,
	scroll: boolean = false,
): void {
	const settings = editor.state.field(pluginSettingsField);

	const selection = editor.state.selection.main;

	// EXPL: GDocs-style anchored comment. A clean selection no longer writes markup here — it opens
	//       a DRAFT (comment-draft.ts) that the gutter renders a provisional card for, and the note
	//       is written once, on submit, by commitCommentDraft. CriticMarkup cannot nest, so a
	//       selection touching existing markup has nowhere clean to wrap and falls through to the
	//       plain at-cursor comment below.
	if (!range && !selection.empty) {
		const ranges = editor.state.field(rangeParser).ranges;
		if (ranges.ranges_overlapping_interval(selection.from, selection.to).length === 0) {
			// EXPL: The draft path is only viable where the provisional card can actually be RENDERED,
			//       i.e. where the annotation gutter is installed. It is not always: `annotation_gutter`
			//       is a user-facing toggle (GutterSettings.svelte) that leaves the gutter extension —
			//       and with it `pendingAnnotationMarkers` — out of the state entirely, and
			//       AnnotationGutterView's constructor reconfigures the gutter away in embeds/hover
			//       popovers. With no card there is no ReplyBox, hence no Escape/blur/Enter, hence no
			//       way to ever clear the draft — and a stuck draft makes `pill_eligible` false for
			//       every subsequent selection, bricking the pill, the "Add comment" command and the
			//       context menu item for the rest of the session. So probe for the card machinery and,
			//       when it is absent, keep doing what this plugin did before drafts existed: write
			//       `{==sel==}{>>@@<<}` immediately and focus it. Immediate-write is the only thing that
			//       can work without a gutter.
			if (editor.state.field(pendingAnnotationMarkers, false) !== undefined) {
				editor.dispatch({
					effects: setCommentDraft.of({ from: selection.from, to: selection.to }),
					// EXPL: A folded gutter is one click away and is persisted across sessions. The card
					//       would render into it at width 0 while its ReplyBox still takes focus, so the
					//       user would type into an invisible editor (and Enter would still commit).
					//       Opening a draft unfolds the gutter; `false` (not `null`) means "unfold",
					//       never "toggle".
					annotations: [annotationGutterFoldAnnotation.of(false)],
					scrollIntoView: scroll,
				});
				return;
			}

			// EXPL: Same guard as the draft's commit-time re-validation, for the same reason: this
			//       path wraps an ARBITRARY selection in `{==…==}`, and CriticMarkup has no escapes,
			//       so a `==}` in the selection closes the highlight early (orphaning the rest of the
			//       anchor and leaving a dangling `==}` in the note) and an `@@` is eaten as the
			//       highlight's own metadata terminator. Degrade exactly as the draft path does —
			//       fall through to the unanchored at-cursor comment, which still carries the user's
			//       words — rather than wrapping something the parser cannot read back.
			const anchor_text = editor.state.sliceDoc(selection.from, selection.to);
			const unsafe_anchor = unsafe_sequence(anchor_text, ["==}"]);
			if (!unsafe_anchor) {
				const insert = create_range(settings, SuggestionType.HIGHLIGHT, anchor_text) +
					create_range(settings, SuggestionType.COMMENT, "");
				editor.dispatch(editor.state.update({
					changes: { from: selection.from, to: selection.to, insert },
					selection: EditorSelection.cursor(selection.from + insert.length - 3),
					scrollIntoView: scroll,
					annotations: [commentModeAnnotation.of(true)],
				}));
				activeWindow.setTimeout(() => {
					editor.dispatch(editor.state.update({
						annotations: [
							annotationGutterFocusAnnotation.of({
								from: selection.from,
								to: selection.from,
								index: 1,
							}),
						],
					}));
				});
				return;
			}

			new Notice(
				`Inkling: added the comment without an anchor — the selected text contains "${unsafe_anchor}".`,
			);
		}
	}

	// EXPL: NEVER splice at a raw cursor: `selection.main.head` can sit INSIDE existing markup (a
	//       forward drag over `he{++llo++}` leaves the head at index 7; a cursor parked inside a
	//       comment body is the same story), and inserting `{>><<}` there cuts the range in half —
	//       `he{++ll{>><<}o++}` demotes the addition to inert text, `{>>he{>><<}llo<<}` truncates the
	//       comment and strands `llo<<}` plus a dangling `<<}`. Snapping to `full_range_back` — the
	//       same always-a-range-boundary position `commitReply` uses — is the only insertion point
	//       inside a range's span that is guaranteed to be well-formed.
	const cursor = range ? range.full_range_back : safe_insert_position(editor.state, selection.head);
	const reply_idx = range ? range.full_thread.length : -1;

	editor.dispatch(editor.state.update({
		changes: {
			from: cursor,
			to: cursor,
			insert: create_range(settings, SuggestionType.COMMENT, ""),
		},
		selection: EditorSelection.cursor(cursor),
		scrollIntoView: scroll,
		annotations: [commentModeAnnotation.of(true)],
	}));

	// EXPL: This code ensures that the input of a new comment is focused on when created
	// FIXME: A more canonical way is required to wait till the CM state update (the new comment element needs to be rendered)
	//   Some attempts that did not work:
	//    - using `sequential` in the `update` method
	activeWindow.setTimeout(() => {
		editor.dispatch(editor.state.update({
			annotations: [
				annotationGutterFocusAnnotation.of({
					from: cursor,
					to: cursor,
					index: reply_idx,
				}),
			],
		}));
	});
}

// EXPL: CriticMarkup has no escape syntax: `create_range` concatenates brackets around raw text, so
//       any sequence the PARSER treats as a terminator is a live grenade in free text. A `==}` in a
//       highlight's body closes it early and strands the rest of the anchor plus a bare `==}` in the
//       note; a `<<}` in a comment's body does the same to the comment; `@@` terminates the metadata
//       prefix (`{>>{"author":…}@@text<<}`), so with `add_metadata` on — the DEFAULT — an `@@`
//       anywhere in the body makes the range's own metadata unparseable. None of this mattered while
//       comment bodies were typed into markup the parser had already delimited; it matters now that
//       "wrap an ARBITRARY user selection, and take an ARBITRARY typed body" is the default flow.
const CLOSING_DELIMITERS = ["<<}", "==}", "++}", "--}", "~~}"];
const METADATA_TERMINATOR = "@@";

/** The first sequence in `text` that cannot survive being written into a CriticMarkup body. */
function unsafe_sequence(text: string, delimiters: string[]): string | undefined {
	return [...delimiters, METADATA_TERMINATOR].find(sequence => text.includes(sequence));
}

/**
 * `pos`, or — if `pos` falls strictly INSIDE a range's markup — the end of that range's thread.
 *
 * EXPL: The one position related to a range that is always safe to insert a comment at is
 *       `full_range_back`: it is a range boundary (never between brackets and body, never between a
 *       base and its replies), and the parser's adjacency rule turns a comment written there into a
 *       reply on that thread rather than junk spliced through someone else's delimiters. Every other
 *       offset in `[range.from, range.to]` cuts the range in half. Positions that merely TOUCH a
 *       range (`pos === range.from` / `pos === range.to`) are already boundaries and are left alone.
 */
function safe_insert_position(state: EditorState, pos: number): number {
	const ranges = state.field(rangeParser).ranges;
	const covering = ranges.ranges_overlapping_interval(pos, pos)[0];
	return covering ? covering.full_range_back : pos;
}

/**
 * Why the draft's anchor cannot be safely wrapped in `{==…==}` right now, or undefined if it can.
 *
 * EXPL: This RE-RUNS a check `addCommentToView` already made when it opened the draft, and that is
 *       the entire point. The draft anchor is LIVE: `commentDraftField` maps it through every
 *       intervening change and deliberately ABSORBS insertions made strictly inside it, precisely so
 *       that "blur the reply box, go fix a word, come back" works. So between open and commit the
 *       user can put markup INSIDE the anchor that was clean when the guard ran — type inside it in
 *       Suggest mode and CodeMirror writes `{++…++}` there; hit "Add reply" on a thread that lies
 *       inside it and a `{>>…<<}` lands there. Wrapping then produces nested markup, which cannot
 *       parse: the inner `==}`/`<<}` closes the outer highlight early, orphaning the rest of the
 *       anchor and leaving a dangling `==}` in the user's note, and any suggestion swallowed by the
 *       anchor silently stops being a tracked change. A precondition established at open time must
 *       be re-established at commit time, immediately before the write.
 */
function anchor_rejection(state: EditorState, draft: CommentDraft): string | undefined {
	const ranges = state.field(rangeParser).ranges;
	if (ranges.ranges_overlapping_interval(draft.from, draft.to).length)
		return "the selected text now contains tracked changes or comments";

	// EXPL: `==}` would close the wrapping highlight early; `@@` would be eaten as this highlight's
	//       own metadata terminator. Checked unconditionally rather than only when `add_metadata` is
	//       on: the setting is a toggle, the note is forever, and dropping an anchor is recoverable
	//       where a mangled note is not.
	const sequence = unsafe_sequence(state.sliceDoc(draft.from, draft.to), ["==}"]);
	return sequence && `the selected text contains "${sequence}"`;
}

/**
 * Reject a user-typed comment/reply body that cannot be written verbatim.
 *
 * EXPL: Refuse, never mangle. Silently stripping or escaping the user's own characters would be a
 *       second, quieter kind of data loss; the box stays open with the text intact so they can edit
 *       it. (The anchor, by contrast, DEGRADES rather than refusing — the user did not type it, so
 *       there is nothing for them to fix, and an unanchored comment still carries their words.)
 * EXPL: Exported because EVERY sink that feeds user-typed text to `create_range` needs it, not just
 *       the two in this file: the gutter card's comment editor (annotations-gutter/marker.ts) and
 *       the live-preview tooltip's comment/reply editors (live-preview/comment-widget.ts) write the
 *       same unescapable markup from the same free text. One function, one definition — a
 *       copy-pasted delimiter list is a hole waiting for the next delimiter.
 */
export function comment_text_rejected(text: string): boolean {
	const sequence = unsafe_sequence(text, CLOSING_DELIMITERS);
	if (!sequence)
		return false;

	new Notice(`Inkling: a comment cannot contain "${sequence}". Remove it and try again.`);
	return true;
}

/**
 * Append a comment to the end of `range`'s thread, in ONE transaction, from text already in hand.
 *
 * EXPL: Always targets `base_range.full_range_back`, never the passed range's own `to` — threads
 *       are flat (comment_range.ts:35-43), so replying to a mid-thread reply must still land at
 *       the END of the thread. Works for every base type: the parser's adjacency rule is
 *       type-agnostic, which is what makes "comment on a suggestion" fall out for free.
 * @returns false (writing nothing) if the editor is read-only, or the text is blank or unwritable.
 */
export function commitReply(editor: EditorView, range: CriticMarkupRange, text: string): boolean {
	// EXPL: CodeMirror's `readOnly` facet only blocks USER input — it does not stop a programmatic
	//       dispatch, and every write in this file is one. The reply box is reachable in a read-only
	//       editor (clicking a thread card opens it), so the refusal has to live here.
	if (editor.state.readOnly || !text.trim() || comment_text_rejected(text))
		return false;

	const settings = editor.state.field(pluginSettingsField);
	const cursor = range.base_range.full_range_back;

	editor.dispatch(editor.state.update({
		changes: { from: cursor, to: cursor, insert: create_range(settings, SuggestionType.COMMENT, text) },
		annotations: [commentModeAnnotation.of(true)],
	}));
	return true;
}

/**
 * Write the open comment draft to the note: highlight + comment, in ONE transaction.
 *
 * EXPL: Single dispatch on purpose — one Ctrl+Z takes the whole comment back out. The old flow
 *       needed two (insert empty markup, then save the text into it), so undo left the user with a
 *       stray `{>>@@<<}`.
 * @returns false (writing nothing, draft left open) if there is no draft, the editor is read-only,
 *          or the text is blank or unwritable.
 */
export function commitCommentDraft(editor: EditorView, text: string): boolean {
	const draft = editor.state.field(commentDraftField);
	if (editor.state.readOnly || !draft || !text.trim() || comment_text_rejected(text))
		return false;

	const settings = editor.state.field(pluginSettingsField);
	const comment = create_range(settings, SuggestionType.COMMENT, text);

	// EXPL: Degrade, do not corrupt, and do not throw the user's words away either. This mirrors
	//       `addCommentToView` above, which already answers "this selection cannot be wrapped" with
	//       a plain at-cursor comment — so an unanchored comment is this codebase's established
	//       fallback, not a new concept. The comment lands at the anchor's END, where it reads as
	//       being about the text just before it, and the Notice says why the anchor is missing so the
	//       user is never quietly given something other than what they asked for.
	const rejection = anchor_rejection(editor.state, draft);
	if (rejection) {
		// EXPL: `draft.to` is NOT automatically a safe place to write. This branch runs precisely
		//       BECAUSE markup is in or around the anchor, and the anchor's own end can sit inside
		//       it: type `{--` inside the anchor and the unterminated deletion swallows `draft.to`,
		//       so inserting there yields `alpha be{--ta{>>note<<} gamma` — one deletion with the
		//       user's comment buried inside it as inert text. Snap to the covering range's thread
		//       end, the same boundary `commitReply` writes at.
		const cursor = safe_insert_position(editor.state, draft.to);
		editor.dispatch(editor.state.update({
			changes: { from: cursor, to: cursor, insert: comment },
			effects: [clearCommentDraft.of(null)],
			annotations: [commentModeAnnotation.of(true)],
		}));
		new Notice(`Inkling: added the comment without an anchor — ${rejection}.`);
		return true;
	}

	const anchor_text = editor.state.sliceDoc(draft.from, draft.to);
	const insert = create_range(settings, SuggestionType.HIGHLIGHT, anchor_text) + comment;

	editor.dispatch(editor.state.update({
		changes: { from: draft.from, to: draft.to, insert },
		effects: [clearCommentDraft.of(null)],
		annotations: [commentModeAnnotation.of(true)],
	}));
	return true;
}
