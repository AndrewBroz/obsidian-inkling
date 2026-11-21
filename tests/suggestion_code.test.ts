import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import * as obsidian from "obsidian";
import { editorEditorField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { suggestionMode } from "../src/editor/uix/extensions";
import { createRangeState } from "./helpers";

// EXPL: In Suggest mode, a change touching a code block (its content or a fence line) is applied exactly as typed,
//       untracked; every other change is tracked as usual (0.13.0 spec, addendum: fence handling).

const DOC = "intro\n```js\nlet a = 1;\n```\nafter";

let notices: jest.SpyInstance;
beforeEach(() => {
	notices = jest.spyOn(obsidian, "Notice").mockImplementation(() => ({}) as obsidian.Notice);
});
afterEach(() => {
	expect(notices).not.toHaveBeenCalled();
	notices.mockRestore();
});

/** `doc` after replacing each [from, to) with its `insert` at once, one cursor per change, in Suggest mode. */
function edit(doc: string, changes: { from: number; to?: number; insert?: string }[]): string {
	const view = new EditorView({
		state: createRangeState(doc, { add_metadata: false }, [
			editorEditorField,
			EditorState.allowMultipleSelections.of(true),
			suggestionMode({ ...DEFAULT_SETTINGS, add_metadata: false }),
		]),
	});
	view.dispatch({
		selection: EditorSelection.create(changes.map(c => EditorSelection.range(c.from, c.to ?? c.from))),
	});
	let offset = 0;
	const cursors = changes.map(c => {
		const at = c.from + (c.insert?.length ?? 0) + offset;
		offset += (c.insert?.length ?? 0) - ((c.to ?? c.from) - c.from);
		return EditorSelection.cursor(at);
	});
	view.dispatch(view.state.update({ changes, selection: EditorSelection.create(cursors), userEvent: "input" }));
	return view.state.doc.toString();
}

/** `doc` with the same changes applied plainly. */
function plain(doc: string, changes: { from: number; to?: number; insert?: string }[]): string {
	return EditorState.create({ doc }).update({ changes }).state.doc.toString();
}

const code = DOC.indexOf("1;"), opener = DOC.indexOf("```js"), closer = DOC.lastIndexOf("```");

describe("changes touching a code block are untracked", () => {
	test.each([
		["typing in the code", [{ from: code, insert: "9" }]],
		["deleting in the code", [{ from: code, to: code + 1 }]],
		["pasting lines in the code", [{ from: code, insert: "x\n```\ny {++z++}\n" }]],
		["typing on the opening fence line", [{ from: opener + 3, insert: "ts" }]],
		["typing at the start of the opening fence line", [{ from: opener, insert: "x" }]],
		["deleting part of the closing fence", [{ from: closer, to: closer + 2 }]],
		["Enter after the closing fence", [{ from: closer + 3, insert: "\n" }]],
		["a selection from the code into prose, replaced", [{ from: code, to: DOC.length - 2, insert: "Q" }]],
	])("%s", (_, changes) => {
		expect(edit(DOC, changes)).toBe(plain(DOC, changes));
	});

	test("an unclosed block runs to the end of the note", () => {
		const doc = "a\n```\nb";
		expect(edit(doc, [{ from: 7, insert: "c" }])).toBe("a\n```\nbc");
	});
});

test("typing in prose is tracked", () => {
	expect(edit(DOC, [{ from: 5, insert: "X" }])).toBe(DOC.replace("intro", "intro{++X++}"));
});

test("two cursors, one in prose and one in code: the prose edit is tracked, the code edit plain", () => {
	expect(edit(DOC, [{ from: 2, insert: "X" }, { from: code, insert: "9" }]))
		.toBe("in{++X++}tro\n```js\nlet a = 91;\n```\nafter");
	expect(edit(DOC, [{ from: code, insert: "9" }, { from: DOC.length, insert: "X" }]))
		.toBe("intro\n```js\nlet a = 91;\n```\nafter{++X++}");
});
