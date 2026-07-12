import { EditorSelection, EditorState } from "@codemirror/state";

import { rangeParser } from "../src/editor/base";
import { providePluginSettingsExtension } from "../src/editor/uix/extensions";
import { rangeCorrecter } from "../src/editor/uix/extensions/range-correcter";
import { DEFAULT_SETTINGS } from "../src/constants";

// EXPL: DEFAULT_SETTINGS.enable_metadata is false; with it false, cursorGenerateRanges()
// (src/editor/base/edit-util/range-parser.ts:12-25) never recognizes the MDSepSub child as
// metadata, so it looks for "MSub" as the range's first child instead, doesn't find it, and
// returns undefined for the whole range -- the parser produces ZERO ranges for the FIXME
// document below, not just metadata-less ones. Re-providing the settings field with
// enable_metadata: true is required for the parser to construct the substitution range at all.
const pluginSettingsField = providePluginSettingsExtension(
	<any> { settings: { ...DEFAULT_SETTINGS, enable_metadata: true } },
);

// EXPL: This is the exact document from the FIXME at range-correcter.ts:10
const METADATA = `{"author":"Fevol","time":1708879304}`;
const doc = `In ad{~~${METADATA}@@dition to document files, metadata is used for:\n\n- videos~>audio~~}\n- audio files`;

function exitRange(from_pos: number, to_pos: number) {
	const state = EditorState.create({
		doc,
		selection: EditorSelection.cursor(from_pos),
		extensions: [rangeParser, pluginSettingsField, rangeCorrecter],
	});
	return state.update({
		selection: EditorSelection.cursor(to_pos),
		userEvent: "select",
	});
}

describe("rangeCorrecter on substitution range with metadata", () => {
	const inside = doc.indexOf("metadata is used"); // cursor inside the range content

	test("exiting the range preserves metadata while collapsing double newlines", () => {
		const tr = exitRange(inside, 0);
		const result = tr.state.doc.toString();
		expect(result).toContain(`{~~${METADATA}@@`); // metadata survives
		expect(result).toContain("used for:\n- videos"); // \n\n collapsed to \n
		expect(result).toContain("- videos~>audio"); // the "~>" separator survives too
	});

	test("cursor exiting leftwards (before the range) is not shifted", () => {
		const tr = exitRange(inside, 0);
		expect(tr.state.selection.main.head).toBe(0);
	});

	test("cursor exiting rightwards is shifted by exactly the removed characters", () => {
		const tr = exitRange(inside, doc.length);
		// EXPL: one "\n\n" collapses to "\n" => exactly 1 character removed
		expect(tr.state.doc.length).toBe(doc.length - 1);
		expect(tr.state.selection.main.head).toBe(doc.length - 1);
	});
});

describe("rangeCorrecter still corrects ranges without metadata", () => {
	test("leading whitespace inside a highlight is stripped on exit", () => {
		const plain_doc = "x{== hl==}y";
		const state = EditorState.create({
			doc: plain_doc,
			selection: EditorSelection.cursor(6),
			extensions: [rangeParser, pluginSettingsField, rangeCorrecter],
		});
		const tr = state.update({
			selection: EditorSelection.cursor(plain_doc.length),
			userEvent: "select",
		});
		expect(tr.state.doc.toString()).toBe("x{==hl==}y");
	});
});
