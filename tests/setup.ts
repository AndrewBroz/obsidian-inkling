import { App } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { providePluginSettingsExtension } from "../src/editor/uix/extensions";

// @ts-ignore (Doesn't like me assigning partial app to App)
global.app = <Partial<App>> {
	workspace: {
		activeEditor: null,
	},
};

// Obsidian defines `activeWindow` as a global alias for the currently focused
// window (defaults to `window`). Editor code (e.g. addCommentToView) relies on
// it for scheduling; jsdom doesn't provide it, so mirror Obsidian's default.
(global as any).activeWindow = window;

// `pluginSettingsField` (used by rangeParser) is only populated once the real
// plugin calls `providePluginSettingsExtension(plugin)` from its onload().
// Outside the running app nothing does that, so populate it here with the
// default settings the same way the plugin would, using default settings.
// @ts-ignore (Doesn't like me assigning a partial plugin)
providePluginSettingsExtension(<any> { settings: DEFAULT_SETTINGS });
