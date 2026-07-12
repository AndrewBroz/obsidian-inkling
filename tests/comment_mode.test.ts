import { EditorState } from "@codemirror/state";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import {
	commentMode,
	commentModeAnnotation,
} from "../src/editor/uix/extensions/editing-modes/comment-mode";
import { createRangeState } from "./helpers";

const NO_META = { add_metadata: false };

function commentModeState(doc: string): EditorState {
	return createRangeState(doc, NO_META, [
		commentMode({ ...DEFAULT_SETTINGS, add_metadata: false }),
	]);
}

describe("comment mode blocks document edits", () => {
	test("typing in plain text is filtered out", () => {
		const state = commentModeState("hello world");
		const tr = state.update({
			changes: { from: 5, to: 5, insert: "X" },
			userEvent: "input",
		});
		expect(tr.state.doc.toString()).toBe("hello world");
	});

	test("deleting document text is filtered out", () => {
		const state = commentModeState("hello world");
		const tr = state.update({
			changes: { from: 0, to: 5, insert: "" },
			userEvent: "delete",
		});
		expect(tr.state.doc.toString()).toBe("hello world");
	});

	test("typing inside a comment's content is allowed", () => {
		const doc = "hello {>>note<<} world";
		const state = commentModeState(doc);
		// position inside "note": after "{>>" (7..10 is "not"...) — compute from the doc
		const inside = doc.indexOf("note") + 2;
		const tr = state.update({
			changes: { from: inside, to: inside, insert: "X" },
			userEvent: "input",
		});
		expect(tr.state.doc.toString()).toBe("hello {>>noXte<<} world");
	});

	test("an annotated comment operation is allowed anywhere", () => {
		const state = commentModeState("hello world");
		const tr = state.update({
			changes: { from: 5, to: 5, insert: "{>><<}" },
			userEvent: "input",
			annotations: [commentModeAnnotation.of(true)],
		});
		expect(tr.state.doc.toString()).toBe("hello{>><<} world");
	});

	test("non-user-event (programmatic) transactions pass through", () => {
		const state = commentModeState("hello world");
		const tr = state.update({
			changes: { from: 0, to: 5, insert: "HELLO" },
		});
		expect(tr.state.doc.toString()).toBe("HELLO world");
	});

	test("an edit spanning from a comment into document text is blocked", () => {
		const doc = "hello {>>note<<} world";
		const state = commentModeState(doc);
		const inside = doc.indexOf("note");
		const tr = state.update({
			changes: { from: inside, to: doc.length, insert: "" },
			userEvent: "delete",
		});
		expect(tr.state.doc.toString()).toBe(doc);
	});
});
