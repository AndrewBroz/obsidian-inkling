import { EditorState } from "@codemirror/state";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import {
	commentMode,
	commentModeAnnotation,
} from "../src/editor/uix/extensions/editing-modes/comment-mode";
import { pluginEditAnnotation } from "../src/editor/uix/extensions/editing-modes/tracked-edit";
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

	// EXPL: Task 5 flipped comment-mode's gate from an allowlist to the shared fail-closed denylist
	//       (tracked-edit.ts): a doc-changing transaction with no recognised userEvent is now GATED,
	//       not passed through, because that same "no userEvent" shape is how an untracked edit (an
	//       image paste, a dragged selection) could otherwise slip past the block. Inkling's own
	//       programmatic writes (accept/reject from the gutter, resolve/reopen a thread, comment-widget
	//       edits) are exactly as eventless as an image paste, so they now carry `pluginEditAnnotation`
	//       to say "this one is ours" -- see every dispatch site in commands.ts, context-menu.ts,
	//       diffs-gutter/index.ts, annotations-gutter/marker.ts, and live-preview/comment-widget.ts.
	//       This test's "programmatic transaction" must be built the same way a real one now is.
	test("an annotated (Inkling-originated) transaction with no userEvent passes through", () => {
		const state = commentModeState("hello world");
		const tr = state.update({
			changes: { from: 0, to: 5, insert: "HELLO" },
			annotations: [pluginEditAnnotation.of(true)],
		});
		expect(tr.state.doc.toString()).toBe("HELLO world");
	});

	test("an UNANNOTATED transaction with no userEvent at all is still gated (fail closed)", () => {
		// The property this task exists to establish: eventless is no longer a free pass.
		const state = commentModeState("hello world");
		const tr = state.update({
			changes: { from: 0, to: 5, insert: "HELLO" },
		});
		expect(tr.state.doc.toString()).toBe("hello world");
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
