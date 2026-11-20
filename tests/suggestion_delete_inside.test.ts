import { EditorView } from "@codemirror/view";

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

function backspace(doc: string, at: number): string {
	const settings = { ...DEFAULT_SETTINGS, ...SETTINGS };
	const view = new EditorView({
		state: createRangeState(doc, SETTINGS, [editorEditorField, suggestionMode(settings)]),
	});
	view.dispatch({ selection: { anchor: at } });
	view.dispatch({ changes: { from: at - 1, to: at }, selection: { anchor: at - 1 }, userEvent: "delete.backward" });
	return view.state.doc.toString();
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

	test("inside another author's addition leaves their text alone", () => {
		const doc = `p {++{"author":"bob"}@@abc++} q`;
		expect(backspace(doc, doc.indexOf("abc") + 2)).toBe(doc);
	});

	test("inside one's own addition removes the text outright", () => {
		const doc = `p {++{"author":"alice"}@@abc++} q`;
		expect(backspace(doc, doc.indexOf("abc") + 2)).toBe(`p {++{"author":"alice"}@@ac++} q`);
	});
});
