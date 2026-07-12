// NOTE: Import path is specific, as we do not want to pull in obsidian/codemirror utilities into the worker bundle
import { getRangesInText } from "./editor/base/edit-util/range-parser";
import type { CriticMarkupRange } from "./editor/base/ranges";
import type { PluginSettings } from "./types";

export async function indexWorker(files: string[], settings: PluginSettings): Promise<CriticMarkupRange[][]> {
	return await Promise.all(files.map(async (file: string) => {
		return getRangesInText(file, settings);
	}));
}
