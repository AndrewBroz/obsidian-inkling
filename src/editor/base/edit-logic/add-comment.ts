import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { CriticMarkupRange, SuggestionType } from "../ranges";

import { rangeParser } from "../edit-util";
import { create_range } from "../edit-util/range-create";

import { annotationGutterFocusAnnotation } from "../../renderers/gutters/annotations-gutter";
import { pluginSettingsField } from "../../uix";

export function addCommentToView(
	editor: EditorView,
	range: CriticMarkupRange | undefined,
	scroll: boolean = false,
): void {
	const settings = editor.state.field(pluginSettingsField);

	const selection = editor.state.selection.main;

	// EXPL: GDocs-style anchored comment — wrap a clean selection in a highlight range;
	//       the adjacent comment attaches to it as a thread via the parser's adjacency rule.
	//       CriticMarkup cannot nest, so any selection touching existing markup falls back
	//       to the plain at-cursor comment below.
	if (!range && !selection.empty) {
		const ranges = editor.state.field(rangeParser).ranges;
		if (ranges.ranges_in_interval(selection.from, selection.to).length === 0) {
			const anchor_text = editor.state.sliceDoc(selection.from, selection.to);
			const insert = create_range(settings, SuggestionType.HIGHLIGHT, anchor_text) +
				create_range(settings, SuggestionType.COMMENT, "");
			editor.dispatch(editor.state.update({
				changes: { from: selection.from, to: selection.to, insert },
				selection: EditorSelection.cursor(selection.from + insert.length - 3),
				scrollIntoView: scroll,
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
