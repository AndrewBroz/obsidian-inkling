import { browser, expect } from "@wdio/globals";
import { afterEach, before, describe, it } from "mocha";

import { ACTIVE_EDITOR, ACTIVE_LEAF, backgroundAlpha, openNote, setMode, settle } from "../helpers";

// Regression (0.13.2): Inkling's highlight colour was mixed from `--text-highlight-bg`, which current Obsidian no
// longer defines, so the colour was invalid and commented text was never highlighted (in either metadata format).
// Comments.md has a comment in the attribute-block format, one in the legacy JSON format and one with no metadata.

const FORMATS = ["highlighted text", "other highlighted text", "plain highlight"];

/** The background alpha of each comment highlight in the active view, by its text. */
async function highlightAlphas(selector: string): Promise<Record<string, number>> {
	const highlights = browser.$$(`${selector} .cmtr-highlight`);
	await browser.waitUntil(async () => (await highlights.length) === FORMATS.length, {
		timeoutMsg: `expected ${FORMATS.length} comment highlights`,
	});
	const alphas: Record<string, number> = {};
	for (const highlight of await highlights.getElements())
		alphas[await highlight.getText()] = await backgroundAlpha(highlight);
	return alphas;
}

function expectPainted(alphas: Record<string, number>) {
	expect(Object.keys(alphas).sort()).toEqual([...FORMATS].sort());
	for (const [text, alpha] of Object.entries(alphas))
		expect({ text, painted: alpha > 0 }).toEqual({ text, painted: true });
}

describe("Comment highlight colour", function() {
	before(async function() {
		await openNote("Comments.md");
	});

	afterEach(async function() {
		await browser.executeObsidian(({ app }) => {
			(app as unknown as { changeTheme(theme: string): void }).changeTheme("moonstone");
		});
	});

	for (const theme of ["moonstone", "obsidian"]) {
		const name = theme === "moonstone" ? "light" : "dark";

		it(`paints every comment highlight in live preview (${name} theme)`, async function() {
			await browser.executeObsidian(({ app }, theme) => {
				(app as unknown as { changeTheme(theme: string): void }).changeTheme(theme);
			}, theme);
			await expect(browser.$("body")).toHaveElementClass(`theme-${name}`);
			await setMode("live");
			await settle();
			expectPainted(await highlightAlphas(ACTIVE_EDITOR));
		});

		it(`paints every comment highlight in reading view (${name} theme)`, async function() {
			await browser.executeObsidian(({ app }, theme) => {
				(app as unknown as { changeTheme(theme: string): void }).changeTheme(theme);
			}, theme);
			await expect(browser.$("body")).toHaveElementClass(`theme-${name}`);
			await setMode("reading");
			await settle();
			expectPainted(await highlightAlphas(`${ACTIVE_LEAF} .markdown-reading-view`));
		});
	}
});
