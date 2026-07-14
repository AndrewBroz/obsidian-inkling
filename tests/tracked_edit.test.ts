import { Annotation, EditorState, Transaction } from "@codemirror/state";
import { is_exempt_from_tracking, pluginEditAnnotation } from "../src/editor/uix/extensions/editing-modes/tracked-edit";

// EXPL: Suggest mode used an ALLOWLIST of userEvents (input / paste / delete). Anything unrecognised
//       passed through UNTRACKED, silently -- which is how a dragged selection ("move.drop", see
//       @codemirror/view dropText) and image paste escaped a mode whose entire promise is that every
//       edit is tracked. The same list was copied into three files and was correct in only one of
//       them (comment-mode.ts alone included "move").
//
//       These tests pin the INVERSION: unknown means tracked.
function txWith(userEvent?: string, annotate?: Annotation<any>) {
	const state = EditorState.create({ doc: "hello" });
	return state.update({
		changes: { from: 5, to: 5, insert: "!" },
		userEvent,
		annotations: annotate ? [annotate] : undefined,
	});
}

describe("tracked edits fail CLOSED", () => {
	test("a dragged selection (move.drop) is tracked", () => {
		expect(is_exempt_from_tracking(txWith("move.drop"))).toBe(false);
	});

	test("an edit with NO userEvent at all is tracked (image paste)", () => {
		expect(is_exempt_from_tracking(txWith(undefined))).toBe(false);
	});

	test("an edit with a userEvent nobody has ever heard of is tracked", () => {
		// The whole point. A future Obsidian or plugin edit path must not be silently exempt.
		expect(is_exempt_from_tracking(txWith("some.future.event"))).toBe(false);
	});

	test("the ordinary events are still tracked", () => {
		for (const e of ["input.type", "input.paste", "delete.backward", "input.drop"])
			expect(is_exempt_from_tracking(txWith(e))).toBe(false);
	});
});

describe("the denylist exempts only what it must", () => {
	test("undo is exempt", () => {
		expect(is_exempt_from_tracking(txWith("undo"))).toBe(true);
	});

	test("redo is exempt", () => {
		expect(is_exempt_from_tracking(txWith("redo"))).toBe(true);
	});

	test("our own transactions are exempt, so the filter cannot recurse", () => {
		expect(is_exempt_from_tracking(txWith("input.type", pluginEditAnnotation.of(true)))).toBe(true);
	});

	test("a remote (collaborative) change is exempt", () => {
		expect(is_exempt_from_tracking(txWith("input.type", Transaction.remote.of(true)))).toBe(true);
	});
});
