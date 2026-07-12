import { EditorState } from "@codemirror/state";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { providePluginSettingsExtension } from "../src/editor/uix/extensions";

// EXPL: DEFAULT_SETTINGS.enable_metadata is false; enabling it is required for the parser
// to recognize and construct metadata fields in ranges. Without it, metadata blocks are ignored.
const pluginSettingsField = providePluginSettingsExtension(
	<any> { settings: { ...DEFAULT_SETTINGS, enable_metadata: true } },
);

function parseFirstRange(doc: string) {
	const state = EditorState.create({ doc, extensions: [rangeParser, pluginSettingsField] });
	return state.field(rangeParser).ranges.ranges[0];
}

describe("delete_metadata", () => {
	test("deleting the only key removes the whole metadata block", () => {
		const range = parseFirstRange(`x{~~{"author":"A"}@@a~>b~~}y`);
		expect(range.fields.author).toBe("A");

		const changes = range.delete_metadata("author");
		// EXPL: metadata block spans from after "{~~" to after "@@"
		expect(changes).toEqual([{ from: range.from + 3, to: range.metadata! + 2, insert: "" }]);
	});

	test("deleting one of several keys rewrites the remaining metadata", () => {
		const range = parseFirstRange(`x{~~{"author":"A","time":1}@@a~>b~~}y`);

		const changes = range.delete_metadata("time");
		expect(changes).toEqual([{ from: range.from + 3, to: range.metadata!, insert: `{"author":"A"}` }]);
	});

	test("deleting an absent key is a no-op", () => {
		const range = parseFirstRange(`x{~~{"author":"A"}@@a~>b~~}y`);
		expect(range.delete_metadata("color")).toEqual([]);
	});
});
