import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { cmenuGlobalCommands } from "../src/editor/uix/context-menu";
import type CommentatorPlugin from "../src/main";
import type { MetadataSyntax } from "../src/types";
import { createRangeState } from "./helpers";

// EXPL: A stand-in for Obsidian's Menu/MenuItem: every setter chains, `setSubmenu` returns a nested menu, and
//       items are kept by title so a test can click one.
type FakeItem = { title?: string; click?: () => void; submenu?: FakeMenu };
type FakeMenu = { items: FakeItem[]; addItem: (build: (item: unknown) => void) => FakeMenu };

function fakeMenu(): FakeMenu {
	const menu: FakeMenu = {
		items: [],
		addItem(build) {
			const item: FakeItem = {};
			const api = {
				setTitle: (title: string) => (item.title = title, api),
				setIcon: () => api,
				setSection: () => api,
				setChecked: () => api,
				onClick: (click: () => void) => (item.click = click, api),
				setSubmenu: () => (item.submenu = fakeMenu()),
			};
			build(api);
			menu.items.push(item);
			return menu;
		},
	};
	return menu;
}

/** Open the editor menu with the cursor at `cursor` and click "Set metadata" > `title`. */
function clickSetMetadata(doc: string, cursor: number, title: string, syntax: MetadataSyntax): string {
	const state = createRangeState(doc, { metadata_syntax: syntax, author: "Z" });
	const view = new EditorView({ state });
	view.dispatch({ selection: EditorSelection.cursor(cursor) });
	let handler: ((menu: FakeMenu, editor: { cm: EditorView }) => void) | undefined;
	const plugin = {
		settings: { author: "Z" },
		app: { workspace: { on: (_name: string, callback: typeof handler) => (handler = callback, {}) } },
	} as unknown as CommentatorPlugin;
	cmenuGlobalCommands(plugin);

	const menu = fakeMenu();
	handler!(menu, { cm: view });
	const submenu = menu.items.find(item => item.title === "Set metadata")!.submenu!;
	submenu.items.find(item => item.title === title)!.click!();
	return view.state.doc.toString();
}

describe("context menu Set author", () => {
	test("a range with no metadata follows the attributes setting", () => {
		expect(clickSetMetadata("x{++a++}y", 4, "Set author", "attributes")).toBe("x{++a++}{author=Z}y");
	});

	test("a range with no metadata follows the legacy setting", () => {
		expect(clickSetMetadata("x{++a++}y", 4, "Set author", "legacy")).toBe(`x{++{"author":"Z"}@@a++}y`);
	});

	test("an attributes range stays attribute form under the legacy setting", () => {
		expect(clickSetMetadata("x{++a++}{time=1}y", 4, "Set author", "legacy")).toBe("x{++a++}{time=1 author=Z}y");
	});
});
