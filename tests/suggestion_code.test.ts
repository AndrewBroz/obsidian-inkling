import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorEditorField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { findCodeRegions } from "../src/editor/base/edit-util/code-regions";
import { suggestionMode } from "../src/editor/uix/extensions";
import { createRangeState } from "./helpers";

const DOC = "```\nab\n```";

function suggestView(doc: string): EditorView {
	return new EditorView({
		state: createRangeState(doc, { add_metadata: false }, [
			editorEditorField,
			EditorState.allowMultipleSelections.of(true),
			suggestionMode({ ...DEFAULT_SETTINGS, add_metadata: false }),
		]),
	});
}

describe("suggest mode and fenced code", () => {
	test("typing inside a fence is untracked", () => {
		const view = suggestView(DOC);
		view.dispatch({ changes: { from: 5, insert: "X" }, userEvent: "input.type" });
		expect(view.state.doc.toString()).toBe("```\naXb\n```");
		expect(view.state.doc.toString()).not.toContain("{++");
	});

	test("deleting inside a fence is untracked", () => {
		const view = suggestView(DOC);
		view.dispatch({ changes: { from: 4, to: 5 }, userEvent: "delete.backward" });
		expect(view.state.doc.toString()).toBe("```\nb\n```");
	});

	test("an edit crossing a fence edge is tracked", () => {
		const view = suggestView("hi\n" + DOC);
		view.dispatch({ changes: { from: 1, to: 8 }, userEvent: "delete.selection" });
		expect(view.state.doc.toString()).toContain("{--");
	});

	test("typing in prose is still tracked", () => {
		const view = suggestView("hi\n\n" + DOC);
		view.dispatch({ changes: { from: 2, insert: "X" }, userEvent: "input.type" });
		expect(view.state.doc.toString()).toContain("{++X++}");
	});

	test("typing at the start of the first content line is untracked", () => {
		const view = suggestView(DOC);
		view.dispatch({ changes: { from: 4, insert: "X" }, userEvent: "input.type" });
		expect(view.state.doc.toString()).toBe("```\nXab\n```");
	});

	test("Enter at the end of a closing fence is tracked and keeps the fence closed", () => {
		const view = suggestView("```\nx\n```\nafter {++y++}");
		view.dispatch({ changes: { from: 9, insert: "\n" }, userEvent: "input" });
		expect(view.state.doc.toString()).toBe("```\nx\n```{++\n++}\nafter {++y++}");
		const parsed = view.state.field(rangeParser);
		expect(parsed.code_regions.map(r => [r.from, r.to])).toEqual([[0, 9]]);
		expect(parsed.ranges.ranges.length).toBe(2);
	});

	test("deleting a whole block is tracked", () => {
		const view = suggestView("hi\n" + DOC);
		view.dispatch({ changes: { from: 3, to: 3 + DOC.length }, userEvent: "delete.selection" });
		expect(view.state.doc.toString()).toContain("{--");
	});

	test("deleting just the closing fence is tracked", () => {
		const view = suggestView(DOC);
		view.dispatch({ changes: { from: 7, to: 10 }, userEvent: "delete.selection" });
		expect(view.state.doc.toString()).toContain("{--");
	});

	test("typing at the start of the opening fence is tracked", () => {
		const view = suggestView("hi\n" + DOC);
		view.dispatch({ changes: { from: 3, insert: "X" }, userEvent: "input.type" });
		expect(view.state.doc.toString()).toContain("{++X++}");
	});

	test.each([
		["```\nx\n```\nafter {++y++}", 3],
		["~~~\nx\n~~~\nafter {++y++}", 3],
		["```js\nx\n```\nafter {++y++}", 5],
		["```\n```\nafter {++y++}", 3],
	])("Enter at the end of the opening fence of %j is a plain newline", (doc, at) => {
		const view = suggestView(doc);
		view.dispatch({ changes: { from: at, insert: "\n" }, userEvent: "input" });
		const text = view.state.doc.toString();
		expect(text).toBe(doc.slice(0, at) + "\n" + doc.slice(at));
		const parsed = view.state.field(rangeParser);
		expect(parsed.code_regions).toEqual(findCodeRegions(text));
		expect(parsed.ranges.ranges.map(r => text.slice(r.from, r.to))).toEqual(["{++y++}"]);
	});

	test("typing an info string at the end of the opening fence is untracked", () => {
		const view = suggestView(DOC);
		view.dispatch({ changes: { from: 3, insert: "js" }, userEvent: "input.type" });
		expect(view.state.doc.toString()).toBe("```js\nab\n```");
	});

	test.each([false, true])("a multi-cursor edit tracks the prose change and leaves the code change plain (code first: %s)", code_first => {
		const doc = "hi\n\n```\nab\n```";
		const view = suggestView(doc);
		const cursors = code_first ? [9, 2] : [2, 9];
		view.dispatch(view.state.update({
			changes: cursors.map(at => ({ from: at, insert: "X" })),
			selection: EditorSelection.create(cursors.map(at => EditorSelection.cursor(at)), 0),
			userEvent: "input.type",
		}));
		const text = view.state.doc.toString();
		expect(text).toBe("hi{++X++}\n\n```\naXb\n```");
		const heads = view.state.selection.ranges.map(r => r.head).sort((a, b) => a - b);
		expect(heads).toEqual([text.indexOf("X") + 1, text.indexOf("aX") + 2]);
	});

	describe("the closing fence is protected", () => {
		const FENCED = "```\nx\n```\nafter {++y++}";

		function expectIntact(view: EditorView, region_count = 1) {
			const text = view.state.doc.toString();
			const parsed = view.state.field(rangeParser);
			expect(parsed.code_regions).toEqual(findCodeRegions(text));
			expect(parsed.code_regions).toHaveLength(region_count);
			expect(parsed.code_regions[0].to).toBe(text.indexOf("```", parsed.code_regions[0].inner_to) + 3);
			expect(parsed.ranges.ranges.map(r => text.slice(r.from, r.to))).toEqual(["{++y++}"]);
		}

		test("typing at the start of the closing fence line goes on a new line above it", () => {
			const view = suggestView(FENCED);
			view.dispatch({ changes: { from: 6, insert: "a" }, selection: { anchor: 7 }, userEvent: "input.type" });
			expect(view.state.doc.toString()).toBe("```\nx\na\n```\nafter {++y++}");
			expect(view.state.selection.main.head).toBe(7);
			expectIntact(view);
		});

		test("pasting several lines there keeps the fence on its own line", () => {
			const view = suggestView(FENCED);
			view.dispatch({ changes: { from: 6, insert: "\na\nb" }, userEvent: "input.paste" });
			expect(view.state.doc.toString()).toBe("```\nx\n\na\nb\n```\nafter {++y++}");
			expectIntact(view);
		});

		test("Enter there is left alone", () => {
			const view = suggestView(FENCED);
			view.dispatch({ changes: { from: 6, insert: "\n" }, userEvent: "input" });
			expect(view.state.doc.toString()).toBe("```\nx\n\n```\nafter {++y++}");
			expectIntact(view);
		});

		test("Backspace joining the closing fence onto a non-empty line is refused", () => {
			const view = suggestView(FENCED);
			view.dispatch({ selection: { anchor: 6 } });
			view.dispatch({ changes: { from: 5, to: 6 }, selection: { anchor: 5 }, userEvent: "delete.backward" });
			expect(view.state.doc.toString()).toBe(FENCED);
			expect(view.state.selection.main.head).toBe(6);
		});

		test("Backspace joining the closing fence onto the opening fence is refused", () => {
			const doc = "```\n```\nafter {++y++}";
			const view = suggestView(doc);
			view.dispatch({ changes: { from: 3, to: 4 }, userEvent: "delete.backward" });
			expect(view.state.doc.toString()).toBe(doc);
		});

		test("Backspace removing an empty line above the closing fence is allowed, untracked", () => {
			const view = suggestView("```\nx\n\n```");
			view.dispatch({ changes: { from: 6, to: 7 }, userEvent: "delete.backward" });
			expect(view.state.doc.toString()).toBe("```\nx\n```");
		});

		test("selecting and deleting the closing fence is tracked", () => {
			const view = suggestView(FENCED);
			view.dispatch({ changes: { from: 6, to: 9 }, userEvent: "delete.selection" });
			expect(view.state.doc.toString()).toContain("{--");
		});

		test("an unclosed block is not affected", () => {
			const view = suggestView("```\nx\n");
			view.dispatch({ changes: { from: 6, insert: "a" }, userEvent: "input.type" });
			expect(view.state.doc.toString()).toBe("```\nx\na");
		});
	});
});
