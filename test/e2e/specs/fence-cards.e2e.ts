import { browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";

import { ACTIVE_EDITOR, ACTIVE_LEAF, noteText, openNote, settle, type } from "../helpers";

// Regression (0.14.1): when the note's code blocks changed (a fence typed), the ranges were rebuilt without the old ones
// being removed, so the annotation gutter drew every card again (and live preview every mark).

const cards = () => browser.$$(`${ACTIVE_LEAF} .cmtr-anno-gutter .cmtr-anno-gutter-thread`);

async function cursorToEnd() {
	await browser.executeObsidian(({ app, obsidian }) => {
		const editor = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor;
		if (!editor) throw new Error("no active editor");
		editor.focus();
		editor.setCursor(editor.offsetToPos(editor.getValue().length));
	});
}

describe("Typing a code fence in a commented note", function() {
	let initial: number;

	before(async function() {
		await openNote("Comments.md");
		await settle(500);
		initial = await cards().length;
		// Comments.md: three comments and three suggestions.
		expect(initial).toBe(6);
	});

	it("keeps one card per annotation when a fence opens a code block", async function() {
		await cursorToEnd();
		await type(["Enter", "Enter", "`", "`", "`"]);
		expect(await noteText()).toContain("\n```");
		await settle(300);
		expect(await cards().length).toBe(initial);
	});

	it("keeps one card per annotation when code is typed and the block is closed", async function() {
		await type(["Enter", "c", "o", "d", "e", "Enter", "`", "`", "`"]);
		await settle(300);
		expect(await cards().length).toBe(initial);
	});

	it("keeps one highlight per comment in live preview", async function() {
		// The fixture's three comments; a doubled range would draw nested marks.
		await expect(browser.$$(`${ACTIVE_EDITOR} .cmtr-highlight`)).toBeElementsArrayOfSize(3);
	});

	it("keeps one card per annotation when the fence is deleted again", async function() {
		await browser.executeObsidian(({ app, obsidian }) => {
			const editor = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor;
			if (!editor) throw new Error("no active editor");
			const text = editor.getValue();
			const fence = text.indexOf("```");
			editor.setCursor(editor.offsetToPos(fence + 3));
		});
		await type(["Backspace", "Backspace", "Backspace"]);
		await settle(300);
		expect(await cards().length).toBe(initial);
	});
});
