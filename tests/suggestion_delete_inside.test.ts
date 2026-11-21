import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorEditorField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { suggestionMode } from "../src/editor/uix/extensions";
import type { PluginSettings } from "../src/types";
import { createRangeState } from "./helpers";

// EXPL: Deleting inside an existing range in Suggest mode. Only one's own pending text (an addition, or a
//       substitution's new part, by the same author) is removed outright; anything else stays recoverable. A misplaced
//       parenthesis made every other range type count as one's own text, and the author check was always true, so
//       deleting inside a deletion or a highlight (or another author's addition) removed base text untracked.

const SETTINGS: Partial<PluginSettings> = {
	add_metadata: true,
	add_author_metadata: true,
	add_timestamp_metadata: false,
	author: "alice",
	enable_metadata: true,
};

function view(doc: string): EditorView {
	const settings = { ...DEFAULT_SETTINGS, ...SETTINGS };
	return new EditorView({ state: createRangeState(doc, SETTINGS, [editorEditorField, suggestionMode(settings)]) });
}

function backspace(doc: string, at: number): string {
	const v = view(doc);
	v.dispatch({ selection: { anchor: at } });
	v.dispatch({ changes: { from: at - 1, to: at }, selection: { anchor: at - 1 }, userEvent: "delete.backward" });
	return v.state.doc.toString();
}

describe("Backspace inside an existing range in Suggest mode", () => {
	test("inside one's own deletion does nothing: the text is already suggested for deletion", () => {
		const doc = `p {--{"author":"alice"}@@abc--} q`;
		expect(backspace(doc, doc.indexOf("abc") + 2)).toBe(doc);
	});

	test("inside another author's deletion keeps the text, re-attributed to the new author", () => {
		expect(backspace("p {--abc--} q", 7)).toBe(`p {--a--}{--{"author":"alice"}@@b--}{--c--} q`);
	});

	test("inside a highlight is a tracked deletion", () => {
		expect(backspace("p {==abc==} q", 7)).toBe(`p {==a==}{--{"author":"alice"}@@b--}{==c==} q`);
	});

	test.each([
		["another author's addition", `p {++{"author":"bob"}@@abc++} q`, `p {++{"author":"bob"}@@ac++} q`],
		["an addition without metadata (I1)", "p {++abc++} q", "p {++ac++} q"],
	])("inside %s removes the text outright", (_, doc, expected) => {
		expect(backspace(doc, doc.indexOf("abc") + 2)).toBe(expected);
	});

	test("inside one's own addition removes the text outright", () => {
		const doc = `p {++{"author":"alice"}@@abc++} q`;
		expect(backspace(doc, doc.indexOf("abc") + 2)).toBe(`p {++{"author":"alice"}@@ac++} q`);
	});
});

describe("deleting a selection from an addition's opener", () => {
	test.each([
		["after a deletion", `{--x--}{++{"author":"alice"}@@ab++} q`, `{--x--}{++{"author":"alice"}@@b++} q`, 0],
		["on its own", `p {++{"author":"alice"}@@ab++} q`, `p {++{"author":"alice"}@@b++} q`, 0],
		[
			"from inside a highlight's closer",
			`{==h==}{++{"author":"alice"}@@ab++} q`,
			`{==h==}{++{"author":"alice"}@@b++} q`,
			1,
		],
	])("%s removes the selected own text", (_, doc, expected, back) => {
		const v = view(doc);
		const from = doc.indexOf("{++") - back, to = doc.indexOf("ab") + 1;
		v.dispatch({ selection: { anchor: from, head: to } });
		v.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: "delete.selection" });
		expect(v.state.doc.toString()).toBe(expected);
	});
});

test("a selection from own text into the next range's opener removes the own text", () => {
	const doc = `{++{"author":"alice"}@@ab++}{--x--} q`;
	const v = view(doc);
	const from = doc.indexOf("b"), to = doc.indexOf("{--") + 1;
	v.dispatch({ selection: { anchor: from, head: to } });
	v.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: "delete.selection" });
	expect(v.state.doc.toString()).toBe(`{++{"author":"alice"}@@a++}{--x--} q`);
});

// FIXME: Known bug, also on main (2dd9685); fixing it needs the owner's decision. Each cursor's edit is tracked
//        against the same start state, so two cursors in one addition each rewrite the whole range and the text is
//        duplicated. Fixing it means tracking the cursors one after another, which the 0.13.0 rebuild removed.
test.failing("two cursors in one own addition with timestamps both type (review I2)", () => {
	const settings = { ...DEFAULT_SETTINGS, ...SETTINGS, author: "me", add_timestamp_metadata: true };
	const doc = `x {++{"author":"me","time":1000}@@abcdef++} y`;
	const v = new EditorView({
		state: createRangeState(doc, settings, [
			editorEditorField,
			EditorState.allowMultipleSelections.of(true),
			suggestionMode(settings),
		]),
	});
	const at = doc.indexOf("abcdef");
	v.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(at + 2), EditorSelection.cursor(at + 4)]) });
	v.dispatch(v.state.update({
		changes: [{ from: at + 2, insert: "X" }, { from: at + 4, insert: "X" }],
		selection: EditorSelection.create([EditorSelection.cursor(at + 3), EditorSelection.cursor(at + 6)]),
		userEvent: "input.type",
	}));
	expect(v.state.doc.toString()).toMatch(/^x \{\+\+\{"author":"me","time":\d+\}@@abXcdXef\+\+\} y$/);
});

