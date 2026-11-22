import { App } from "obsidian";
import CommentatorPlugin from "../main";

declare global {
	interface Window {
		COMMENTATOR_DEBUG: Record<string, unknown> & { app: App };
	}
}

declare module "obsidian" {
	interface MarkdownEditView {
		annotationGutterFolded: boolean;
		annotationGutterWidth: number;
	}
}

declare module "obsidian-typings" {
	interface PluginsPluginsRecord {
		"inkling-markup": CommentatorPlugin;
	}
}
