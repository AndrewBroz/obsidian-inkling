import { browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";

import {
	ACTIVE_EDITOR,
	backgroundAlpha,
	captureConsole,
	consoleErrors,
	openNote,
	PLUGIN_ID,
	settle,
} from "../helpers";

// Regression (0.13.1): with a trailing attribute block ({author=… time=…}), decorations were added unsorted, CodeMirror
// threw "Ranges must be added sorted" and live preview rendered nothing.

const MARKUP = ["{==", "==}", "{>>", "<<}", "{++", "++}", "{--", "--}", "{~~", "~>", "~~}", "author=", "@@"];

/** The visible text of the editor line that contains `marker`. */
async function lineText(marker: string): Promise<string> {
	return browser.execute(
		(selector: string, marker: string) => {
			const line = [...document.querySelectorAll<HTMLElement>(`${selector} .cm-content > .cm-line`)]
				.find(l => l.innerText.includes(marker));
			return line?.innerText ?? `(no line with "${marker}")`;
		},
		ACTIVE_EDITOR,
		marker,
	);
}

describe("Live preview of a note with attribute blocks", function() {
	before(async function() {
		await captureConsole();
		await openNote("Comments.md");
		// The cursor starts on the heading, so no markup line is being edited.
		await settle(500);
	});

	it("loads the preset plugin settings (no first-run author prompt)", async function() {
		const author = await browser.executeObsidian(({ app }, id) => {
			const plugin = app.plugins.getPlugin(id) as unknown as { settings?: { author?: string } } | null;
			return plugin?.settings?.author;
		}, PLUGIN_ID);
		expect(author).toBe("Tester");
		await expect(browser.$(".modal-container")).not.toExist();
	});

	it("logs no decoration errors", async function() {
		await settle(500);
		const errors = (await consoleErrors()).filter(l => /Ranges must be added sorted|inkling|cmtr/i.test(l));
		expect(errors).toEqual([]);
	});

	it("hides the markup and the attribute blocks", async function() {
		for (const marker of ["New format", "Legacy format", "Bare:", "Suggestions:"]) {
			const text = await lineText(marker);
			expect(text).toContain(marker);
			const shown = MARKUP.filter(markup => text.includes(markup));
			expect({ line: marker, shown }).toEqual({ line: marker, shown: [] });
		}
		// The content itself is still shown.
		expect(await lineText("Suggestions:")).toMatch(/an addition, a deletion, and old\s*new/);
	});

	it("styles highlights, additions, deletions and substitutions", async function() {
		const highlights = browser.$$(`${ACTIVE_EDITOR} .cmtr-highlight`);
		await expect(highlights).toBeElementsArrayOfSize(3);
		for (const highlight of highlights)
			expect(await backgroundAlpha(highlight)).toBeGreaterThan(0);

		const decoration = async (selector: string, text: string) => {
			for (const element of await browser.$$(`${ACTIVE_EDITOR} ${selector}`).getElements()) {
				if ((await element.getText()) === text)
					return (await element.getCSSProperty("text-decoration-line")).value;
			}
			return `(no ${selector} "${text}")`;
		};
		expect(await decoration(".cmtr-addition", "addition")).toBe("underline");
		expect(await decoration(".cmtr-deletion", "deletion")).toBe("line-through");
		// A substitution: the old text struck through, the new text underlined.
		expect(await decoration(".cmtr-deletion", "old")).toBe("line-through");
		expect(await decoration(".cmtr-addition", "new")).toBe("underline");
	});
});
