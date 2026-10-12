/**
 * The Enter convention shared by every comment editor (new comment, reply, editing an existing comment):
 * Enter (with or without Mod) submits, Shift+Enter inserts a newline.
 * @returns whether the key was handled; false lets CodeMirror insert the newline
 */
export function enterSubmits(shift: boolean, submit: () => void): boolean {
	if (shift)
		return false;
	submit();
	return true;
}
