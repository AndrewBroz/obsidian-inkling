import { type Extension, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { rangeParser } from "../../base";

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
					],
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
