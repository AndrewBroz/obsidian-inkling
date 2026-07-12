import { EditorSelection, type Range } from "@codemirror/state";
import type { Decoration, EditorView } from "@codemirror/view";
import type { App } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import type { CriticMarkupRange } from "../src/editor/base/ranges";
import { constructDecorations } from "../src/editor/renderers/live-preview/markup-renderer";
import { rangePostProcess } from "../src/editor/renderers/post-process/renderer";
import { EditMode, type PluginSettings, PreviewMode } from "../src/types";
import { createRangeState } from "./helpers";

// EXPL: constructDecorations is a pure function of (ranges, settings) as long as no selection is
// passed; the EditorView argument is only stored inside CommentIconWidget (never dereferenced at
// construction time), so decoration construction is exercisable fully headlessly.
function parseAndDecorate(doc: string, overrides: Partial<PluginSettings> = {}) {
	const settings: PluginSettings = { ...DEFAULT_SETTINGS, ...overrides };
	const state = createRangeState(doc, overrides);
	const ranges = state.field(rangeParser).ranges.ranges;
	const decorations = constructDecorations(
		null as unknown as EditorView,
		ranges,
		null,
		PreviewMode.ALL,
		EditMode.CORRECTED,
		settings,
	);
	return { ranges, decorations };
}

function markClasses(decorations: Range<Decoration>[]): string[] {
	return decorations
		.filter(deco => deco.value.spec.attributes?.class !== undefined)
		.map(deco => deco.value.spec.attributes!.class as string);
}

function replaceSpans(decorations: Range<Decoration>[]): { from: number; to: number; widget: boolean }[] {
	return decorations
		.filter(deco => deco.value.spec.attributes?.class === undefined)
		.map(deco => ({ from: deco.from, to: deco.to, widget: deco.value.spec.widget !== undefined }));
}

describe("constructDecorations for resolved threads (live preview)", () => {
	test("unresolved anchored highlight keeps its type styling", () => {
		const { decorations } = parseAndDecorate("x{==sel==}{>>c<<}y");

		const classes = markClasses(decorations);
		expect(classes.some(cls => cls.includes("cmtr-highlight") && cls.includes("cmtr-has-reply"))).toBe(true);
		expect(classes.some(cls => cls.includes("cmtr-resolved"))).toBe(false);
	});

	test("resolved anchored highlight renders as plain text, brackets and metadata still hidden", () => {
		const doc = `x{=={"done":true}@@sel==}{>>{"done":true}@@c<<}y`;
		const { ranges, decorations } = parseAndDecorate(doc);
		const highlight = ranges[0];

		// EXPL: The type style is replaced by the theme hook class
		const classes = markClasses(decorations);
		expect(classes).toContain("cmtr-inline cmtr-resolved");
		expect(classes.some(cls => cls.includes("cmtr-highlight"))).toBe(false);

		// EXPL: Brackets and the metadata blob remain hidden (replace decorations)
		const replaces = replaceSpans(decorations);
		expect(replaces).toContainEqual({ from: highlight.from, to: highlight.from + 3, widget: false });
		expect(replaces).toContainEqual({ from: highlight.to - 3, to: highlight.to, widget: false });
		expect(replaces).toContainEqual({ from: highlight.from + 3, to: highlight.metadata! + 2, widget: false });
	});

	test("unresolved standalone comment renders the comment icon widget", () => {
		const { ranges, decorations } = parseAndDecorate("x{>>hi<<}y");

		const replaces = replaceSpans(decorations);
		expect(replaces).toContainEqual({ from: ranges[0].from, to: ranges[0].to, widget: true });
	});

	test("resolved comment suppresses the icon widget and hides the whole range", () => {
		const doc = `x{>>{"done":true}@@hi<<}y`;
		const { ranges, decorations } = parseAndDecorate(doc);

		const replaces = replaceSpans(decorations);
		expect(replaces).toContainEqual({ from: ranges[0].from, to: ranges[0].to, widget: false });
		expect(replaces.some(span => span.widget)).toBe(false);

		// EXPL: No mark decoration exists for the range at all — no icon, no visible content
		const classes = markClasses(decorations);
		expect(classes.some(cls => cls.includes("cmtr-comment") || cls.includes("cmtr-resolved"))).toBe(false);
	});

	test("resolved comment in inline style renders as nothing, not plain text", () => {
		const doc = `x{>>{"done":true}@@hi<<}y`;
		const { ranges, decorations } = parseAndDecorate(doc, { comment_style: "inline" });

		// EXPL: Comment text is not document text (unlike a resolved highlight's anchor) — the
		//       whole span is replaced/hidden rather than falling through to the plain-text branch
		const classes = markClasses(decorations);
		expect(classes.some(cls => cls.includes("cmtr-resolved"))).toBe(false);
		expect(classes.some(cls => cls.includes("cmtr-comment"))).toBe(false);

		const replaces = replaceSpans(decorations);
		expect(replaces).toContainEqual({ from: ranges[0].from, to: ranges[0].to, widget: false });
	});

	test("resolved comment hides the full span even when show_comment is active and cursor is inside", () => {
		const doc = `x{>>{"done":true}@@hi<<}y`;
		const settings: PluginSettings = {
			...DEFAULT_SETTINGS,
			markup_focus: {
				...DEFAULT_SETTINGS.markup_focus,
				[EditMode.CORRECTED]: { ...DEFAULT_SETTINGS.markup_focus[EditMode.CORRECTED], show_comment: true },
			},
		};
		const state = createRangeState(doc, settings);
		const ranges = state.field(rangeParser).ranges.ranges;
		// EXPL: Place the cursor inside the comment range so `in_range` is true
		const selection = EditorSelection.single(ranges[0].from + 1);
		const decorations = constructDecorations(
			null as unknown as EditorView,
			ranges,
			selection,
			PreviewMode.ALL,
			EditMode.CORRECTED,
			settings,
		);

		const classes = markClasses(decorations);
		expect(classes.some(cls => cls.includes("cmtr-resolved") || cls.includes("cmtr-comment"))).toBe(false);

		const replaces = replaceSpans(decorations);
		expect(replaces).toContainEqual({ from: ranges[0].from, to: ranges[0].to, widget: false });
	});
});

describe("postprocess for resolved ranges (reading view)", () => {
	function topRange(doc: string): CriticMarkupRange {
		const state = createRangeState(doc);
		return state.field(rangeParser).ranges.ranges[0];
	}

	test("unresolved highlight emits its type class", () => {
		const rendered = topRange("{==sel==}").postprocess() as string;
		expect(rendered).toContain("class='cmtr-highlight'");
		expect(rendered).toContain("sel");
	});

	test("resolved highlight emits cmtr-resolved instead of the type class", () => {
		const rendered = topRange(`{=={"done":true}@@sel==}`).postprocess() as string;
		expect(rendered).toContain("class='cmtr-resolved'");
		expect(rendered).not.toContain("cmtr-highlight");
		expect(rendered).toContain("sel");
	});

	test("resolved comment renders as nothing — no icon, no inline text", () => {
		const range = topRange(`{>>{"done":true}@@hi<<}`);
		const rendered = rangePostProcess(null as unknown as App, range);
		expect(rendered).toBe("");
	});
});
