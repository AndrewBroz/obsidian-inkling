import { browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";

import {
	ACTIVE_EDITOR,
	ACTIVE_LEAF,
	backgroundAlpha,
	elementWithText,
	noteText,
	openNote,
	select,
	settle,
	type,
} from "../helpers";

// Comments on code blocks (0.15.0): the comment is written after the closing fence with the selected code as its quote,
// focusing it highlights that code, and a card whose code is gone says so.

const PILL = ".cmtr-comment-pill-button";
const CHANGED = "This code has changed";

/** The gutter card whose comment text is `comment`. */
async function card(comment: string): Promise<WebdriverIO.Element> {
	for (const element of await browser.$$(`${ACTIVE_LEAF} .cmtr-anno-gutter-thread`).getElements())
		if ((await element.getText()).includes(comment)) return element;
	throw new Error(`no card with "${comment}"`);
}

describe("Comments on code blocks", function() {
	before(async function() {
		await openNote("Code-comments.md");
		await settle(300);
	});

	it("writes a comment on selected code after the closing fence, with its quote", async function() {
		await select("greet");
		await browser.$(PILL).waitForDisplayed({ timeoutMsg: "no add-comment pill over the selected code" });
		await browser.$(PILL).click();
		await browser.$(`${ACTIVE_LEAF} .cmtr-anno-gutter-thread-pending`).waitForExist();
		await type("Name it for what it returns.");
		await type(["Enter"]);
		await settle(300);
		const text = await noteText();
		expect(text).toMatch(
			/\n\}\n```\n\{>>Name it for what it returns\.<<\}\{author=Tester time=\d+ quote=greet line=1\}\n/,
		);
		// The code itself is unchanged.
		expect(text).toContain("```ts\nfunction greet(name: string) {\n\treturn `Hello, ${name}`;\n}\n```");
	});

	it("shows the quoted code on the comment's card", async function() {
		expect(await (await card("Name it for what it returns.")).getText()).toContain("greet");
	});

	it("highlights the quoted code when the comment is focused", async function() {
		await (await card("Name it for what it returns.")).click();
		const quote = browser.$(`${ACTIVE_EDITOR} .cm-content .cmtr-code-quote-focus`);
		await quote.waitForExist({ timeoutMsg: "focusing the comment did not highlight its code" });
		expect(await quote.getText()).toBe("greet");
		expect(await backgroundAlpha(quote)).toBeGreaterThan(0);
	});

	it("says the code has changed when the quoted code is edited away", async function() {
		expect(await (await card("Name it for what it returns.")).getText()).not.toContain(CHANGED);
		await select("greet", { nth: 0 });
		await type("welcome");
		expect(await noteText()).toContain("function welcome(name: string)");
		await settle(300);
		expect(await (await card("Name it for what it returns.")).getText()).toContain(CHANGED);
	});

	it("marks the fixture's comment on changed code, and not the others", async function() {
		expect(await (await card("Is this right?")).getText()).toContain(CHANGED);
		expect(await (await card("Why not const?")).getText()).not.toContain(CHANGED);
		expect(await elementWithText(`${ACTIVE_LEAF} .cmtr-code-quote-changed`, CHANGED)).toBeDefined();
	});
});
