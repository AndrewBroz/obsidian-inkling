import { browser } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

export const PLUGIN_ID = "inkling-markup";

// EXPL: wdio 10 selectors are strict (one match), and earlier notes stay open in other tabs: scope to the focused leaf.
export const ACTIVE_LEAF = ".workspace-leaf.mod-active";
export const ACTIVE_EDITOR = `${ACTIVE_LEAF} .markdown-source-view`;

export type ViewMode = "live" | "source" | "reading";

/** Opens a vault note in a new tab, in the given view mode (live preview by default). */
export async function openNote(path: string, mode: ViewMode = "live") {
	await obsidianPage.openFile(path);
	await setMode(mode);
}

export async function setMode(mode: ViewMode) {
	await browser.executeObsidian(async ({ app, obsidian }, mode) => {
		const leaf = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.leaf;
		if (!leaf) throw new Error("no active markdown view");
		const state = leaf.getViewState();
		await leaf.setViewState({
			...state,
			state: { ...state.state, mode: mode === "reading" ? "preview" : "source", source: mode === "source" },
		});
	}, mode);
	if (mode === "reading")
		await browser.$(`${ACTIVE_LEAF} .markdown-reading-view`).waitForDisplayed();
	else {
		await browser.$(`${ACTIVE_EDITOR}${mode === "live" ? ".is-live-preview" : ":not(.is-live-preview)"} .cm-content`)
			.waitForExist();
	}
}

/** The active note's text, as the editor holds it. */
export async function noteText(): Promise<string> {
	return browser.executeObsidian(({ app, obsidian }) =>
		app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? ""
	);
}

/** Selects `needle` (its `nth` occurrence, from 0) in the active note, or puts the cursor at its start if `cursor`. */
export async function select(needle: string, { nth = 0, cursor = false, offset = 0 } = {}) {
	await browser.executeObsidian(
		({ app, obsidian }, needle, nth, cursor, offset) => {
			const editor = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor;
			if (!editor) throw new Error("no active editor");
			const text = editor.getValue();
			let at = -1;
			for (let i = 0; i <= nth; i++) {
				at = text.indexOf(needle, at + 1);
				if (at < 0) throw new Error(`"${needle}" (#${nth}) is not in the note`);
			}
			editor.focus();
			const from = editor.offsetToPos(at + offset);
			editor.setSelection(from, cursor ? from : editor.offsetToPos(at + needle.length));
		},
		needle,
		nth,
		cursor,
		offset,
	);
}

/** Runs one of Inkling's commands by its id (without the plugin prefix). */
export async function runCommand(id: string) {
	await browser.executeObsidianCommand(`${PLUGIN_ID}:${id}`);
}

/**
 * Types `keys` as real key events into whatever has focus, one at a time (Obsidian's auto-pairing and Inkling's input
 * handlers react to each keystroke).
 */
export async function type(keys: string | string[]) {
	for (const key of typeof keys === "string" ? [...keys] : keys)
		await browser.keys(key);
	await settle();
}

/** Waits for a couple of animation frames, so CodeMirror and the gutter have drawn the last change. */
export async function settle(ms = 150) {
	await browser.execute(() =>
		new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
	);
	await browser.pause(ms);
}

/**
 * Wraps console.error/console.warn and window error events in the page so a spec can read them back. Install it before
 * the note opens, so errors thrown while decorations are built are captured (CodeMirror reports exceptions raised in
 * view plugins and decorations through console.error).
 */
