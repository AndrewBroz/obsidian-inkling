// Talks to the sandbox Obsidian over the Chrome DevTools Protocol (Node 22+, global WebSocket).
//
//   node cdp.mjs eval '<js>'            evaluate in the main window (awaits promises), print the JSON result
//   node cdp.mjs shot out.png           screenshot the main window
//   node cdp.mjs open 'Note.md'         open a vault file in the active leaf and wait for it to render
//   node cdp.mjs mode live|source|reading   switch the active note's view and wait for it to render
//   node cdp.mjs logs [ms] ['<js>']     listen ms (default 3000) for console messages and uncaught errors; <js>, if
//                                       given, is evaluated (and awaited) inside that window so its errors are caught
//   node cdp.mjs size <width> <height>  resize the main window (outer size, px; capped at the screen) and print its inner size
//
// `app` (Obsidian's App) and `require` are globals in the window. Port: OBSIDIAN_SANDBOX_PORT (default 9333).
const PORT = process.env.OBSIDIAN_SANDBOX_PORT ?? "9333";
const [, , cmd, ...args] = process.argv;

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
// EXPL: Settings and other popouts are separate pages; the main window is the one served from app://.
const page = targets.find(t => t.type === "page" && t.url.startsWith("app://"));
if (!page) throw new Error("no Obsidian main window on port " + PORT);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let next = 0;
const pending = new Map();
const events = [];
ws.onmessage = e => {
	const msg = JSON.parse(e.data);
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)(msg);
		pending.delete(msg.id);
	} else if (msg.method) events.push(msg);
};
const send = (method, params = {}) =>
	new Promise(resolve => {
		const id = ++next;
		pending.set(id, resolve);
		ws.send(JSON.stringify({ id, method, params }));
	});
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});

async function evaluate(expression) {
	const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	const r = res.result;
	if (r?.exceptionDetails) return { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
	return r?.result?.value;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// EXPL: Obsidian reports live preview as mode "source" with source:false; name the three views plainly.
const VIEW = `(() => { const v = app.workspace.activeLeaf?.view, s = v?.getState?.() ?? {};
	return s.mode === "preview" ? "reading" : s.source ? "source" : "live-preview"; })()`;
const SETTLE = `for (let i = 0; i < 30 && !document.querySelector('.workspace-leaf.mod-active .cm-line, .workspace-leaf.mod-active .markdown-preview-section > *'); i++)
				await new Promise(r => setTimeout(r, 100));
			await new Promise(r => setTimeout(r, 1000));`;

if (cmd === "eval") {
	console.log(JSON.stringify(await evaluate(args[0]), null, 2));
} else if (cmd === "shot") {
	const res = await send("Page.captureScreenshot", { format: "png" });
	(await import("node:fs")).writeFileSync(args[0], Buffer.from(res.result.data, "base64"));
	console.log("saved " + args[0]);
} else if (cmd === "open") {
	console.log(JSON.stringify(
		await evaluate(`(async () => {
			const file = app.vault.getAbstractFileByPath(${JSON.stringify(args[0])});
			if (!file) return { error: "no such file: " + ${JSON.stringify(args[0])} };
			await app.workspace.getLeaf(false).openFile(file);
			// EXPL: The first render (plugins attaching gutters, decorations) can lag the open; wait for lines, then settle.
			${SETTLE}
			return { opened: file.path, view: ${VIEW} };
		})()`),
		null,
		2,
	));
} else if (cmd === "mode") {
	const state = { live: "{ mode: 'source', source: false }", source: "{ mode: 'source', source: true }", reading: "{ mode: 'preview' }" }[args[0]];
	if (!state) throw new Error("mode: live | source | reading");
	console.log(JSON.stringify(
		await evaluate(`(async () => {
			const v = app.workspace.activeLeaf.view;
			await v.setState({ ...v.getState(), ...${state} }, { history: false });
			${SETTLE}
			return { view: ${VIEW} };
		})()`),
		null,
		2,
	));
} else if (cmd === "logs") {
	await send("Runtime.enable");
	await sleep(200);
	events.length = 0; // drop the replay of old messages Runtime.enable sends
	if (args[1]) console.log("eval:", JSON.stringify(await evaluate(args[1])));
	await sleep(Number(args[0] ?? 3000));
	for (const e of events) {
		if (e.method === "Runtime.consoleAPICalled") {
			const text = e.params.args.map(a => a.value ?? a.description ?? a.type).join(" ");
			console.log(`[${e.params.type}] ${text}`);
		} else if (e.method === "Runtime.exceptionThrown") {
			const d = e.params.exceptionDetails;
			console.log(`[uncaught] ${d.exception?.description ?? d.text}`);
		}
	}
	if (!events.length) console.log("(no console output)");
} else if (cmd === "size") {
	const [width, height] = args.map(Number);
	if (!(width > 0 && height > 0)) throw new Error("size: <width> <height>");
	// EXPL: Window bounds belong to the browser, not the page, so the standard route is the browser endpoint:
	//       Browser.getWindowForTarget, then Browser.setWindowBounds. Electron (Obsidian 1.15 / Electron 43) does
	//       not implement those methods ("wasn't found"), so on that error fall back to Electron's own API for
	//       THIS page's window, which is the sandbox window and nothing else.
	const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
	const browser = new WebSocket(webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		browser.onopen = resolve;
		browser.onerror = reject;
	});
	let browser_next = 0;
	const call = (method, params = {}) =>
		new Promise(resolve => {
			const id = ++browser_next;
			browser.addEventListener("message", function listener(e) {
				const msg = JSON.parse(e.data);
				if (msg.id !== id) return;
				browser.removeEventListener("message", listener);
				resolve(msg);
			});
			browser.send(JSON.stringify({ id, method, params }));
		});
	const target = await call("Browser.getWindowForTarget", { targetId: page.id });
	let via = "cdp";
	if (target.error) {
		browser.close();
		if (!/wasn't found/.test(target.error.message)) throw new Error("Browser.getWindowForTarget: " + target.error.message);
		via = "electron";
		const res = await evaluate(`(() => {
			const w = require("electron").remote.getCurrentWindow();
			if (w.isFullScreen()) w.setFullScreen(false);
			if (w.isMaximized()) w.unmaximize();
			w.setSize(${width}, ${height});
		})()`);
		if (res?.error) throw new Error(res.error);
	} else {
		const { windowId } = target.result;
		// EXPL: A maximised or fullscreen window ignores width/height; restore it to normal first.
		await call("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
		const set = await call("Browser.setWindowBounds", { windowId, bounds: { width, height } });
		browser.close();
		if (set.error) throw new Error("Browser.setWindowBounds: " + set.error.message);
	}
	await sleep(500);
	console.log(JSON.stringify({ via, inner: await evaluate("({ width: innerWidth, height: innerHeight })") }, null, 2));
} else {
	console.error("usage: node cdp.mjs eval '<js>' | shot out.png | open 'Note.md' | mode live|source|reading | logs [ms] ['<js>'] | size <width> <height>");
	process.exitCode = 1;
}
ws.close();
