import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorEditorField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { suggestionMode } from "../src/editor/uix/extensions";
import { createRangeState } from "./helpers";

// EXPL: In Suggest mode, a line marker (`> `, `#`-`######`, `- `/`* `/`+ `/`1. `, `- [ ] `) typed at the start of a
//       line goes in as typed, untracked; text typed after it is tracked, with the opener after the marker.

function mount(doc: string, cursor: number) {
	const view = new EditorView({
		state: createRangeState(doc, { add_metadata: false }, [
			editorEditorField,
			EditorState.allowMultipleSelections.of(true),
			suggestionMode({ ...DEFAULT_SETTINGS, add_metadata: false }),
		]),
	});
	view.dispatch({ selection: EditorSelection.cursor(cursor) });
	return view;
}

/** Types `text` one key at a time at the cursor. */
function type(view: EditorView, text: string) {
	for (const ch of text) {
		const at = view.state.selection.main.head;
		view.dispatch(view.state.update({
			changes: { from: at, insert: ch },
			selection: EditorSelection.cursor(at + 1),
			userEvent: "input.type",
		}));
	}
}

const typed = (doc: string, cursor: number, text: string) => {
	const view = mount(doc, cursor);
	type(view, text);
	const out = view.state.doc.toString();
	view.destroy();
	return out;
};

describe("a line marker typed at the start of a line goes in as typed", () => {
	test.each([
		["quote", "> new text", "> {++new text++}"],
		["heading", "## Title", "## {++Title++}"],
		["six-level heading", "###### Deep", "###### {++Deep++}"],
		["dash list item", "- item", "- {++item++}"],
		["star list item", "* item", "* {++item++}"],
		["plus list item", "+ item", "+ {++item++}"],
		["numbered list item", "1. item", "1. {++item++}"],
		["numbered list item, two digits", "12) item", "12) {++item++}"],
		["task", "- [ ] todo", "- [ ] {++todo++}"],
		["task in a quote", "> - [ ] todo", "> - [ ] {++todo++}"],
		["list item in a quote", "> - item", "> - {++item++}"],
		["indented list item", "  - item", "  - {++item++}"],
	])("%s", (_, keys, expected) => {
		expect(typed("before\n\nafter", 7, keys)).toBe(`before\n${expected}\nafter`);
	});

	test("typed in front of an existing line's text", () => {
		expect(typed("before\nold text", 7, "- ")).toBe("before\n- old text");
	});

	test("typed after a marker already on the line", () => {
		expect(typed("> quoted", 2, "- ")).toBe("> - quoted");
	});

	test("pasted at once", () => {
		const view = mount("a\n\nb", 2);
		view.dispatch(view.state.update({
			changes: { from: 2, insert: "- [ ] " },
			selection: EditorSelection.cursor(8),
			userEvent: "input.paste",
		}));
		expect(view.state.doc.toString()).toBe("a\n- [ ] \nb");
		view.destroy();
	});
});

describe("anything else stays tracked", () => {
	test.each([
		["a hashtag", "#tag", "{++#tag++}"],
		["a hyphenated word", "-x y", "{++-x y++}"],
		["a number", "1990 was", "{++1990 was++}"],
		["a marker with no space", "-", "{++-++}"],
		["a space alone", " x", "{++ x++}"],
	])("%s", (_, keys, expected) => {
		expect(typed("before\n\nafter", 7, keys)).toBe(`before\n${expected}\nafter`);
	});

	test("a marker typed mid-line", () => {
		expect(typed("word ", 5, "- x")).toBe("word {++- x++}");
	});

	test("a marker on a line typed as part of an addition is part of it", () => {
		const view = mount("text", 4);
		type(view, "\n- item");
		expect(view.state.doc.toString()).toBe("text{++\n- item++}");
		view.destroy();
	});

	test("a marker typed inside a deletion that began on an earlier line", () => {
		expect(typed("{--a\nb--}", 5, "- ")).not.toBe("{--a\n- b--}");
	});
});
