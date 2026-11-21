import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import * as obsidian from "obsidian";
import { editorEditorField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { suggestionMode } from "../src/editor/uix/extensions";
import { editorKeypressCatcher } from "../src/editor/uix/extensions/keypress-catcher";
import type { PluginSettings } from "../src/types";
import { createRangeState } from "./helpers";

// EXPL: Several cursors in Suggest mode give the same result as each cursor's keystroke alone, applied in turn (from
//       the last cursor to the first, so the earlier ones' positions hold), with no notice. Re-review N1 (a later
//       cursor's position was not mapped, so Backspace next to a range was dropped or deleted the wrong text) and N3
//       (nearby cursors were refused when one rewrote a range the other was in).

let notices: jest.SpyInstance;
beforeEach(() => {
	notices = jest.spyOn(obsidian, "Notice").mockImplementation(() => ({}) as obsidian.Notice);
});
afterEach(() => notices.mockRestore());

const OFF: Partial<PluginSettings> = { add_metadata: false };

function view(doc: string, settings = OFF) {
	return new EditorView({
		state: createRangeState(doc, settings, [
			editorEditorField,
			editorKeypressCatcher,
			EditorState.allowMultipleSelections.of(true),
			suggestionMode({ ...DEFAULT_SETTINGS, ...settings }),
		]),
	});
}

/** Presses `key` at each cursor of `cursors` at once. */
function press(v: EditorView, key: "Backspace" | "Delete", cursors: number[]) {
	v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
	v.dispatch({ selection: EditorSelection.create(cursors.map(c => EditorSelection.cursor(c))) });
	const changes = cursors.map(c => key === "Backspace" ? { from: c - 1, to: c } : { from: c, to: c + 1 });
	const after = changes.map((c, i) => c.from - i);
	v.dispatch(v.state.update({
		changes,
		selection: EditorSelection.create(after.map(c => EditorSelection.cursor(c))),
		userEvent: key === "Backspace" ? "delete.backward" : "delete.forward",
	}));
	return v.state.doc.toString();
}

/** Each cursor's keystroke alone, from the last cursor to the first. */
function inTurn(doc: string, key: "Backspace" | "Delete", cursors: number[], settings = OFF) {
	const v = view(doc, settings);
	for (const c of [...cursors].reverse()) press(v, key, [c]);
	return v.state.doc.toString();
}

describe("several cursors in Suggest mode", () => {
	test.each(
		[
			["Backspace after two additions", "x{++ab++} y{++cd++}", "Backspace", [9, 19], "x{++a++} y{++c++}"],
			["Backspace in prose and after an addition", "ab cd {++xy++} ef", "Backspace", [2, 14], "a{--b--} cd {++x++} ef"],
			[
				"Backspace into an addition and after a highlight's text",
				"{--del--} {~~old~>new~~} {++add++} \n\n{==hi==} more text ",
				"Backspace",
				[28, 42],
				"{--del--} {~~old~>new~~}{~~ ~>add~~} \n\n{==h==}{--i--} more text ",
			],
			[
				"Backspace next to a range the other cursor rewrites (N3)",
				"more text plain words {++mine text++} ",
				"Backspace",
				[25, 32],
				"more text plain words{~~ ~>mine txt~~} ",
			],
		] as const,
	)("%s", (_, doc, key, cursors, expected) => {
		const result = press(view(doc), key, [...cursors]);
		expect(result).toBe(expected);
		expect(result).toBe(inTurn(doc, key, [...cursors]));
		expect(notices).not.toHaveBeenCalled();
	});

	test("Delete at two cursors next to ranges, with metadata on", () => {
		const settings = { author: "me" };
		const doc = "{~~old~>new~~} {~~old~>new~~} {--del--} plain words ";
		const strip = (text: string) => text.replace(/"time":\d+/g, "");
		expect(strip(press(view(doc, settings), "Delete", [21, 26]))).toBe(
			strip(inTurn(doc, "Delete", [21, 26], settings)),
		);
		expect(notices).not.toHaveBeenCalled();
	});
});

/** Every suggestion accepted (`accept`) or rejected. */
function resolve(v: EditorView, accept: boolean) {
	let text = v.state.doc.toString();
	for (const r of [...v.state.field(rangeParser).ranges.ranges].reverse())
		text = text.slice(0, r.from) + (accept ? r.accept() : r.reject()) + text.slice(r.to);
	return text;
}

/** Replaces each selection [from, to) with `insert` (or deletes it with Backspace, or presses a key at a cursor). */
function edit(doc: string, changes: { from: number; to: number; insert: string }[], key = "a", settings = OFF) {
	const v = view(doc, settings);
	v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
	v.dispatch({
		selection: EditorSelection.create(
			changes.map(c =>
				key === "Backspace" && c.to - c.from === 1 ? EditorSelection.cursor(c.to) : EditorSelection.range(c.from, c.to)
			),
		),
	});
	let shift = 0;
	const cursors = changes.map(c => {
		const at = c.from + c.insert.length + shift;
		shift += c.insert.length - (c.to - c.from);
		return EditorSelection.cursor(at);
	});
	const backspace = key === "Backspace" && changes.every(c => c.to - c.from === 1 && !c.insert);
	v.dispatch(v.state.update({
		changes,
		selection: EditorSelection.create(cursors),
		userEvent: changes.some(c => c.insert) ? "input.type" : backspace ? "delete.backward" : "delete.selection",
	}));
	return { out: v.state.doc.toString(), accept: resolve(v, true), reject: resolve(v, false) };
}

describe("re-review 2", () => {
	const own = "intro{++\n```js\nlet a = 1;\nlet b = 2;\n```\n++}\nafter";
	const f = own.indexOf("```js"), c = own.indexOf("1;");

	test.each(
		[
			["selecting two backticks and typing", [{ from: f, to: f + 2, insert: "x" }], "a"],
			["the same, with a second cursor typing in the code", [{ from: f, to: f + 2, insert: "x" }, {
				from: c,
				to: c,
				insert: "9",
			}], "a"],
			["one Backspace in the fence", [{ from: f + 1, to: f + 2, insert: "" }], "Backspace"],
			["selecting two backticks and deleting", [{ from: f, to: f + 2, insert: "" }], "Delete"],
		] as const,
	)("R1: in one's own pending block, %s is refused, not widened over the code", (_, changes, key) => {
		const { out } = edit(own, [...changes], key);
		const expected = changes.length > 1 ? own.replace("1;", "91;") : own;
		expect(out).toBe(expected);
		expect(notices).toHaveBeenCalledTimes(1);
	});

	test.each([
		["x {++abcdef++} y", 5, 7, "x {++Xcdef++} y"],
		["x {++abcdef++} y", 6, 11, "x {++aX++} y"],
		["x {++ab\ncd\nef++} y", 6, 9, "x {++aXd\nef++} y"],
		["a {++h++}{++xyz++} b", 10, 14, "a {++h++}{++Xz++} b"],
	])("R2: retyping inside one's own addition %j [%i, %i) replaces its text in place", (doc, from, to, expected) => {
		expect(edit(doc, [{ from, to, insert: "X" }]).out).toBe(expected);
	});

	test.each([
		["xy {~~de~>fg~~} z", 1, 9, "", "x{~~y de~>fg~~} z", "xfg z"],
		["xy {~~de~>fg~~} z", 1, 9, "Q", "x{~~y de~>Qfg~~} z", "xQfg z"],
		["a{++bc++}{~~de~>fg~~}{++hi++}j", 3, 15, "", undefined, "afghij"],
	])(
		"R3: a selection %j [%i, %i) ending inside a substitution's separator leaves no stray '>'",
		(doc, from, to, insert, out, accepted) => {
			const result = edit(doc, [{ from, to, insert }]);
			if (out) expect(result.out).toBe(out);
			expect(result.out).not.toContain("~>>");
			expect(result.accept).toBe(accepted);
			expect(result.reject).toBe(doc.includes("{++bc++}") ? "adej" : "xy de z");
		},
	);

	test("R4: text typed over part of a fence line in prose goes on a line of its own", () => {
		const doc = "intro\n```js\nlet a = 1;\nlet b = 2;\n```\nafter", g = doc.indexOf("```js");
		const result = edit(doc, [{ from: g, to: g + 2, insert: "x" }]);
		expect(result.out).toBe("intro\n{--\n```js\nlet a = 1;\nlet b = 2;\n```\n--}{++x\n++}after");
		expect(result.accept).toBe("intro\nx\nafter");
		expect(result.reject).toBe("intro\n\n```js\nlet a = 1;\nlet b = 2;\n```\nafter");
		expect(notices).not.toHaveBeenCalled();
	});
});

describe("re-review 3", () => {
	test.each([
		[
			"in a quote",
			"> intro\n> ```js\n> let a;\n> ```\n> after",
			"> intro{--\n> ```js\n> let a;\n> ```\n> --}{++\n> x++}\n> after",
			"> intro\n> x\n> after",
		],
		[
			"in a list item",
			"- intro\n  ```js\n  let a;\n  ```\n  after",
			"- intro{--\n  ```js\n  let a;\n  ```\n  --}{++\n  x++}\n  after",
			"- intro\n  x\n  after",
		],
		[
			"before another block",
			"intro\n```js\nlet a;\n```\n```py\nb\n```",
			"intro{--\n```js\nlet a;\n```\n--}{++\nx++}\n```py\nb\n```",
			"intro\nx\n```py\nb\n```",
		],
	])("R6: text typed over part of a fence line %s goes on a line of its own", (_, doc, out, accepted) => {
		const g = doc.indexOf("```js");
		const result = edit(doc, [{ from: g, to: g + 2, insert: "x" }]);
		expect(result.out).toBe(out);
		expect(result.accept).toBe(accepted);
		// Rejecting restores the text, with at most a prefix-only line where a marker was.
		expect(result.reject.split("\n").filter(line => !/^[ \t>]*$/.test(line))).toEqual(
			doc.split("\n").filter(line => !/^[ \t>]*$/.test(line)),
		);
		expect(notices).not.toHaveBeenCalled();
	});
});
