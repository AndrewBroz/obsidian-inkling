import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import * as obsidian from "obsidian";
import { editorEditorField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
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

test("two cursors in an older own addition with timestamps both type, with no notice (review I2)", () => {
	const notice = jest.spyOn(obsidian, "Notice").mockImplementation(() => ({}) as obsidian.Notice);
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
	expect(notice).not.toHaveBeenCalled();
	notice.mockRestore();
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

	test("text typed over a selection of a range's metadata goes after the range", () => {
		const doc = `p {--{"author":"me"}@@gone--} q`;
		const v = view(doc);
		const from = doc.indexOf("author"), to = from + 3;
		v.dispatch({ selection: { anchor: from, head: to } });
		v.dispatch({ changes: { from, to, insert: "Z" }, selection: { anchor: from + 1 }, userEvent: "input.type" });
		expect(v.state.doc.toString()).toBe(`p {--{"author":"me"}@@gone--}{++{"author":"alice"}@@Z++} q`);
	});
});
