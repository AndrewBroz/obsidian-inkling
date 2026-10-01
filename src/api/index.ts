import type { PluginSettings } from "../types";
import { toOriginalText } from "./original-text";

/**
 * Stable API for other plugins: `app.plugins.getPlugin("inkling")?.api`.
 * EXPL: `version` only changes on a breaking change; consumers should check `version >= 1`.
 */
export interface InklingApi {
	readonly version: 1;
	toOriginalText(markdown: string): string;
}

export function createApi(get_settings: () => PluginSettings): InklingApi {
	return Object.freeze({
		version: 1 as const,
		toOriginalText: (markdown: string) => toOriginalText(markdown, get_settings()),
	});
}
