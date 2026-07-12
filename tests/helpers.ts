import { EditorState, type Extension } from "@codemirror/state";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { providePluginSettingsExtension } from "../src/editor/uix/extensions";
import type { PluginSettings } from "../src/types";

// EXPL: rangeParser's StateField requires the plugin-settings extension in the state,
//       and metadata parsing is off in DEFAULT_SETTINGS — tests opt in via overrides.
//       (Established in Phase 0+1; see docs/superpowers/plans/2026-07-11-phase-0-1-execution-notes.md)
export function createRangeState(
	doc: string,
	settings: Partial<PluginSettings> = {},
	extra: Extension[] = [],
): EditorState {
	const pluginSettingsField = providePluginSettingsExtension(
		<any> { settings: { ...DEFAULT_SETTINGS, ...settings } },
	);
	return EditorState.create({
		doc,
		extensions: [rangeParser, pluginSettingsField, ...extra],
	});
}
