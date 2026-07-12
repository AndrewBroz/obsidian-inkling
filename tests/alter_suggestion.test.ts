import { EditorView } from "@codemirror/view";

import { editorEditorField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { acceptSuggestions, rejectSuggestions } from "../src/editor/base/edit-logic/alter-suggestion";
import { suggestionMode } from "../src/editor/uix/extensions";
import { createRangeState } from "./helpers";

describe("accept/reject suggestion interval handling", () => {
	const doc = "hello {++world++}";
	const view = new EditorView({
		state: createRangeState(doc, {}, [editorEditorField, suggestionMode(DEFAULT_SETTINGS)]),
	});
	const state = view.state;

	test("cursor selection at position 0 accepts/rejects nothing", () => {
		// EXPL: regression test — `(from || to)` treated position 0 as "no interval given"
		//       and fell back to EVERY range in the document
		expect(acceptSuggestions(state, 0, 0)).toHaveLength(0);
		expect(rejectSuggestions(state, 0, 0)).toHaveLength(0);
	});

	test("selection before the range accepts nothing", () => {
		expect(acceptSuggestions(state, 0, 5)).toHaveLength(0);
	});

	test("interval from 0 covering the range accepts it", () => {
		expect(acceptSuggestions(state, 0, doc.length)).toHaveLength(1);
	});

	test("no interval given accepts all suggestions", () => {
		expect(acceptSuggestions(state)).toHaveLength(1);
	});
});
