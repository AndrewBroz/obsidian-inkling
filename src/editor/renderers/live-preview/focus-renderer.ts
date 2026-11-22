import { type EditorState, type Extension, type Range, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { type CriticMarkupRange, rangeParser } from "../../base";
import { code_link_of } from "../../base/edit-util/code-comments";
import { code_block_outline, code_quote_decoration } from "../../uix/extensions/code-decorations";

type MarkupFocus = { from: number; to: number; unfocus?: boolean };
export const markupFocusEffect = StateEffect.define<MarkupFocus>();
export const markupFocusState = StateField.define<MarkupFocus>({
	create(state) {
		return { from: state.selection.main.from, to: state.selection.main.to };
	},

	update(value, tr) {
		for (let e of tr.effects) {
			if (e.is(markupFocusEffect))
				return e.value;
		}
		return value;
	},
});

/**
 * For a focused comment on code, what it is about: its quote highlighted in the block, or the whole block outlined
 * when it has no quote or its quote is no longer there. Decorations only; the code never changes.
 */
function code_focus(state: EditorState, range: CriticMarkupRange): Range<Decoration>[] {
	const link = code_link_of(state, range);
	if (!link) return [];
	if (typeof link.target === "object") return [code_quote_decoration(link.target.from, link.target.to)];
	return code_block_outline(state.doc, link.region.from, link.region.to);
}

export const focusRenderer = StateField.define<DecorationSet>({
	create(state): DecorationSet {
		return Decoration.none;
	},

	update(oldSet: DecorationSet, tr) {
		const markupStartFocus = tr.startState.field(markupFocusState, false);
		const markupEndFocus = tr.state.field(markupFocusState);

		if (markupStartFocus !== markupEndFocus) {
			const ranges = tr.state.field(rangeParser).ranges.ranges_in_interval(markupEndFocus.from, markupEndFocus.to);
			if (
				ranges.length &&
				ranges[0].base_range === ranges.at(-1)?.base_range &&
				markupEndFocus.from >= ranges[0].from && markupEndFocus.to <= ranges.at(-1)!.to
			) {
				return RangeSet.of<Decoration>(
					[
						Decoration
							.mark({ attributes: { "class": "cmtr-focused" } })
							.range(ranges[0].full_range_front, ranges[0].full_range_back),
						...code_focus(tr.state, ranges[0]),
					],
					true,
				);
			} else {
				return Decoration.none;
			}
		} else {
			// EXPL: Map through the changes rather than returning the set verbatim. A transaction that
			//       edits the document without moving the selection leaves the focus decoration's
			//       from/to pointing at pre-change offsets, so the focused span drifts off the range it
			//       is meant to be marking (and, once positions land outside the doc, CodeMirror throws).
			return tr.docChanged ? oldSet.map(tr.changes) : oldSet;
		}
	},

	provide(field: StateField<DecorationSet>): Extension {
		return EditorView.decorations.from(field);
	},
});
