import { browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

import {
	ACTIVE_EDITOR,
	ACTIVE_LEAF,
	backgroundAlpha,
	elementWithText,
	noteText,
	openNote,
	resizeWindow,
	select,
	settle,
	type,
} from "../helpers";

// Regressions (0.13.4): a draft comment's anchor wasn't highlighted and the "add comment" pill stayed up over it;
// clicking away left the draft open, and a leftover draft blocked every new comment; opening and submitting a draft
// re-ran the gutter's unfold animation, so the note's text jumped sideways (at a wide window).

const PILL = ".cmtr-comment-pill-button";
const DRAFT = `${ACTIVE_LEAF} .cmtr-anno-gutter-thread-pending`;
const cards = () => browser.$$(`${ACTIVE_LEAF} .cmtr-anno-gutter-thread`);

/** Clicks the note's first line (its heading), away from the draft. */
async function clickAway() {
	await browser.$$(`${ACTIVE_EDITOR} .cm-content > .cm-line`)[0].click();
	await settle(300);
}

/** Selects `text` (its `nth` occurrence) and clicks the pill that offers to comment on it. */
async function startDraft(text: string, nth = 0) {
	await select(text, { nth });
	await browser.$(PILL).waitForDisplayed({ timeoutMsg: "the add-comment pill did not appear over the selection" });
	await browser.$(PILL).click();
	await browser.$(DRAFT).waitForExist({ timeoutMsg: "no draft card appeared" });
	await settle(300);
}

/** The left edge of the note's text column. */
const textX = () =>
	browser.execute((selector: string) => {
		const line = document.querySelector(`${selector} .cm-content > .cm-line`);
		return line ? Math.round(line.getBoundingClientRect().x) : NaN;
	}, ACTIVE_EDITOR);

/**
 * Runs `action` while the page records the text column's left edge on every frame, until `ms` after it ends: a jump
 * that slides back during the gutter's 0.4 s animation shows up here even when the end position is right.
 */
async function textXDuring(action: () => Promise<void>, ms = 1000): Promise<number[]> {
	await browser.execute((selector: string) => {
		const w = window as unknown as { __e2eX?: number[]; __e2eXStop?: boolean };
		w.__e2eX = [];
		w.__e2eXStop = false;
		const sample = () => {
			const line = document.querySelector(`${selector} .cm-content > .cm-line`);
			if (line) w.__e2eX?.push(Math.round(line.getBoundingClientRect().x));
			if (!w.__e2eXStop) requestAnimationFrame(sample);
		};
		requestAnimationFrame(sample);
	}, ACTIVE_EDITOR);
	await action();
	await browser.pause(ms);
	return browser.execute(() => {
		const w = window as unknown as { __e2eX?: number[]; __e2eXStop?: boolean };
		w.__e2eXStop = true;
		return w.__e2eX ?? [];
	});
}

describe("Draft comment", function() {
	describe("in a note with comments", function() {
		before(async function() {
			await openNote("Draft.md");
			await settle(300);
		});

		it("highlights the anchor and hides the pill while drafting", async function() {
			await startDraft("This is some text");
			const anchor = await elementWithText(`${ACTIVE_EDITOR} .cm-content .cmtr-highlight`, "This is some text");
			if (!anchor) throw new Error("the draft's anchor is not highlighted");
			expect(await backgroundAlpha(anchor)).toBeGreaterThan(0);
			await expect(browser.$(PILL)).not.toBeDisplayed();
			// Nothing is written until the draft is committed.
			expect(await noteText()).toBe(await obsidianPage.read("Draft.md"));
		});

		it("commits the draft when clicking away", async function() {
			await type("Is this repeated?");
			await clickAway();
			await expect(browser.$(DRAFT)).not.toExist();
			expect(await noteText()).toMatch(
				/^\{==This is some text==\}\{>>Is this repeated\?<<\}\{author=Tester time=\d+\}$/m,
			);
		});

		it("discards an empty draft when clicking away", async function() {
			const before = await noteText();
			const count = await cards().length;
			await startDraft("This is some text", 1);
			await clickAway();
			await expect(browser.$(DRAFT)).not.toExist();
			expect(await noteText()).toBe(before);
			expect(await cards().length).toBe(count);
		});

		it("starts a new draft after one was discarded", async function() {
			await startDraft("Trying to suggest");
			await type("Which one?");
			await clickAway();
			expect(await noteText()).toContain("{==Trying to suggest==}{>>Which one?<<}");
		});
	});

	describe("at a wide window", function() {
		before(async function() {
			const width = await resizeWindow(2400, 1400);
			// The layout bug needs side margins: readable line length with room beside the text for the comment column.
			expect(width).toBeGreaterThanOrEqual(2000);
			// The notes as the fixture has them, without the comments written above.
			await obsidianPage.resetVault();
		});

		for (const [note, words] of [["Draft.md", "This is some text"], ["Draft-empty.md", "some words"]]) {
			const state = note === "Draft.md" ? "already open" : "opened by the draft";
			it(`keeps the text in place when a draft opens and is submitted (comment column ${state})`, async function() {
				await openNote(note);
				await settle(800);
				const x = await textX();
				const opening = await textXDuring(() => startDraft(words));
				await type("A comment.");
				const submitting = await textXDuring(() => clickAway());
				expect(await noteText()).toContain(`{==${words}==}{>>A comment.<<}`);
				expect({ opening: [...new Set(opening)], submitting: [...new Set(submitting)] })
					.toEqual({ opening: [x], submitting: [x] });
			});
		}
	});
});