export async function captureConsole() {
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

/** Console errors and warnings since captureConsole, plus the driver's browser log (which drains on each read). */
export async function consoleErrors(): Promise<string[]> {
	const captured = await browser.execute(() => (window as unknown as { __e2eLog?: string[] }).__e2eLog ?? []);
	const driver = (await browser.getLogs("browser") as { level: string; message: string }[])
		.filter(l => l.level === "SEVERE")
		.map(l => `driver: ${l.message}`);
	return [...captured, ...driver];
}

/**
 * Alpha (0–255) of a CSS colour, resolved by the page's own canvas. getCSSProperty only normalises rgb()/rgba(); newer
 * Obsidian themes compute to `oklch(… / 0.3)`, which it returns as is. -1 for a value the page can't parse as a colour,
 * so a parse failure never passes as painted.
 */
export async function colorAlpha(value: string | undefined): Promise<number> {
	return browser.execute((color: string) => {
		if (!CSS.supports("color", color)) return -1;
		const ctx = document.createElement("canvas").getContext("2d");
		if (!ctx) return -1;
		ctx.fillStyle = color;
		ctx.fillRect(0, 0, 1, 1);
		return ctx.getImageData(0, 0, 1, 1).data[3];
	}, value ?? "");
}

/** The alpha of an element's computed background colour (see colorAlpha). */
export async function backgroundAlpha(element: ReturnType<typeof browser.$> | WebdriverIO.Element): Promise<number> {
	const resolved: WebdriverIO.Element = await element;
	return colorAlpha((await resolved.getCSSProperty("background-color")).value);
}

/** Text of the notices on screen. */
export async function notices(): Promise<string[]> {
	return browser.execute(() => [...document.querySelectorAll(".notice")].map(n => n.textContent ?? ""));
}

/** Dismisses every notice on screen (a notice hides when clicked). */
export async function dismissNotices() {
	await browser.execute(() => document.querySelectorAll<HTMLElement>(".notice").forEach(n => n.click()));
	await browser.waitUntil(async () => (await notices()).length === 0, { timeoutMsg: "notices did not close" });
}

/** The Obsidian version the app runs (not the installer's). */
export async function obsidianVersion(): Promise<string> {
	return browser.executeObsidian(({ obsidian }) => obsidian.apiVersion);
}

/** Whether `version` is at least `min` (dotted numbers). */
export function atLeast(version: string, min: string): boolean {
	const a = version.split(".").map(Number), b = min.split(".").map(Number);
	for (let i = 0; i < Math.max(a.length, b.length); i++)
		if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
	return true;
}

/**
 * Resizes the Obsidian window (outer size, capped at the screen) and returns its inner width. Electron doesn't implement
 * WebDriver's window commands (Browser.getWindowForTarget), so this goes through Electron's own API.
 */
export async function resizeWindow(width: number, height: number): Promise<number> {
	await browser.execute(
		(width: number, height: number) => {
			type Win = { isMaximized(): boolean; unmaximize(): void; setSize(w: number, h: number): void };
			const electron = (window as unknown as { require(id: "electron"): { remote: { getCurrentWindow(): Win } } })
				.require("electron");
			const win = electron.remote.getCurrentWindow();
			if (win.isMaximized()) win.unmaximize();
			win.setSize(width, height);
		},
		width,
		height,
	);
	await browser.pause(500);
	const outer = await browser.execute(() => window.outerWidth);
	// EXPL: A window manager that ignores the request (a tiling one, as in CI before windows were set to float) would
	//       otherwise make a size-dependent spec fail with a misleading assertion. A window capped by the screen is
	//       smaller than asked, which is fine; one that stayed wider than asked is not.
	if (outer > width + 2)
		throw new Error(`resizeWindow: asked for ${width}px wide, the window stayed ${outer}px (window manager ignored it?)`);
	return browser.execute(() => window.innerWidth);
}

/** The first element matching `selector` whose text is `text`, or undefined. */
export async function elementWithText(selector: string, text: string): Promise<WebdriverIO.Element | undefined> {
	for (const element of await browser.$$(selector).getElements())
		if ((await element.getText()) === text) return element;
	return undefined;
}

/** Toggles Suggest mode in the active note and waits until the note's header shows it. */
export async function toggleSuggestMode(on = true) {
	await runCommand("suggest-mode");
	await browser.$(`${ACTIVE_LEAF} .view-header [aria-label^="Current mode: ${on ? "suggesting" : "editing"}"]`)
		.waitForExist({ timeoutMsg: `the note did not switch to ${on ? "Suggest" : "Editing"} mode` });
}
