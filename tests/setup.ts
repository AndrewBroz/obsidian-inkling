import { App } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { providePluginSettingsExtension } from "../src/editor/uix/extensions";

// @ts-ignore (Doesn't like me assigning partial app to App)
global.app = <Partial<App>> {
	workspace: {
		activeEditor: null,
	},
};

// Obsidian augments the global `Math` with `clamp(value, min, max)`. Edit-logic code
// (mark.ts's substitution CASE branches) calls it; jsdom's Math has no such method, so
// provide Obsidian's definition.
if (typeof (Math as any).clamp !== "function")
	(Math as any).clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

// Obsidian defines `activeWindow` as a global alias for the currently focused
// window (defaults to `window`). Editor code (e.g. addCommentToView) relies on
// it for scheduling; jsdom doesn't provide it, so mirror Obsidian's default.
(global as any).activeWindow = window;

// Obsidian augments the DOM with global element-creation helpers (createSpan,
// createDiv). Widget rendering code (renderCommentWidget) uses them at
// construction time; jsdom doesn't provide them, so shim the minimal shape
// (element + optional class) that the code under test relies on.
function createElHelper(tag: string) {
	return (o?: { cls?: string }) => {
		const el = document.createElement(tag);
		if (o?.cls) el.className = o.cls;
		return el;
	};
}
(global as any).createSpan = createElHelper("span");
(global as any).createDiv = createElHelper("div");

// `pluginSettingsField` (used by rangeParser) is only populated once the real
// plugin calls `providePluginSettingsExtension(plugin)` from its onload().
// Outside the running app nothing does that, so populate it here with the
// default settings the same way the plugin would, using default settings.
// @ts-ignore (Doesn't like me assigning a partial plugin)
providePluginSettingsExtension(<any> { settings: DEFAULT_SETTINGS });
