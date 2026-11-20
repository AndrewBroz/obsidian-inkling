import { App } from "obsidian";

import { toOriginalText } from "../src/api/original-text";
import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import { SuggestionType } from "../src/editor/base/ranges";
import { postProcess } from "../src/editor/renderers/post-process/renderer";
import { createRangeState } from "./helpers";

// EXPL: CriticMarkup whose opener lies inside a fenced code block is code, not markup. Every parse path goes
//       through cursorGenerateRanges, so the editor state, reading view, vault index and original-text API agree.
const spans = (doc: string, ignore_code = true) =>
	getRangesInText(doc, DEFAULT_SETTINGS, ignore_code).map(range => [range.type, range.from, range.to]);

const IN_FENCE = "a {++x++}\n```\n{++code++}\n```\n{--y--}";
const OPENER_IN_FENCE = "```\n{++a\n```\nb++} {==h==}";
const UNCLOSED = "{++x++}\n```\n{++y++}";
const SUGGESTED_BLOCK = "{++```\nx\n```++} {--d--}";
const INLINE = "`{==h==}`";

describe("parser ignores ranges opened inside fenced code", () => {
	test("range in fence ignored", () => {
		expect(spans(IN_FENCE)).toEqual([
			[SuggestionType.ADDITION, 2, 9],
			[SuggestionType.DELETION, 29, 36],
		]);
	});

	test("opener in fence paired with closer in prose doesn't swallow later ranges", () => {
		expect(spans(OPENER_IN_FENCE)).toEqual([[SuggestionType.HIGHLIGHT, 18, 25]]);
	});

	test("unclosed fence runs to end", () => {
		expect(spans(UNCLOSED)).toEqual([[SuggestionType.ADDITION, 0, 7]]);
	});

	test("suggested code block stays a range", () => {
		expect(spans(SUGGESTED_BLOCK)).toEqual([
			[SuggestionType.ADDITION, 0, 15],
			[SuggestionType.DELETION, 16, 23],
		]);
	});

	test("inline code still parsed", () => {
		expect(spans(INLINE)).toEqual([[SuggestionType.HIGHLIGHT, 1, 8]]);
	});

	test("ignore_code=false returns raw ranges", () => {
		expect(spans(IN_FENCE, false)).toEqual([
			[SuggestionType.ADDITION, 2, 9],
			[SuggestionType.ADDITION, 14, 24],
			[SuggestionType.DELETION, 29, 36],
		]);
	});

	test.each([IN_FENCE, OPENER_IN_FENCE, UNCLOSED, SUGGESTED_BLOCK, INLINE])("editor state agrees: %j", doc => {
		const state = createRangeState(doc);
		const parsed = state.field(rangeParser).ranges.ranges.map(range => [range.type, range.from, range.to]);
		expect(parsed).toEqual(spans(doc));
	});

	test("original-text API skips code", () => {
		const doc = "```\n{++code++}\n```";
		expect(toOriginalText(doc)).toBe(doc);
	});
});

describe("reading view leaves code blocks alone", () => {
	test("a pre element is not post-processed", async () => {
		const el = document.createElement("pre");
		el.innerHTML = "<code>{++code++}</code>";
		(el as any).getHTML = function(this: HTMLElement) {
			return this.innerHTML;
		};
		(el as any).empty = function(this: HTMLElement) {
			this.replaceChildren();
		};
		const plugin: any = { app: Object.assign(new App(), { workspace: {} }), settings: { ...DEFAULT_SETTINGS } };
		await postProcess(el, null as any, plugin);
		expect(el.innerHTML).toBe("<code>{++code++}</code>");
	});
});
