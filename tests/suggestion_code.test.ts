import { EditorView } from "@codemirror/view";

import { editorEditorField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
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
});
