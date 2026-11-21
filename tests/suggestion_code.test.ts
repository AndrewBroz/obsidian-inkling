import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import * as obsidian from "obsidian";
import { editorEditorField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { suggestionMode } from "../src/editor/uix/extensions";
import { editorKeypressCatcher } from "../src/editor/uix/extensions/keypress-catcher";
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

describe("changes inserting or deleting a fence line are untracked, and later suggestions still parse", () => {
	const NOTE = "intro\n\nlater {==note==}{>>c<<}";

	function view(doc: string) {
		return new EditorView({
			state: createRangeState(doc, { add_metadata: false }, [
				editorEditorField,
				editorKeypressCatcher,
				suggestionMode({ ...DEFAULT_SETTINGS, add_metadata: false }),
			]),
		});
	}
	const ranges = (v: EditorView) =>
		v.state.field(rangeParser).ranges.ranges.map(r => v.state.doc.sliceString(r.from, r.to));

	test("pasting a block with prose", () => {
		const v = view(NOTE);
		v.dispatch({ changes: { from: 6, insert: "see:\n```js\nlet a;\n```\n" }, userEvent: "input.paste" });
		expect(v.state.doc.toString()).toBe("intro\nsee:\n```js\nlet a;\n```\n\nlater {==note==}{>>c<<}");
		expect(ranges(v)).toEqual(["{==note==}", "{>>c<<}"]);
	});

	// FIXME: Needs the owner's decision. Typed one character at a time, the block's lines go into an addition, so its
	//        closer lands on the closing fence line (`{++```\nlet a;\n```++}`), which then opens a block running to the
	//        end of the note. No untracked rule fixes that without moving the closer off the fence line.
	test.failing("typing a block", () => {
		const v = view(NOTE);
		v.dispatch({ selection: { anchor: 6 } });
		for (const ch of "```\nlet a;\n```") {
			v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: ch === "\n" ? "Enter" : ch, bubbles: true }));
			v.dispatch(v.state.replaceSelection(ch), { userEvent: "input.type" });
		}
		expect(ranges(v).slice(-2)).toEqual(["{==note==}", "{>>c<<}"]);
		expect(v.state.field(rangeParser).code_regions).toHaveLength(1);
	});

	test("deleting a block with prose", () => {
		const doc = "intro\n```js\nlet a;\n```\nmore\n\nlater {==note==}{>>c<<}";
		const v = view(doc);
		const to = doc.indexOf("more") + 2;
		v.dispatch({ selection: { anchor: 2, head: to } });
		v.dispatch({ changes: { from: 2, to }, selection: { anchor: 2 }, userEvent: "delete.selection" });
		expect(v.state.doc.toString()).toBe("inre\n\nlater {==note==}{>>c<<}");
		expect(ranges(v)).toEqual(["{==note==}", "{>>c<<}"]);
	});
});
