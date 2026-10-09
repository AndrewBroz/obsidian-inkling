import { EditorView } from "@codemirror/view";

import { App, editorInfoField } from "obsidian";

import { rangeParser } from "../src/editor/base";
import type { CriticMarkupRange } from "../src/editor/base/ranges";
import { AnnotationMarker } from "../src/editor/renderers/gutters/annotations-gutter/marker";
import { PreviewEditor } from "../src/ui/preview-editor";
import { EmbeddableMarkdownEditor as MockEditor } from "./__mocks__/embeddable-editor";
import { createRangeState } from "./helpers";

// EXPL: Regression tests for "clicking into an existing comment's editor exits edit mode; only the
//       arrow keys work". Two independent surfaces edit an existing comment, and both had a mouse-only
//       path out of edit mode:
//        - Annotation gutter card (AnnotationNode): a click inside the editor bubbled up to the
//          thread's click handler, which opened the thread's reply box. That box's editor grabs focus
//          on load, so the comment editor blurred, and blur saves-and-closes the comment editor.
//        - Comment icon tooltip (CommentIconWidget -> PreviewEditor): entering edit mode via
//          setMode("edit") (the "Edit comment" context-menu item) left preview mode's one-shot
//          click-to-edit listener armed, so the first click inside the editor toggled it back to
//          preview.
//       Keyboard input fires no click events, which is why arrow-key navigation kept working.
//
// EXPL: The embedded editor is stubbed under jest (tests/__mocks__/embeddable-editor.ts), so there is
//       no real CodeMirror DOM or focus handling. The click is dispatched on a stand-in element inside
//       the editor's container (bubbling works the same as on CodeMirror's contentDOM), and focus
//       theft is modelled explicitly where noted.

type ElOptions = { cls?: string | string[]; attr?: Record<string, string>; text?: string } | string | undefined;