// FIXME: The same known bug with metadata off.
test.failing("two cursors in one own addition both type, metadata off", () => {
	const settings = { ...DEFAULT_SETTINGS, add_metadata: false };
	const v = new EditorView({
		state: createRangeState("x {++abcdef++} y", { add_metadata: false }, [
			editorEditorField,
			EditorState.allowMultipleSelections.of(true),
			suggestionMode(settings),
		]),
	});
	v.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(7), EditorSelection.cursor(9)]) });
	v.dispatch(v.state.update({
		changes: [{ from: 7, insert: "Z" }, { from: 9, insert: "Z" }],
		selection: EditorSelection.create([EditorSelection.cursor(8), EditorSelection.cursor(11)]),
		userEvent: "input.type",
	}));
	expect(v.state.doc.toString()).toBe("x {++abZcdZef++} y");
});

describe("deleting next to markup (found by the fence fuzz's stricter checks)", () => {
	test("Delete before a closer with another range right after deletes that range's first character", () => {
		const doc = "a {++xy++}{++zh++} b";
		const v = view(doc);
		v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
		v.dispatch({ selection: { anchor: 7 } });
		v.dispatch({ changes: { from: 7, to: 8 }, selection: { anchor: 7 }, userEvent: "delete.forward" });
		expect(v.state.doc.toString()).toBe("a {++xy++}{++h++} b");
	});

	test("a selection from inside one addition into the next retracts the selected text of both", () => {
		const v = view("a {++ab++}{++cd++} b");
		v.dispatch({ selection: { anchor: 6, head: 14 } });
		v.dispatch({ changes: { from: 6, to: 14 }, selection: { anchor: 6 }, userEvent: "delete.selection" });
		expect(v.state.doc.toString()).toBe("a {++a++}{++d++} b");
	});

	test("text typed over a selection of a range's metadata (part of its opening) goes before the range", () => {
		const doc = `p {--{"author":"me"}@@gone--} q`;
		const v = view(doc);
		const from = doc.indexOf("author"), to = from + 3;
		v.dispatch({ selection: { anchor: from, head: to } });
		v.dispatch({ changes: { from, to, insert: "Z" }, selection: { anchor: from + 1 }, userEvent: "input.type" });
		expect(v.state.doc.toString()).toBe(`p {++{"author":"alice"}@@Z++}{--{"author":"me"}@@gone--} q`);
	});
});

describe("typing over text in and beside ranges", () => {
	/** `doc` after replacing [from, to) with `insert` in Suggest mode, metadata off; and it accepted and rejected. */
	function replace(doc: string, from: number, to: number, insert: string) {
		const settings = { ...DEFAULT_SETTINGS, add_metadata: false };
		const v = new EditorView({
			state: createRangeState(doc, { add_metadata: false }, [editorEditorField, suggestionMode(settings)]),
		});
		v.dispatch({ selection: EditorSelection.range(from, to) });
		v.dispatch({
			changes: { from, to, insert },
			selection: { anchor: from + insert.length },
			userEvent: insert ? "input.type" : "delete.selection",
		});
		const resolve = (accept: boolean) => {
			let text = v.state.doc.toString();
			for (const r of [...v.state.field(rangeParser).ranges.ranges].reverse())
				text = text.slice(0, r.from) + (accept ? r.accept() : r.reject()) + text.slice(r.to);
			return text;
		};
		return { out: v.state.doc.toString(), accept: resolve(true), reject: resolve(false) };
	}

	test.each([
		["x {++abcdef++} y", 5, 7, "x {++Xcdef++} y"],
		["x {++abcdef++} y", 6, 11, "x {++aX++} y"],
		["x {++ab\ncd\nef++} y", 6, 9, "x {++aXd\nef++} y"],
		["a {++h++}{++xyz++} b", 10, 14, "a {++h++}{++Xz++} b"],
	])("retyping inside one's own addition %j [%i, %i) replaces its text in place", (doc, from, to, expected) => {
		expect(replace(doc, from, to, "X").out).toBe(expected);
	});

	test.each([
		["a cursor before a substitution", 2, 2],
		["a selection of its opener", 2, 4],
	])("text typed at %s is an addition, not {~~~>Z~~}", (_, from, to) => {
		expect(replace("a {~~x~>y~~} b", from, to, "Z").out).toBe("a {++Z++}{~~x~>y~~} b");
	});

	test.each([
		["xy {~~de~>fg~~} z", 1, 9, "", "x{~~y de~>fg~~} z", "xfg z"],
		["xy {~~de~>fg~~} z", 1, 9, "Q", "x{~~y de~>Qfg~~} z", "xQfg z"],
		["a{++bc++}{~~de~>fg~~}{++hi++}j", 3, 15, "", "a{~~de~>fg~~}{++hi++}j", "afghij"],
	])(
		"a selection %j [%i, %i) ending inside a substitution's separator leaves no stray '>'",
		(doc, from, to, insert, out, accepted) => {
			const result = replace(doc, from, to, insert);
			expect(result.out).toBe(out);
			expect(result.accept).toBe(accepted);
			expect(result.reject).toBe(doc.includes("{++bc++}") ? "adej" : "xy de z");
		},
	);
});
