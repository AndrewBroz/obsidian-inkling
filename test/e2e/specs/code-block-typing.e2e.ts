import { browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

import { noteText, openNote, PLUGIN_ID, select, settle, toggleSuggestMode, type } from "../helpers";

// Regression (0.14.1): in a code block, selecting text and typing `{` (Obsidian wraps the selection in braces) then
// `~~` made tag completion delete the selection and write `{~~~>~~}}`. In a code block every keystroke must do what it
// does without Inkling, in Editing and in Suggest mode. The same keystrokes are typed with Inkling disabled first, and
// that result is the expected one.

// Code-typing.md has "alpha" once in prose and once in a code block.
const FIXTURE = "Code-typing.md";
const KEYS = ["{", "~", "~"];

interface Case {
	name: string;
	/** The occurrence of "alpha" to select: 0 is in the prose, 1 in the code block. */
	nth: number;
	suggest: boolean;
}

const CASES: Case[] = [
	{ name: "in a code block, in Editing mode", nth: 1, suggest: false },
	{ name: "in a code block, in Suggest mode", nth: 1, suggest: true },
	{ name: "in prose, in Editing mode", nth: 0, suggest: false },
];

let notes = 0;

let original: string;

/** Opens a fresh copy of the fixture, selects "alpha" and types the keys; returns the note's text. */
async function typeOverSelection({ nth, suggest }: Case): Promise<string> {
	const path = `Typing ${++notes}.md`;
	await obsidianPage.write(path, original);
	await openNote(path);
	if (suggest) await toggleSuggestMode();
	await select("alpha", { nth });
	await type(KEYS);
	await settle(300);
	return noteText();
}

describe("Typing over a selection with auto-paired brackets", function() {
	const expected = new Map<Case, string>();

	before(async function() {
		original = await obsidianPage.read(FIXTURE);
		await obsidianPage.disablePlugin(PLUGIN_ID);
		for (const c of CASES)
			expected.set(c, await typeOverSelection({ ...c, suggest: false }));
		await obsidianPage.enablePlugin(PLUGIN_ID);
		await browser.waitUntil(() =>
			browser.executeObsidian(({ app }, id) => app.plugins.getPlugin(id) !== null, PLUGIN_ID)
		);
	});

	for (const c of CASES) {
		it(`does what Obsidian does without Inkling ${c.name}`, async function() {
			const without = expected.get(c);
			// The keystrokes took effect without Inkling, so the comparison means something.
			expect(without).not.toBe(original);
			expect(await typeOverSelection(c)).toBe(without);
		});
	}
});
