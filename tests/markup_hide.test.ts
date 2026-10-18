import { EditorSelection, type Range } from "@codemirror/state";
import type { Decoration, EditorView } from "@codemirror/view";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { constructDecorations } from "../src/editor/renderers/live-preview/markup-renderer";
import { EditMode, type PluginSettings, PreviewMode } from "../src/types";
import { createRangeState } from "./helpers";

function decorate(doc: string, selections: EditorSelection | null, overrides: Partial<PluginSettings> = {}) {
	const settings: PluginSettings = { ...DEFAULT_SETTINGS, ...overrides };
	const state = createRangeState(doc, overrides);
	const ranges = state.field(rangeParser).ranges.ranges;
	const decorations = constructDecorations(
		null as unknown as EditorView,
		ranges,
		selections,
		PreviewMode.ALL,
		EditMode.CORRECTED,
		settings,
	);
	return { range: ranges[0], decorations };
}

function replaceSpans(decorations: Range<Decoration>[]) {
	return decorations
		.filter(deco => deco.value.spec.attributes?.class === undefined)
		.map(deco => ({ from: deco.from, to: deco.to }));
}

describe("live preview hides trailing attribute blocks", () => {
	const DOC = "{++new++}{author=A}";

	test("closer and block are hidden, content stays visible", () => {
		const { range, decorations } = decorate(DOC, null);
		expect(range.meta?.syntax).toBe("attributes");
		const spans = replaceSpans(decorations);
		expect(spans).toContainEqual({ from: range.closer_to - 3, to: range.closer_to });
		expect(spans).toContainEqual({ from: range.meta!.from, to: range.meta!.to });
		expect(spans).not.toContainEqual({ from: 3, to: 6 });
	});

	test("show_metadata with the cursor inside the range reveals the block", () => {
		const { range, decorations } = decorate(DOC, EditorSelection.single(5), { reveal_syntax_on_focus: true });
		const hidden = replaceSpans(decorations)
			.some(span => span.from === range.meta!.from && span.to === range.meta!.to);
		expect(hidden).toBe(false);
	});
});
