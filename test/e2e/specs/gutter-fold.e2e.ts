import { browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";

import { ACTIVE_EDITOR, ACTIVE_LEAF, openNote, resizeWindow, settle } from "../helpers";

// Regression (0.15.0): with the right sidebar open, the 300px comment column took its width from the note, and the
// text was squeezed down to a word or so per line. The column now folds on its own while the pane is too narrow for
// the readable text beside it, and comes back when the pane is wide again, without changing the saved fold state.

/** The note's text width, the comment column's width, and the fold button's label and element. */
const layout = () =>
	browser.execute(
		(leaf: string, editor: string) => {
			const width = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().width ?? NaN;
			const button = document.querySelector<HTMLElement>(`${leaf} .cmtr-anno-gutter-button button`);
			return {
				text: Math.round(width(`${editor} .cm-content`)),
				gutter: Math.round(width(`${leaf} .cmtr-anno-gutter`)),
				label: button?.getAttribute("aria-label") ?? "",
				tag: button?.tagName ?? "",
			};
		},
		ACTIVE_LEAF,
		ACTIVE_EDITOR,
	);

/** The fold state saved with the layout (the view state Obsidian persists). */
const savedFold = () =>
	browser.executeObsidian(({ app, obsidian }) =>
		app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.leaf.getViewState().state?.annotationGutterFolded
	);

const setRightSidebar = (open: boolean) =>
	browser.executeObsidian(({ app }, open) => {
		if (open) app.workspace.rightSplit.expand();
		else app.workspace.rightSplit.collapse();
	}, open);

describe("Comment column in a narrow pane", function() {
	before(async function() {
		await resizeWindow(2400, 1400);
		await setRightSidebar(false);
		await openNote("Comments.md");
		await settle(800);
	});

	after(async function() {
		await setRightSidebar(false);
	});

	it("shows beside the text in a wide pane, with a labelled fold button", async function() {
		const wide = await layout();
		expect(wide.gutter).toBe(300);
		expect(wide.text).toBeGreaterThanOrEqual(600);
		expect(wide.tag).toBe("BUTTON");
		expect(wide.label).toBe("Hide comments");
	});

	it("folds on its own when the pane is too narrow, so the text keeps its width", async function() {
		await setRightSidebar(true);
		await resizeWindow(1200, 900);
		await settle(800);
		const narrow = await layout();
		expect(narrow.gutter).toBe(0);
		// Squeezed by the column, the text was under 300px wide here.
		expect(narrow.text).toBeGreaterThanOrEqual(400);
		expect(narrow.label).toBe("Show comments");
		// An automatic fold isn't the user's choice: the saved state stays unfolded.
		expect(await savedFold()).toBe(false);
	});

	it("comes back when the pane is wide again", async function() {
		await setRightSidebar(false);
		await resizeWindow(2400, 1400);
		await settle(800);
		const wide = await layout();
		expect(wide.gutter).toBe(300);
		expect(wide.label).toBe("Hide comments");
	});
});
