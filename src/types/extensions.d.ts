import IntervalTree, { Node } from "@flatten-js/interval-tree";
import { App } from "obsidian";
import { PluginsPluginsRecord } from "obsidian-typings";
import CommentatorPlugin from "../main";

declare module "@flatten-js/interval-tree" {
	export default interface IntervalTree<T = unknown> {
		nil_node: Node<T>;

		recalc_max(node: Node<T>): void;

		tree_walk(node: Node<T>, callback: (node: Node<T>) => void): void;

		tree_search_interval(node: Node<T>, search_node: Node, resulting_nodes: Node[]): void;

		tree_search_nearest_forward(node: Node<T>, search_node: Node): Node<T> | null;
	}

	export interface Node<T = unknown> {
		max: Interval;

		not_intersect_left_subtree(search_node: Node): boolean;

		not_intersect_right_subtree(search_node: Node): boolean;
	}
}

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
		commentator: CommentatorPlugin;
	}
}
