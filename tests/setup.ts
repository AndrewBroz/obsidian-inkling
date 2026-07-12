import { App } from "obsidian";

import { providePluginSettingsExtension } from "../src/editor/uix/extensions";
import { DEFAULT_SETTINGS } from "../src/constants";

// @ts-ignore (Doesn't like me assigning partial app to App)
global.app = <Partial<App>> {
	workspace: {
		activeEditor: null,
	},
};

// `pluginSettingsField` (used by rangeParser) is only populated once the real
// plugin calls `providePluginSettingsExtension(plugin)` from its onload().
// Outside the running app nothing does that, so populate it here with the
// default settings the same way the plugin would, using default settings.
// @ts-ignore (Doesn't like me assigning a partial plugin)
providePluginSettingsExtension(<any> { settings: DEFAULT_SETTINGS });
