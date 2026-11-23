import { browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";

import { ACTIVE_EDITOR, ACTIVE_LEAF, openNote, resizeWindow, settle } from "../helpers";

// 0.15.3: while the comments show, the divider line between the note and the comment column and the round
// "Hide comments" button on it are drawn only while the pointer is within 48px of the line (as in Google Docs:
// DIVIDER_REVEAL_RANGE in annotation-gutter.ts). Watching for the pointer must not take clicks or text selection from
// the note or clicks from the cards, and while the comments are hidden the "Show comments" button always shows: it is
// the only way back.
// Regression (found while adding this): after dragging the divider to resize the column, the button was left where
// the divider had been.

const BUTTON = `${ACTIVE_LEAF} .cmtr-anno-gutter-button`;
// Inside and outside the 48px reveal range, with room for rounding.
const INSIDE = 40;
const OUTSIDE = 60;
const HANDLE = `${ACTIVE_LEAF} .cmtr-anno-gutter-resize-handle`;

type Geometry = {
	/** x of the divider line (the middle of the resize handle). */
	divider: number;
	/** x of the round button's centre and y of its centre. */
	button: number;
	buttonY: number;
	/** The visual line of the paragraph that reaches furthest right: its right edge and its middle. */
	lineRight: number;
	lineY: number;
	/** The first card's left edge and middle. */
	cardLeft: number;
	cardY: number;
};

const geometry = () =>
	browser.execute((leaf: string, editor: string): Geometry => {
		const rect = (selector: string) => {
			const el = document.querySelector(selector);
			if (!el) throw new Error(`no ${selector}`);
			return el.getBoundingClientRect();
		};
		const handle = rect(`${leaf} .cmtr-anno-gutter-resize-handle`);
		const button = rect(`${leaf} .cmtr-anno-gutter-button`);
		const card = rect(`${leaf} .cmtr-anno-gutter-thread`);
		const paragraph = [...document.querySelectorAll(`${editor} .cm-content > .cm-line`)]
			.find(line => line.textContent?.includes("quick brown fox"));
		if (!paragraph) throw new Error("no paragraph");
		const range = document.createRange();
		range.selectNodeContents(paragraph);
		const widest = [...range.getClientRects()].reduce((a, b) => (b.right > a.right ? b : a));
		return {
			divider: handle.left + handle.width / 2,
			button: button.left + button.width / 2,
			buttonY: button.top + button.height / 2,
			lineRight: widest.right,
			lineY: widest.top + widest.height / 2,
			cardLeft: card.left,
			cardY: card.top + card.height / 2,
		};
	}, ACTIVE_LEAF, ACTIVE_EDITOR);

const opacity = async (selector: string) => Number((await browser.$(selector).getCSSProperty("opacity")).value);

/** Waits out the 150ms fade until the element's opacity is `value`. */
const waitOpacity = (selector: string, value: number, what: string) =>
	browser.waitUntil(async () => (await opacity(selector)) === value, {
		timeout: 2000,
		timeoutMsg: `${what}: opacity stayed ${value === 1 ? "below 1" : "above 0"}`,
	});

const pointer = () => browser.action("pointer", { parameters: { pointerType: "mouse" } });

const moveTo = (x: number, y: number) =>
	pointer().move({ x: Math.round(x), y: Math.round(y), origin: "viewport" }).perform();

const click = (x: number, y: number) =>
	pointer().move({ x: Math.round(x), y: Math.round(y), origin: "viewport" }).down().up().perform();

/** Presses at the first point, moves to the second (over `duration` ms; 0 jumps there) and releases at once. */
const drag = (x1: number, y1: number, x2: number, y2: number, duration = 200) =>
	pointer()
		.move({ x: Math.round(x1), y: Math.round(y1), origin: "viewport" })
		.down()
		.move({ x: Math.round(x2), y: Math.round(y2), origin: "viewport", duration })
		.up()
		.perform();

/** The active note's selection: its text and the cursor's offset. */
const selection = () =>
	browser.executeObsidian(({ app, obsidian }) => {
		const editor = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor;
		if (!editor) throw new Error("no active editor");
		return { text: editor.getSelection(), head: editor.posToOffset(editor.getCursor("head")) };
	});

const label = async () => (await browser.$(`${BUTTON} button`).getAttribute("aria-label")) ?? "";

describe("Comment column controls show on hover", function() {
	let at: Geometry;

	before(async function() {
		await resizeWindow(2400, 1400);
		await openNote("Hover.md");
		await settle(800);
		at = await geometry();
		// The paragraph has to reach the column for "right next to the divider" to mean anything.
		expect(at.divider - at.lineRight).toBeLessThan(40);
	});

	it("hides the divider line and the button while the pointer is away", async function() {
		await moveTo(at.divider - 300, at.lineY);
		await waitOpacity(BUTTON, 0, "button at rest");
		await waitOpacity(HANDLE, 0, "divider line at rest");
		expect(await label()).toBe("Hide comments");
	});

	it("shows them when the pointer comes within 48px of the divider, on either side", async function() {
		for (const [side, x, y] of [["note", at.divider - INSIDE, at.lineY], ["card", at.divider + INSIDE, at.cardY]] as const) {
			await moveTo(at.divider + (side === "note" ? -OUTSIDE : OUTSIDE), y);
			await waitOpacity(BUTTON, 0, `button ${OUTSIDE}px away on the ${side} side`);
			await waitOpacity(HANDLE, 0, `divider line ${OUTSIDE}px away on the ${side} side`);
			await moveTo(x, y);
			await waitOpacity(BUTTON, 1, `button ${INSIDE}px away on the ${side} side`);
			await waitOpacity(HANDLE, 1, `divider line ${INSIDE}px away on the ${side} side`);
		}
		await moveTo(at.divider - 300, at.lineY);
		await waitOpacity(BUTTON, 0, "button after the pointer left");
	});

	it("still lets the note take clicks and text selection right next to the divider", async function() {
		const x = Math.min(at.lineRight - 4, at.divider - INSIDE);
		expect(at.divider - x).toBeLessThanOrEqual(48);
		await click(x, at.lineY);
		await settle();
		const clicked = await selection();
		expect(clicked.text).toBe("");
		// The cursor lands near the end of that visual line, past the paragraph's first line, not somewhere else.
		expect(clicked.head).toBeGreaterThan(100);
		await drag(x, at.lineY, x - 200, at.lineY);
		await settle();
		const selected = await selection();
		expect(selected.text.length).toBeGreaterThan(10);
		expect(selected.text).toContain(" ");
	});

	it("still lets a card take a click at its edge, by the divider", async function() {
		await click(at.cardLeft + 6, at.cardY);
		await settle(300);
		expect(await browser.$(`${ACTIVE_LEAF} .cmtr-anno-gutter-thread-highlight`).isExisting()).toBe(true);
	});

	it("shows the button while it has keyboard focus", async function() {
		await moveTo(at.divider - 300, at.lineY);
		await waitOpacity(BUTTON, 0, "button at rest");
		await browser.execute((selector: string) => {
			document.querySelector<HTMLElement>(`${selector} button`)?.focus({ focusVisible: true } as FocusOptions);
		}, BUTTON);
		await waitOpacity(BUTTON, 1, "focused button");
		await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
		await waitOpacity(BUTTON, 0, "button after losing focus");
	});

	it("keeps the button on the divider after the column is resized", async function() {
		// EXPL: A quick drag: the column's last width lands just after the button is let go, which is when the button
		//       used to be placed from a column still in its width transition.
		await drag(at.divider, at.lineY + 200, at.divider - 60, at.lineY + 200, 0);
		await settle(1200);
		const resized = await geometry();
		expect(Math.abs(resized.divider - at.divider)).toBeGreaterThan(10);
		expect(Math.abs(resized.button - resized.divider)).toBeLessThan(2);
		await drag(resized.divider, at.lineY + 200, resized.divider + 60, at.lineY + 200, 0);
		await settle(1200);
		at = await geometry();
	});

	it("always shows the button while the comments are hidden", async function() {
		const now = await geometry();
		await click(now.button, now.buttonY);
		await browser.waitUntil(async () => (await label()) === "Show comments", {
			timeoutMsg: "the button did not hide the comments",
		});
		await moveTo(at.divider - 300, at.lineY);
		await settle(600);
		expect(await opacity(BUTTON)).toBe(1);
		expect(await browser.$(`${ACTIVE_LEAF} .cmtr-anno-gutter`).getSize("width")).toBe(0);
		// And it brings them back.
		const button = await browser.$(`${BUTTON} button`);
		await button.click();
		await browser.waitUntil(async () => (await label()) === "Hide comments", {
			timeoutMsg: "the button did not show the comments again",
		});
		await settle(600);
	});
});
