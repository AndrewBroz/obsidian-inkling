import { browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

const PLUGIN_ID = "inkling-markup";
// wdio 10 selectors are strict (one match); scope to the focused leaf, since earlier notes stay open in other tabs.
const ACTIVE_EDITOR = ".workspace-leaf.mod-active .markdown-source-view";

/**
 * Wraps console.error/console.warn and window error events in the page so a spec can read them back.
 * Installed before the note is opened, so errors thrown while decorations are built are captured.
 * (CodeMirror reports exceptions raised in view plugins/decorations through console.error.)
 */
async function captureConsole() {
	await browser.execute(() => {
		const w = window as unknown as { __e2eLog?: string[] };
		if (w.__e2eLog) return;
		const log: string[] = (w.__e2eLog = []);
		const fmt = (args: unknown[]) =>
			args.map(a => a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : String(a)).join(" ");
		for (const level of ["error", "warn"] as const) {
			const orig = console[level].bind(console);
			console[level] = (...args: unknown[]) => {
				log.push(`${level}: ${fmt(args)}`);
				orig(...args);
			};
		}
		window.addEventListener("error", e => log.push(`uncaught: ${e.message}`));
		window.addEventListener("unhandledrejection", e => log.push(`unhandledrejection: ${String(e.reason)}`));
	});
}

async function readConsole(): Promise<string[]> {
	return browser.execute(() => (window as unknown as { __e2eLog?: string[] }).__e2eLog ?? []);
}

/**
 * Alpha (0–255) of a computed CSS colour, resolved by the page's own canvas.
 * getCSSProperty only normalises rgb()/rgba(); newer Obsidian themes compute to `oklch(… / 0.3)`, which it returns as-is.
 * Returns -1 for a value the page can't parse as a colour (so a parse failure never passes as "opaque").
 */
async function colorAlpha(value: string | undefined): Promise<number> {
	return browser.execute((color: string) => {
		if (!CSS.supports("color", color)) return -1;
		const ctx = document.createElement("canvas").getContext("2d")!;
		ctx.fillStyle = color;
		ctx.fillRect(0, 0, 1, 1);
		return ctx.getImageData(0, 0, 1, 1).data[3];
	}, value ?? "");
}

describe("Comment highlight in live preview", function() {
	before(async function() {
		await captureConsole();
		await obsidianPage.openFile("Comments.md");
		// Live preview is Obsidian's default editing mode; make sure the note opened in it.
		const mode = await browser.executeObsidian(({ app, obsidian }) => {
			const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
			return { mode: view?.getMode(), source: view?.getState().source };
		});
		expect(mode).toEqual({ mode: "source", source: false });
		await browser.$(`${ACTIVE_EDITOR}.is-live-preview .cm-content`).waitForExist();
	});

	it("loads the preset plugin settings from the fixture vault", async function() {
		const author = await browser.executeObsidian(({ app }, id) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return (app.plugins.plugins[id] as any)?.settings?.author;
		}, PLUGIN_ID);
		expect(author).toBe("Tester");
	});

	it("does not show the first-run author prompt", async function() {
		await expect(browser.$(".modal-container")).not.toExist();
	});

	it("paints every comment highlight (new, legacy and bare metadata)", async function() {
		const highlights = browser.$$(`${ACTIVE_EDITOR} .cmtr-highlight`);
		await browser.waitUntil(async () => (await highlights.length) === 3, {
			timeoutMsg: "expected the 3 comment highlights in Comments.md",
		});
		for (const highlight of highlights) {
			const bg = await highlight.getCSSProperty("background-color");
			expect(await colorAlpha(bg.value)).toBeGreaterThan(0);
		}
	});

	it("logs no decoration sorting errors", async function() {
		// Give CodeMirror a couple of update cycles after the initial render
		await browser.pause(500);
		const sortErrors = (lines: string[]) => lines.filter(l => l.includes("Ranges must be added sorted"));
		expect(sortErrors(await readConsole())).toEqual([]);
		// Chromedriver's log also covers anything before the capture was installed (it drains on each read)
		const driverLog = (await browser.getLogs("browser") as { message: string }[]).map(l => l.message);
		expect(sortErrors(driverLog)).toEqual([]);
	});
});
