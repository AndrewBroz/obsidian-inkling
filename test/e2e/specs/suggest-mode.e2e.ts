import { expect } from "@wdio/globals";
import { before, describe, it } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

import { noteText, openNote, runCommand, select, settle, toggleSuggestMode, type } from "../helpers";

// Suggest mode: typing is written as attributed suggestions, line markers go in untracked (0.14.1), and suggestions
// can be accepted and rejected.

const META = String.raw`\{author=Tester time=\d+\}`;

describe("Suggest mode", function() {
	let original: string;

	before(async function() {
		original = await obsidianPage.read("Suggest.md");
		await openNote("Suggest.md");
		await toggleSuggestMode();
	});

	it("writes typed text as an addition with author and time", async function() {
		await select("brown", { cursor: true });
		await type("very ");
		expect(await noteText()).toMatch(new RegExp(String.raw`The quick \{\+\+very \+\+\}${META}brown fox`));
	});

	it("writes deleted text as a deletion", async function() {
		await select("lazy ");
		await type(["Backspace"]);
		expect(await noteText()).toMatch(new RegExp(String.raw`the \{--lazy --\}${META}dog\.`));
	});

	it("types a line marker at the start of a line untracked, and the text after it tracked", async function() {
		// The blank line between the two paragraphs.
		await select("\n\nA line", { cursor: true, offset: 1 });
		await type("> new text");
		expect(await noteText()).toMatch(new RegExp(String.raw`\n> \{\+\+new text\+\+\}${META}\nA line`));
	});

	it("accepts a suggestion in the selection", async function() {
		await select("very ");
		await runCommand("accept-selected-suggestions");
		await settle();
		expect(await noteText()).toContain("The quick very brown fox");
		expect(await noteText()).not.toContain("{++very ++}");
	});

	it("rejects a suggestion in the selection", async function() {
		await select("lazy ");
		await runCommand("reject-selected-suggestions");
		await settle();
		expect(await noteText()).toContain("over the lazy dog.");
		expect(await noteText()).not.toContain("{--lazy --}");
	});

	it("rejects all suggestions, which restores the note", async function() {
		await runCommand("reject-all-suggestions");
		await settle();
		// The very and lazy suggestions were already settled, so only the quote's addition is left.
		expect(await noteText()).toBe(
			original.replace("The quick brown", "The quick very brown").replace("\n\nA line", "\n> \nA line"),
		);
	});
});
