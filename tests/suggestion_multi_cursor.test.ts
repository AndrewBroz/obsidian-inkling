import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import * as obsidian from "obsidian";
import { editorEditorField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
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
