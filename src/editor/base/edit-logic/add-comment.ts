import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { CriticMarkupRange, SuggestionType } from "../ranges";

import { rangeParser } from "../edit-util";
import { create_range } from "../edit-util/range-create";

import {
	annotationGutterFocusAnnotation,
	annotationGutterFoldAnnotation,
} from "../../renderers/gutters/annotations-gutter";
import { pendingAnnotationMarkers } from "../../renderers/gutters/annotations-gutter/pending-marker";
import { pluginSettingsField } from "../../uix";
import { clearCommentDraft, commentDraftField, setCommentDraft } from "../../uix/extensions/comment-draft";
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
		if (ranges.ranges_in_interval(selection.from, selection.to).length === 0) {
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

			const anchor_text = editor.state.sliceDoc(selection.from, selection.to);
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
	}

	const cursor = range ? range.full_range_back : editor.state.selection.main.head;
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
