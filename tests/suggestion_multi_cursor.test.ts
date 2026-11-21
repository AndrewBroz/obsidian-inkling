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

	test("Backspace in a substitution's opener while another cursor rewrites it, with metadata on", () => {
		const settings = { author: "me" };
		const doc = "x {~~old~>new~~} y";
		const strip = (text: string) => text.replace(/"time":\d+/g, "");
		const result = strip(press(view(doc, settings), "Backspace", [4, 6]));
		expect(result).toBe(strip(inTurn(doc, "Backspace", [4, 6], settings)));
		expect(result).toBe(`x{--{"author":"me",}@@ o--}{~~ld~>new~~} y`);
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

// (Typed text next to a range joins it where it can: before one's own addition, after a deletion.)
describe("text typed over a selection of a range's markup (round 4 ruling)", () => {
	test.each([
		["the opener's {", "x\n{++\n> h++}\ny", 2, 3, "x\n{++Z\n> h++}\ny", "x\nZ\n> h\ny"],
		["part of an opener", "a {--gone--} b", 3, 5, "a {++Z++}{--gone--} b", "a Z b"],
		["a closer", "a {--gone--} b", 9, 12, "a {~~gone~>Z~~} b", "a Z b"],
	])("over %s goes beside the range where it was typed", (_, doc, from, to, out, accepted) => {
		const result = edit(doc, [{ from, to, insert: "Z" }]);
		expect(result.out).toBe(out);
		expect(result.accept).toBe(accepted);
		expect(result.reject).toBe(resolve_plain(doc));
	});
});

/** `doc` with every suggestion rejected (no markup). */
function resolve_plain(doc: string) {
	return resolve(view(doc), false);
}

describe("round 5", () => {
	test.each([
		["a comment's {", "a {==hi==}{>>note<<} b", 10, 11, "a {==hi==}{>>note<<}{++Z++} b"],
		["a comment's opener", "a {==hi==}{>>note<<} b", 10, 13, "a {==hi==}{>>note<<}{++Z++} b"],
		["a comment's closer", "a {==hi==}{>>note<<} b", 18, 20, "a {==hi==}{>>note<<}{++Z++} b"],
		["the closer of the range a comment annotates", "a {==hi==}{>>note<<} b", 7, 10, "a {==hi==}{>>note<<}{++Z++} b"],
		["a reply's {", "a {==hi==}{>>one<<}{>>two<<} b", 19, 20, "a {==hi==}{>>one<<}{>>two<<}{++Z++} b"],
		[
			"the first comment's closer in a thread",
			"a {==hi==}{>>one<<}{>>two<<} b",
			16,
			19,
			"a {==hi==}{>>one<<}{>>two<<}{++Z++} b",
		],
		[
			"a cursor between the annotated range and its comment",
			"a {==hi==}{>>note<<} b",
			10,
			10,
			"a {==hi==}{>>note<<}{++Z++} b",
		],
		["a cursor at the end of the annotated text", "a {==hi==}{>>note<<} b", 7, 7, "a {==hi==}{>>note<<}{++Z++} b"],
		["a cursor between two replies", "a {==hi==}{>>one<<}{>>two<<} b", 19, 19, "a {==hi==}{>>one<<}{>>two<<}{++Z++} b"],
	])("Q1: text typed over %s goes after the whole thread", (_, doc, from, to, out) => {
		const result = edit(doc, [{ from, to, insert: "Z" }]);
		expect(result.out).toBe(out);
	});

	test("Q1: a code block pasted between the annotated range and its comment goes after the thread", () => {
		const { out } = edit("{==hi==}{>>note<<} z\n\ntail", [{ from: 8, to: 8, insert: "```\nz\n```\n" }]);
		expect(out.startsWith("{==hi==}{>>note<<}")).toBe(true);
		expect(notices).not.toHaveBeenCalled();
	});

	test.each([
		["a cursor before a substitution", 2, 2, "a {++Z++}{~~x~>y~~} b"],
		["a selection of its opener", 2, 4, "a {++Z++}{~~x~>y~~} b"],
	])("Q2: text typed at %s is an addition", (_, from, to, out) => {
		expect(edit("a {~~x~>y~~} b", [{ from, to, insert: "Z" }]).out).toBe(out);
	});
});

// EXPL: In a thread, the annotated range's closer and each comment's opener and closer are markup that edits stay out
//       of; a comment's text stays editable. Re-review 5: C1 (a selection trimmed by those rules applied untrimmed,
//       destroying the comment), C2 (a selection in a comment's text no longer edited it), and rr12's inputs.
describe("round 6: comment threads", () => {
	const NOTE = "a {==hi==}{>>note<<} b", ADDED = "a {++bc++}{>>note<<} f", REPLIES = "a {==hi==}{>>one<<}{>>two<<} b";
	describe.each([["metadata off", OFF], ["default settings", { author: "me" }]] as const)("%s", (_, settings) => {
		test.each([
			["from a pending addition into its comment (C1)", ADDED, 6, 11, "a {++b++}{>>note<<} f", "a b f"],
			[
				"from a comment's closer across a pending addition (C1)",
				"a {++bc++}{>>note<<}{++de++} f",
				18,
				28,
				"a {++bc++}{>>note<<} f",
				"a bc f",
			],
			["of a comment's text (C2)", NOTE, 13, 17, "a {==hi==}{>><<} b", "a {==hi==} b"],
		])("deleting a selection %s", (_, doc, from, to, out, accepted) => {
			const result = edit(doc, [{ from, to, insert: "" }], "Delete", settings);
			expect(result.out).toBe(out);
			expect(result.accept).toBe(accepted);
			expect(notices).not.toHaveBeenCalled();
		});

		test.each([
			["a comment's text (C2)", NOTE, 13, 17, "a {==hi==}{>>X<<} b"],
			["a reply's text (C2)", REPLIES, 22, 25, "a {==hi==}{>>one<<}{>>X<<} b"],
			["the base's closer, a comment's opener and its text", REPLIES, 9, 18, "a {==hi==}{>>X<<}{>>two<<} b"],
		])("typing over %s edits the comment", (_, doc, from, to, out) => {
			expect(edit(doc, [{ from, to, insert: "X" }], "a", settings).out).toBe(out);
		});
	});

	test.each([
		["at a cursor in a comment's text", NOTE, 15, 15, "a {==hi==}{>>noZte<<} b"],
		["at a cursor in a standalone comment's text", "a {>>note<<} b", 7, 7, "a {>>noZte<<} b"],
		["at the end of a pending addition's text", ADDED, 7, 7, "a {++bcZ++}{>>note<<} f"],
		["in a pending addition's closer", ADDED, 8, 8, "a {++bc++}{>>note<<}{++Z++} f"],
		["at the end of a deletion's text", "a {--old--}{>>why<<} b", 8, 8, "a {~~old~>Z~~}{>>why<<} b"],
	])("typing %s (rr12)", (_, doc, from, to, out) => {
		const result = edit(doc, [{ from, to, insert: "Z" }]);
		expect(result.out).toBe(out);
		expect(result.reject).toBe(resolve(view(doc), false));
	});

	test.each([
		["at the start of a thread of comments only", "a {>>one<<}{>>two<<} b", 2, 2],
		["over its first comment's opener", "a {>>one<<}{>>two<<} b", 2, 5],
		["at the end of a highlight's text", NOTE, 7, 7],
	])("text typed %s goes after the thread, which keeps its anchor", (_, doc, from, to) => {
		const out = edit(doc, [{ from, to, insert: "Z" }]).out;
		const end = doc.lastIndexOf("}") + 1;
		expect(out).toBe(doc.slice(0, end) + "{++Z++}" + doc.slice(end));
	});

	test("typing at the end of another author's addition that a comment annotates goes after the thread", () => {
		const doc = "a {++{\"author\":\"bob\",\"time\":5}@@bc++}{>>note<<} f";
		const out = edit(doc, [{ from: 34, to: 34, insert: "Z" }], "a", { author: "me" }).out;
		expect(out.startsWith("a {++{\"author\":\"bob\",\"time\":5}@@bc++}{>>note<<}{++")).toBe(true);
		expect(out.endsWith("@@Z++} f")).toBe(true);
	});

	test("a pasted fence line next to an unanchored thread doesn't become what the thread annotates", () => {
		const doc = "a {--gone--} b\n\n{>>alone<<}{>>reply<<} q";
		const at = doc.indexOf("{>>") - 1;
		const { out, reject } = edit(doc, [{ from: at, to: at, insert: "\n```\n" }]);
		expect(out).not.toMatch(/\}\{>>alone/);
		expect(reject).toBe(resolve(view(doc), false));
	});

	test("a selection of a standalone comment's text deletes it (rr12 C5)", () => {
		expect(edit("a {>>note<<} b", [{ from: 5, to: 9, insert: "" }], "Delete").out).toBe("a {>><<} b");
	});

	test("typing inside a thread and elsewhere, with two cursors (rr12 T17)", () => {
		expect(edit(NOTE, [{ from: 10, to: 10, insert: "Z" }, { from: 21, to: 21, insert: "Z" }]).out)
			.toBe("a {==hi==}{>>note<<}{++Z++} {++Z++}b");
	});

	test("a code block pasted in a thread goes after it on lines of its own (rr12 T16)", () => {
		expect(edit(NOTE, [{ from: 10, to: 10, insert: "\n```\nz\n```\n" }]).out)
			.toBe("a {==hi==}{>>note<<}{++\n```\nz\n```\n++} b");
		expect(notices).not.toHaveBeenCalled();
	});

	test.each([
		["the annotated range's closer", NOTE, 7, 10],
		["a comment's opener", NOTE, 10, 13],
		["the closers and opener between two replies", REPLIES, 16, 22],
		["a range's opener", "a {--gone--} b", 2, 5],
		["a closer and the next range's opener", "{--a--}{++b++}", 4, 10],
		["text already deleted", "a {--gone--} b", 5, 9],
	])("deleting a selection of only %s does nothing, with a notice", (_, doc, from, to) => {
		expect(edit(doc, [{ from, to, insert: "" }], "Delete").out).toBe(doc);
		expect(notices).toHaveBeenCalledTimes(1);
		expect(notices.mock.calls[0][0]).toBe(
			"Inkling: nothing to change here in Suggest mode (only markup, or text already deleted).",
		);
	});

	test.each([
		["from inside a comment's text out of the thread", NOTE, 15, 22, "a {==hi==}{>>note<<}{-- b--}"],
		["from before the thread into a comment's text", ADDED, 6, 15, "a {++b++}{>>note<<} f"],
		["inside a thread, from a comment's text into the next comment", REPLIES, 14, 24, "a {==hi==}{>>o<<}{>>two<<} b"],
	])("a selection %s keeps to the text it starts in", (_, doc, from, to, out) => {
		expect(edit(doc, [{ from, to, insert: "" }], "Delete").out).toBe(out);
	});
});
