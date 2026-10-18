import { EditorView } from "@codemirror/view";

import { DEFAULT_SETTINGS } from "../src/constants";
import { text_copy } from "../src/editor/base/edit-handler/copy";
import { createRangeState } from "./helpers";

// EXPL: Copy with `clipboard_remove_syntax` strips CriticMarkup. Comment text is not document
//       text (reading view hides resolved comments for the same reason), so a comment must not
//       end up inlined into the copied prose.
function copy(doc: string, from = 0, to = doc.length) {
	const state = createRangeState(doc).update({ selection: { anchor: from, head: to } }).state;
	const view = { state } as unknown as EditorView;
	let copied: string | null = null;
	const event = {
		clipboardData: { setData: (_type: string, text: string) => (copied = text) },
		preventDefault: () => {},
	} as unknown as ClipboardEvent;
	text_copy({ ...DEFAULT_SETTINGS, clipboard_remove_syntax: true }, event, view);
	return copied;
}

describe("copy strips CriticMarkup", () => {
	test("drops comments and their metadata", () => {
		const doc = `This is {=={"author":"Andrew","time":1791819807}@@some==}`
			+ `{>>{"author":"Andrew","time":1791819807}@@This is a comment on the text<<} text`;
		expect(copy(doc)).toBe("This is some text");
	});

	test("drops a comment thread with replies", () => {
		expect(copy("a{==b==}{>>first<<}{>>reply<<} c")).toBe("ab c");
	});

	test("drops a partially selected comment", () => {
		const doc = "keep{>>comment<<} tail";
		expect(copy(doc, 0, doc.indexOf("ment"))).toBe("keep");
	});

	test("still unwraps suggestions and highlights", () => {
		expect(copy("a{++b++}c{==d==}e")).toBe("abcde");
	});

	test("drops attribute blocks with their ranges", () => {
		expect(copy(`This is {==some==}{>>note<<}{author=Andrew time=1} text`)).toBe("This is some text");
		expect(copy(`a{++b++}{author=A}c`)).toBe("abc");
	});
});
