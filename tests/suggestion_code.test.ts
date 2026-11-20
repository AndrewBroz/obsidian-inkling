import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import * as obsidian from "obsidian";
import { editorEditorField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { findCodeRegions } from "../src/editor/base/edit-util/code-regions";
import { suggestionMode } from "../src/editor/uix/extensions";
import { createRangeState } from "./helpers";

// EXPL: Suggest mode never writes CriticMarkup on a fence line or inside code (0.13.0 spec, addendum: simplified fence
//       handling). Every test checks that the editor state's regions equal a fresh scan and that no block holds a
//       delimiter, besides its specific expectation.

const DOC = "```\nab\n```";
const DELIMITER = /\{(?:\+\+|--|~~|==|>>)|(?:\+\+|--|~~|==|<<)\}|~>/;

let notices: jest.SpyInstance;
beforeEach(() => {
	notices = jest.spyOn(obsidian, "Notice").mockImplementation(() => ({}) as obsidian.Notice);
});
afterEach(() => notices.mockRestore());

function suggestView(doc: string): EditorView {
	return new EditorView({
		state: createRangeState(doc, { add_metadata: false }, [
			editorEditorField,
			EditorState.allowMultipleSelections.of(true),
			suggestionMode({ ...DEFAULT_SETTINGS, add_metadata: false }),
		]),
	});
}

/** The document, its blocks (as text) and its ranges (as text), after checking the invariants. */
function parsed(view: EditorView) {
	const text = view.state.doc.toString();
	const field = view.state.field(rangeParser);
	expect(field.code_regions).toEqual(findCodeRegions(text));
	const blocks = field.code_regions.map(r => text.slice(r.from, r.to));
	for (const block of blocks) expect(block).not.toMatch(DELIMITER);
	return { text, blocks, ranges: field.ranges.ranges.map(r => text.slice(r.from, r.to)) };
}

function edit(
	view: EditorView,
	selection: [number, number][],
	changes: { from: number; to?: number; insert?: string }[],
) {
	view.dispatch({ selection: EditorSelection.create(selection.map(([a, h]) => EditorSelection.range(a, h))) });
	let offset = 0;
	const cursors = changes.map(c => {
		const at = c.from + (c.insert?.length ?? 0) + offset;
		offset += (c.insert?.length ?? 0) - ((c.to ?? c.from) - c.from);
		return EditorSelection.cursor(at);
	});
	view.dispatch(view.state.update({ changes, selection: EditorSelection.create(cursors), userEvent: "input" }));
}

/** The text with every suggestion accepted. */
function accepted(view: EditorView): string {
	let text = view.state.doc.toString();
	for (const range of [...view.state.field(rangeParser).ranges.ranges].reverse())
		text = text.slice(0, range.from) + range.accept() + text.slice(range.to);
	return text;
}

describe("rule 1: edits inside a code block are plain", () => {
	test.each([
		["typing in the content", { from: 5, insert: "X" }, "```\naXb\n```"],
		["typing at the start of the first content line", { from: 4, insert: "X" }, "```\nXab\n```"],
		["deleting in the content", { from: 4, to: 5 }, "```\nb\n```"],
		["typing an info string", { from: 3, insert: "js" }, "```js\nab\n```"],
	])("%s", (_, change, expected) => {
		const view = suggestView(DOC);
		view.dispatch({ changes: change, userEvent: "input.type" });
		expect(parsed(view).text).toBe(expected);
	});

	test.each([
		["```\nx\n```\nafter {++y++}", 3],
		["~~~\nx\n~~~\nafter {++y++}", 3],
		["```js\nx\n```\nafter {++y++}", 5],
		["```\n```\nafter {++y++}", 3],
	])("Enter at the end of the opening fence of %j is a plain newline", (doc, at) => {
		const view = suggestView(doc);
		view.dispatch({ changes: { from: at, insert: "\n" }, userEvent: "input" });
		const { text, ranges } = parsed(view);
		expect(text).toBe(doc.slice(0, at) + "\n" + doc.slice(at));
		expect(ranges).toEqual(["{++y++}"]);
	});

	test("B6: replacing everything between the fence lines keeps both fences on their lines", () => {
		const view = suggestView("```\nx\n```\nafter {++y++}");
		view.dispatch({ changes: { from: 3, to: 6, insert: "Z" }, selection: { anchor: 4 }, userEvent: "input.type" });
		const { text, blocks, ranges } = parsed(view);
		expect(text).toBe("```\nZ\n```\nafter {++y++}");
		expect(blocks).toEqual(["```\nZ\n```"]);
		expect(ranges).toEqual(["{++y++}"]);
		expect(view.state.selection.main.head).toBe(5);
	});

	test("an unclosed block runs to the end, and typing there is plain", () => {
		const view = suggestView("```\nx\n");
		view.dispatch({ changes: { from: 6, insert: "a" }, userEvent: "input.type" });
		expect(parsed(view).text).toBe("```\nx\na");
	});
});

describe("rule 2: prose edits are tracked as before", () => {
	test("typing in prose", () => {
		const view = suggestView("hi\n\n" + DOC);
		view.dispatch({ changes: { from: 2, insert: "X" }, userEvent: "input.type" });
		expect(parsed(view).text).toBe("hi{++X++}\n\n" + DOC);
	});

	test("typing a fence in prose is tracked as text, not a block, until accepted", () => {
		const view = suggestView("hi\n");
		view.dispatch({ selection: { anchor: 3 } });
		for (const ch of "```") {
			const head = view.state.selection.main.head;
			view.dispatch({ changes: { from: head, insert: ch }, selection: { anchor: head + 1 }, userEvent: "input.type" });
		}
		const { text, blocks } = parsed(view);
		expect(text).toBe("hi\n{++```++}");
		expect(blocks).toEqual([]);
	});

	test.each([false, true])(
		"a multi-cursor edit tracks the prose change and leaves the code change plain (code first: %s)",
		code_first => {
			const view = suggestView("hi\n\n```\nab\n```");
			const cursors = code_first ? [9, 2] : [2, 9];
			view.dispatch(view.state.update({
				changes: cursors.map(at => ({ from: at, insert: "X" })),
				selection: EditorSelection.create(cursors.map(at => EditorSelection.cursor(at)), 0),
				userEvent: "input.type",
			}));
			const { text } = parsed(view);
			expect(text).toBe("hi{++X++}\n\n```\naXb\n```");
			const heads = view.state.selection.ranges.map(r => r.head).sort((a, b) => a - b);
			expect(heads).toEqual([text.indexOf("X") + 1, text.indexOf("aX") + 2]);
		},
	);

	test.each(
		[
			["typing in an addition", "a {++abcdef++} b", [[6, 6], [10, 10]], [{ from: 6, insert: "X" }, {
				from: 10,
				insert: "Y",
			}], "a {++aXbcdeYf++} b"],
			["typing in a substitution's new text", "x {~~old~>new~~} y", [[11, 11], [12, 12]], [{ from: 11, insert: "X" }, {
				from: 12,
				insert: "Y",
			}], "x {~~old~>nXeYw~~} y"],
			["replacing in a substitution's new text", "x {~~old~>new~~} y", [[10, 11], [12, 13]], [{
				from: 10,
				to: 11,
				insert: "P",
			}, { from: 12, to: 13, insert: "Q" }], "x {~~old~>PeQ~~} y"],
		] as const,
	)("N2: two cursors %s keep both keystrokes", (_, doc, selection, changes, expected) => {
		const view = suggestView(doc);
		edit(
			view,
			selection as unknown as [number, number][],
			changes as unknown as { from: number; to?: number; insert?: string }[],
		);
		expect(view.state.doc.toString()).toBe(expected);
	});
});

describe("rule 3: whole blocks with prose are tracked, markers on prose lines", () => {
	test("N1: pasting text with a whole code block into prose", () => {
		const view = suggestView("hello\n\nworld {++y++}");
		const paste = "Intro text\n\n```js\ncode\n```\n\nMore text\n";
		edit(view, [[6, 6]], [{ from: 6, insert: paste }]);
		const { text, blocks, ranges } = parsed(view);
		expect(text).toBe(`hello\n{++${paste}++}\nworld {++y++}`);
		expect(ranges).toEqual([`{++${paste}++}`, "{++y++}"]);
		expect(blocks).toEqual(["```js\ncode\n```"]);
	});

	test("pasting a bare code block at a line start puts the markers on lines of their own", () => {
		const view = suggestView("intro\nrest");
		edit(view, [[6, 6]], [{ from: 6, insert: "```js\ncode\n```\n" }]);
		const { text, blocks, ranges } = parsed(view);
		expect(text).toBe("intro\n{++\n```js\ncode\n```\n++}rest");
		expect(blocks).toEqual(["```js\ncode\n```"]);
		expect(ranges).toHaveLength(1);
		expect(accepted(view)).toBe("intro\n\n```js\ncode\n```\nrest");
	});

	test("deleting a selection of whole block lines", () => {
		const view = suggestView("hi\n" + DOC + "\nafter");
		edit(view, [[3, 14]], [{ from: 3, to: 14 }]);
		const { text, blocks, ranges } = parsed(view);
		expect(text).toBe("hi\n{--\n```\nab\n```\n--}after");
		expect(blocks).toEqual([DOC]);
		expect(ranges).toHaveLength(1);
		expect(accepted(view)).toBe("hi\nafter");
	});

	test("deleting from the end of one prose line to the start of another needs no adjustment", () => {
		const view = suggestView("prev\n```\nx\n```\nnext");
		edit(view, [[4, 15]], [{ from: 4, to: 15 }]);
		expect(parsed(view).text).toBe("prev{--\n```\nx\n```\n--}next");
	});

	test("an edit crossing a fence is widened to the whole block", () => {
		const view = suggestView("hi\n" + DOC);
		edit(view, [[1, 8]], [{ from: 1, to: 8 }]);
		const { text, blocks } = parsed(view);
		expect(text).toBe("h{--i\n```\nab\n```\n--}");
		expect(blocks).toEqual([DOC]);
		expect(accepted(view)).toBe("h");
	});
});

describe("rule 4: fence lines are protected", () => {
	const FENCED = "```\nx\n```\nafter {++y++}";

	test.each([
		["B2 Enter", "\n", "hi\n\n\n```\nab\n```\nafter {++y++}", 5],
		["B2 typing", "X", "hi\n\n{++X++}\n```\nab\n```\nafter {++y++}", 8],
	])("%s at the start of an opening fence line keeps the fence", (_, insert, expected, cursor) => {
		const view = suggestView("hi\n\n```\nab\n```\nafter {++y++}");
		view.dispatch({
			changes: { from: 4, insert },
			selection: { anchor: 5 },
			userEvent: insert === "\n" ? "input" : "input.type",
		});
		const { text, blocks, ranges } = parsed(view);
		expect(text).toBe(expected);
		expect(blocks).toEqual(["```\nab\n```"]);
		expect(ranges).toContain("{++y++}");
		expect(view.state.selection.main.head).toBe(cursor);
	});

	test("K10: typing at the start of the closing fence line goes on a new line above it", () => {
		const view = suggestView(FENCED);
		view.dispatch({ changes: { from: 6, insert: "a" }, selection: { anchor: 7 }, userEvent: "input.type" });
		expect(parsed(view).text).toBe("```\nx\na\n```\nafter {++y++}");
		expect(view.state.selection.main.head).toBe(7);
	});

	test("K10: pasting several lines there keeps the fence on its own line", () => {
		const view = suggestView(FENCED);
		view.dispatch({ changes: { from: 6, insert: "\na\nb" }, userEvent: "input.paste" });
		expect(parsed(view).text).toBe("```\nx\n\na\nb\n```\nafter {++y++}");
	});

	test("K10: Enter there is a plain newline", () => {
		const view = suggestView(FENCED);
		view.dispatch({ changes: { from: 6, insert: "\n" }, userEvent: "input" });
		expect(parsed(view).text).toBe("```\nx\n\n```\nafter {++y++}");
	});

	test.each([
		[
			"B3 indented, after the indent",
			"- item\n  ```\n  code\n  ```\nafter {++y++}",
			22,
			"- item\n  ```\n  code\n  a\n  ```\nafter {++y++}",
		],
		[
			"B3 indented, column 0",
			"- item\n  ```\n  code\n  ```\nafter {++y++}",
			20,
			"- item\n  ```\n  code\n  a\n  ```\nafter {++y++}",
		],
		["B3 quoted, after the marker", "> ```\n> x\n> ```\nafter {++y++}", 12, "> ```\n> x\n> a\n> ```\nafter {++y++}"],
		["B4 quoted, column 0", "> ```\n> x\n> ```\nafter {++y++}", 10, "> ```\n> x\n> a\n> ```\nafter {++y++}"],
	])("%s: text typed on a closing fence line goes above it, untracked, inside the prefix", (_, doc, at, expected) => {
		const view = suggestView(doc);
		view.dispatch({ changes: { from: at, insert: "a" }, selection: { anchor: at + 1 }, userEvent: "input.type" });
		const { text, ranges } = parsed(view);
		expect(text).toBe(expected);
		expect(ranges).toEqual(["{++y++}"]);
		expect(view.state.selection.main.head).toBe(expected.indexOf("a\n") + 1);
	});

	test("Enter after a closing fence is a plain newline and the block stays closed", () => {
		const view = suggestView("```\nx\n```\nafter {++y++}");
		view.dispatch({ changes: { from: 9, insert: "\n" }, userEvent: "input" });
		const { text, blocks, ranges } = parsed(view);
		expect(text).toBe("```\nx\n```\n\nafter {++y++}");
		expect(blocks).toEqual(["```\nx\n```"]);
		expect(ranges).toEqual(["{++y++}"]);
	});

	test("text typed after a closing fence goes on a new line below it, tracked", () => {
		const view = suggestView("```\nx\n```\nafter");
		view.dispatch({ changes: { from: 9, insert: "a" }, userEvent: "input.type" });
		expect(parsed(view).text).toBe("```\nx\n```\n{++a++}\nafter");
		expect(view.state.selection.main.head).toBe(14);
	});

	test.each([
		["Backspace joining the closing fence onto a non-empty line", FENCED, 5, 6],
		["Backspace joining the closing fence onto the opening fence", "```\n```\nafter {++y++}", 3, 4],
		["B5: Backspace at the start of the first code line", DOC, 3, 4],
		["Delete at the end of the line above an opening fence", "p\n" + DOC, 1, 2],
	])("%s is refused with a notice", (_, doc, from, to) => {
		const view = suggestView(doc);
		view.dispatch({ selection: { anchor: to } });
		view.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: "delete.backward" });
		expect(view.state.doc.toString()).toBe(doc);
		expect(view.state.selection.main.head).toBe(to);
		expect(notices).toHaveBeenCalledWith("Inkling: this edit would break a code fence in Suggest mode.");
	});

	test.each([
		["an empty line above the closing fence", "```\nx\n\n```", 6, 7, "```\nx\n```"],
		["B5: an empty first code line", "```\n\nab\n```", 3, 4, DOC],
	])("Backspace removing %s is plain", (_, doc, from, to, expected) => {
		const view = suggestView(doc);
		view.dispatch({ changes: { from, to }, userEvent: "delete.backward" });
		expect(parsed(view).text).toBe(expected);
		expect(notices).not.toHaveBeenCalled();
	});

	const P_FENCED = "p\n```\nab\n```\nafter {++y++}";
	test.each(
		[
			["Backspace at the end of the closing fence", [12, 12], { from: 11, to: 12 }],
			["Delete at the start of the closing fence", [9, 9], { from: 9, to: 10 }],
			["Backspace at the end of the opening fence", [5, 5], { from: 4, to: 5 }],
			["selecting just the closing fence", [9, 12], { from: 9, to: 12 }],
			["selecting from code into the closing fence", [7, 10], { from: 7, to: 10 }],
		] as const,
	)("N3/N4: %s deletes the whole block, tracked, with markers on prose lines", (_, selection, change) => {
		const view = suggestView(P_FENCED);
		edit(view, [selection as unknown as [number, number]], [change]);
		const { text, blocks, ranges } = parsed(view);
		expect(text).toBe("p\n{--\n```\nab\n```\n--}after {++y++}");
		expect(blocks).toEqual(["```\nab\n```"]);
		expect(ranges).toHaveLength(2);
		expect(accepted(view)).toBe("p\nafter y");
	});

	test("N4: a selection from the closing fence into prose, replaced", () => {
		const view = suggestView("p\n```\nx\n```\nafter text {++y++}");
		edit(view, [[9, 16]], [{ from: 9, to: 16, insert: "Z" }]);
		const { text, blocks } = parsed(view);
		expect(text).toBe("p\n{--\n```\nx\n```\nafte--}{++Z++}r text {++y++}");
		expect(blocks).toEqual(["```\nx\n```"]);
		expect(accepted(view)).toBe("p\nZr text y");
	});

	test("B7: a refused change does not cancel another cursor's change", () => {
		const view = suggestView("hi there\n\n```\nab\n```");
		view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(17)]) });
		view.dispatch(view.state.update({
			changes: [{ from: 1, to: 2 }, { from: 16, to: 17 }],
			selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(15)]),
			userEvent: "delete.backward",
		}));
		const { text, blocks } = parsed(view);
		expect(text).toBe("h{--i--} there\n\n```\nab\n```");
		expect(blocks).toEqual(["```\nab\n```"]);
		expect(notices).toHaveBeenCalledTimes(1);
	});
});

describe("B1: typing a code block after a closing fence", () => {
	test("every keystroke is kept, tracked, and the first block stays closed", () => {
		const doc = "before {++y++}\n\n```\nx\n```\nafter";
		const fence_end = doc.indexOf("```\nafter") + 3;
		const view = suggestView(doc);
		view.dispatch({ selection: { anchor: fence_end } });
		let typed = "";
		for (const ch of "\nfoo\n```js\ncode\n```\nbar") {
			const head = view.state.selection.main.head;
			view.dispatch({
				changes: { from: head, insert: ch },
				selection: { anchor: head + 1 },
				userEvent: ch === "\n" ? "input" : "input.type",
			});
			typed += ch;
			const { blocks, ranges } = parsed(view);
			expect(blocks[0]).toBe("```\nx\n```");
			expect(ranges[0]).toBe("{++y++}");
			expect(accepted(view)).toBe("before y\n\n```\nx\n```" + typed + "\nafter");
		}
		expect(notices).not.toHaveBeenCalled();
		expect(parsed(view).blocks).toEqual(["```\nx\n```"]);
	});
});
