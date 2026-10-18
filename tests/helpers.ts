import { EditorState, type Extension } from "@codemirror/state";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { convert_metadata } from "../src/editor/base/edit-logic/convert-metadata";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import { providePluginSettingsExtension } from "../src/editor/uix/extensions";
import type { MetadataSyntax, PluginSettings } from "../src/types";

// EXPL: rangeParser's StateField requires the plugin-settings extension in the state.
//       Metadata parsing is on by default in DEFAULT_SETTINGS (Phase 3a); tests that need a
//       different configuration opt out via overrides.
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

/** The same document with every legacy range rewritten in `syntax`, so a legacy fixture can run over both forms. */
export function withSyntax(doc: string, syntax: MetadataSyntax): string {
	if (syntax === "legacy") return doc;
	const { changes } = convert_metadata(getRangesInText(doc, { ...DEFAULT_SETTINGS, enable_metadata: true }), syntax);
	return [...changes].sort((a, b) => b.from - a.from)
		.reduce((out, c) => out.slice(0, c.from) + c.insert + out.slice(c.to), doc);
}
