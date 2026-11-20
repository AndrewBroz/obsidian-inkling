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
});