function applyElOptions(el: HTMLElement, o: ElOptions) {
	if (typeof o === "string") {
		el.classList.add(o);
		return;
	}
	if (!o) return;
	if (o.cls) el.classList.add(...([] as string[]).concat(o.cls));
	if (o.attr) {
		for (const [key, value] of Object.entries(o.attr))
			el.setAttribute(key, value);
	}
	if (o.text) el.textContent = o.text;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const proto = HTMLElement.prototype as any;
proto.createEl = function(tag: string, o?: ElOptions) {
	const el = document.createElement(tag);
	applyElOptions(el, o);
	this.appendChild(el);
	return el;
};
proto.createDiv = function(o?: ElOptions) {
	return this.createEl("div", o);
};
proto.createSpan = function(o?: ElOptions) {
	return this.createEl("span", o);
};
proto.toggleClass = function(cls: string | string[], value: boolean) {
	for (const c of ([] as string[]).concat(cls))
		this.classList.toggle(c, value);
};
proto.addClass = function(...cls: string[]) {
	this.classList.add(...cls);
};
proto.empty = function() {
	while (this.firstChild)
		this.removeChild(this.firstChild);
};
(globalThis as any).createDiv = (o?: ElOptions) => {
	const el = document.createElement("div");
	applyElOptions(el, o);
	return el;
};
(globalThis as any).createSpan = (o?: ElOptions) => {
	const el = document.createElement("span");
	applyElOptions(el, o);
	return el;
};
// EXPL: PreviewEditor defers its click-to-edit switch with Electron's setImmediate, which jsdom lacks.
if (typeof (globalThis as any).setImmediate !== "function")
	(globalThis as any).setImmediate = (fn: () => void) => setTimeout(fn, 0);

function stubPluginManager(author = "me") {
	return { plugins: { inkling: { editorExtensions: [], settings: { author } } } };
}

function setup(doc: string) {
	const state = createRangeState(doc, { add_metadata: false }, [editorInfoField]);
	const view = new EditorView({ state });
	const { app } = view.state.field(editorInfoField);
	(app as any).plugins = stubPluginManager();
	const ranges = view.state.field(rangeParser).ranges.ranges;
	return { view, ranges };
}

function mountThread(view: EditorView, base: CriticMarkupRange) {
	const marker = new AnnotationMarker(base, base.full_thread, view);
	marker.toDOM();
	const node = (marker.component as any)._children[0];
	return { marker, node };
}

function click(target: Element) {
	target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
	target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
	target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("annotation gutter: clicking inside an existing comment's editor", () => {
	function startEditing(doc = "x{>>old comment<<}y") {
		const { view, ranges } = setup(doc);
		const { marker, node } = mountThread(view, ranges[0]);
		const before = MockEditor.instances.length;
		node.renderSource();
		expect(node.currentMode).toBe("source");
		const editor = MockEditor.instances[before];
		// EXPL: Stand-in for CodeMirror's contentDOM inside the editor container.
		const content = node.annotation_view.createDiv({ cls: "cm-content" });
		return { view, marker, node, editor, content };
	}

	// EXPL: In Obsidian the reply box's editor focuses itself on load, which blurs the comment editor.
	//       The stub has no focus model, so apply that consequence by hand whenever a reply box opened.
	function applyFocusTheft(marker: AnnotationMarker, editor: MockEditor) {
		if (marker.reply_box)
			editor.triggerBlur();
	}

	test("does not open the reply box (which would steal focus) and stays in edit mode", () => {
		const { view, marker, node, editor, content } = startEditing();

		click(content);
		applyFocusTheft(marker, editor);

		expect(marker.reply_box).toBeNull();
		expect(node.currentMode).toBe("source");
		expect(view.state.doc.toString()).toBe("x{>>old comment<<}y");
	});

	test("also holds when the edit was opened via the context menu / dblclick on the card", () => {
		const { view, ranges } = setup("x{>>old comment<<}y");
		const { marker, node } = mountThread(view, ranges[0]);
		const before = MockEditor.instances.length;
		node.annotation_container.dispatchEvent(new MouseEvent("dblclick"));
		expect(node.currentMode).toBe("source");
		const editor = MockEditor.instances[before];
		const content = node.annotation_view.createDiv({ cls: "cm-content" });

		click(content);
		applyFocusTheft(marker, editor);

		expect(node.currentMode).toBe("source");
	});

	test("clicking elsewhere on the card still opens the reply box", () => {
		const { marker } = startEditing();
		click(marker.annotation_thread);
		expect(marker.reply_box).not.toBeNull();
	});

	test("blur (click outside) still leaves edit mode", () => {
		const { node, editor } = startEditing();
		editor.triggerBlur();

		expect(node.currentMode).toBe("preview");
	});

	test("blur (click outside) with edited text still saves it", () => {
		// EXPL: The save dispatch rebuilds the gutter in Obsidian (a fresh card replaces this one),
		//       so only the document write is asserted here.
		const { view, editor } = startEditing();
		editor.set("new comment");
		editor.triggerBlur();

		expect(view.state.doc.toString()).toBe("x{>>new comment<<}y");
	});

	test("once back in preview, a click on the comment behaves as before (opens the reply box)", () => {
		const { marker, node, editor } = startEditing();
		editor.triggerBlur();
		expect(node.currentMode).toBe("preview");

		click(node.annotation_view);
		expect(marker.reply_box).not.toBeNull();
	});

	test("a refused edit (other author) never marks the card as editing", () => {
		const { view, ranges } = setup(`x{>>{"author":"someone else"}@@theirs<<}y`);
		const { node } = mountThread(view, ranges[0]);
		node.renderSource();

		expect(node.currentMode).toBe("preview");
		expect(node.annotation_container.classList.contains("cmtr-anno-gutter-annotation-editing")).toBe(false);
	});
});

describe("comment tooltip PreviewEditor: clicking inside the editor", () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	function makeEditor() {
		const click_container = document.createElement("div");
		const container = click_container.appendChild(document.createElement("div"));
		const onBlur = jest.fn();
		const editor = new PreviewEditor({} as App, container, { value: "old comment", click_container, onBlur });
		return { editor, container, click_container, onBlur };
	}

	function lastEditor() {
		return MockEditor.instances[MockEditor.instances.length - 1];
	}

	test("edit mode entered via setMode (\"Edit comment\") survives a click inside the editor", () => {
		const { editor, container } = makeEditor();
		editor.setMode("edit");
		expect(editor.getMode()).toBe("edit");

		click(container.appendChild(document.createElement("div")));
		jest.runAllTimers();

		expect(editor.getMode()).toBe("edit");
	});

	test("edit mode entered by clicking the preview survives further clicks inside the editor", () => {
		const { editor, container, click_container } = makeEditor();
		click(click_container);
		jest.runAllTimers();
		expect(editor.getMode()).toBe("edit");

		click(container.appendChild(document.createElement("div")));
		jest.runAllTimers();
		expect(editor.getMode()).toBe("edit");
	});

	test("blur still leaves edit mode, and a click re-enters it", () => {
		const { editor, click_container, onBlur } = makeEditor();
		editor.setMode("edit");

		lastEditor().triggerBlur();
		expect(onBlur).toHaveBeenCalledTimes(1);
		expect(editor.getMode()).toBe("preview");

		click(click_container);
		jest.runAllTimers();
		expect(editor.getMode()).toBe("edit");
	});

	test("Escape still leaves edit mode", () => {
		const { editor } = makeEditor();
		editor.setMode("edit");

		lastEditor().pressEscape();
		expect(editor.getMode()).toBe("preview");
	});
});
