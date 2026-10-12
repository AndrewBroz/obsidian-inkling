import { enterSubmits } from "../src/ui/comment-keys";

// EXPL: Every comment editor (new comment, reply, editing an existing comment) shares one Enter
//       convention: Enter submits, Shift+Enter inserts a newline. Editing an existing comment used
//       to inherit "Mod+Enter submits, Enter newlines", so Enter there added a line instead of saving.
describe("comment editor Enter convention", () => {
	test("Enter submits and is handled (no newline)", () => {
		const submit = jest.fn();
		expect(enterSubmits(false, submit)).toBe(true);
		expect(submit).toHaveBeenCalledTimes(1);
	});

	test("Shift+Enter is left to CodeMirror (newline) and does not submit", () => {
		const submit = jest.fn();
		expect(enterSubmits(true, submit)).toBe(false);
		expect(submit).not.toHaveBeenCalled();
	});
});
