import { EditorView } from "@codemirror/view";

import { App, editorInfoField } from "obsidian";

import { rangeParser } from "../src/editor/base";
import type { CriticMarkupRange } from "../src/editor/base/ranges";
import { AnnotationMarker } from "../src/editor/renderers/gutters/annotations-gutter/marker";
import { ReplyBox } from "../src/editor/renderers/gutters/annotations-gutter/reply-box";
import { EmbeddableMarkdownEditor as MockEditor } from "./__mocks__/embeddable-editor";
import { createRangeState } from "./helpers";

// EXPL: The annotation gutter's card DOM is built with Obsidian's DOM helpers (createDiv/createEl
//       on elements, global createDiv/createSpan, toggleClass/addClass/empty), which Obsidian
//       injects into the real runtime. jsdom lacks them, so provide minimal equivalents here —
//       per-file, jest sandboxes prototype patches per test file. (Copied from
//       gutter_annotation_dispatch.test.ts, which needs the identical shim for the same reason.)
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

// EXPL: reply-box.ts and marker.ts's renderSource() both eagerly read
//       `app.plugins.plugins["inkling"].editorExtensions` while building the EmbeddableMarkdownEditor
//       options object. Real Obsidian always has this; jsdom's App stand-in (__mocks__/obsidian.ts)
//       does not, so tests that actually construct an editor (rather than just poking at the
//       marker's own fields) need it stubbed in.
// EXPL: This is the value of `app.plugins` (Obsidian's plugin manager: `.plugins` is its
//       dict of loaded plugin instances by id).
function stubPluginManager() {
	return { plugins: { inkling: { editorExtensions: [] } } };
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
	return marker;
}

// EXPL: The real obsidian Component.addChild auto-loads a child when the parent component is
//       already loaded — that's what actually mounts the reply box's editor in production
//       (marker.component.load() already ran, at the end of toDOM(), by the time showReplyBox()
//       calls addChild). The jest Component stub (__mocks__/obsidian.ts) does not replicate that
//       cascade (its addChild is a plain push, and load() never flips `_loaded`), so tests drive
//       the load explicitly — standing in for what Obsidian does for us at runtime.
function openReplyBox(marker: AnnotationMarker) {
	marker.showReplyBox();
	marker.reply_box?.load();
}

describe("ReplyBox interaction contract", () => {
	function makeBox() {
		const container = document.createElement("div");
		const onCommit = jest.fn((_text: string) => true);
		const onDismiss = jest.fn();
		const app = { plugins: stubPluginManager() } as unknown as App;
		const box = new ReplyBox(app, container, {
			placeholder: "Reply…",
			onCommit,
			onDismiss,
		});
		box.load();
		const editor = box.editor as unknown as MockEditor;
		return { box, editor, onCommit, onDismiss };
	}

	test("Enter with text commits with that text", () => {
		const { editor, onCommit } = makeBox();
		editor.set("hello");

		expect(editor.pressEnter(false)).toBe(true);
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(onCommit).toHaveBeenCalledWith("hello");
	});

	test("Shift+Enter does not commit, and reports unhandled so CodeMirror inserts a newline", () => {
		const { editor, onCommit } = makeBox();
		editor.set("hello");

		expect(editor.pressEnter(true)).toBe(false);
		expect(onCommit).not.toHaveBeenCalled();
	});

	test("Escape dismisses without committing", () => {
		const { editor, onCommit, onDismiss } = makeBox();
		editor.set("draft");

		editor.pressEscape();
		expect(onDismiss).toHaveBeenCalledTimes(1);
		expect(onCommit).not.toHaveBeenCalled();
	});

	test("blur while empty dismisses", () => {
		const { editor, onDismiss } = makeBox();
		editor.set("   \n  ");

		editor.triggerBlur();
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	test("blur with text neither commits nor dismisses (never silently write, never lose the draft)", () => {
		const { editor, onCommit, onDismiss } = makeBox();
		editor.set("half-written reply");

		editor.triggerBlur();
		expect(onCommit).not.toHaveBeenCalled();
		expect(onDismiss).not.toHaveBeenCalled();
	});
});

describe("AnnotationMarker reply box lifecycle", () => {
	test("hideReplyBox is idempotent", () => {
		const { view, ranges } = setup("x{>>hi<<}y");
		const marker = mountThread(view, ranges[0]);
		openReplyBox(marker);
		expect(marker.reply_box).not.toBeNull();

		marker.hideReplyBox();
		expect(marker.reply_box).toBeNull();

		expect(() => marker.hideReplyBox()).not.toThrow();
		expect(marker.reply_box).toBeNull();
	});

	test("showReplyBox twice does not stack two reply boxes", () => {
		const { view, ranges } = setup("x{>>hi<<}y");
		const marker = mountThread(view, ranges[0]);
		openReplyBox(marker);

		marker.showReplyBox();
		marker.showReplyBox();

		expect(marker.annotation_thread.querySelectorAll(".cmtr-anno-gutter-reply")).toHaveLength(1);
	});

	test("FIX regression: re-running toDOM() on the same marker instance does not orphan the reply box", () => {
		// EXPL: This is exactly the GutterElement.setMarkers scenario (base.ts:168-190): a marker
		//       with preventUnload set gets re-homed into a new GutterElement without destroy()
		//       being called, and toDOM() runs again on the SAME AnnotationMarker instance.
		const { view, ranges } = setup("x{>>hi<<}y");
		const marker = mountThread(view, ranges[0]);
		openReplyBox(marker);
		expect(marker.reply_box).not.toBeNull();

		marker.toDOM();

		// EXPL: Without the fix, `reply_box` would still hold the box bound to the OLD (now
		// detached) annotation_thread, and showReplyBox()'s `if (this.reply_box) return;` guard
		// would permanently refuse to ever open a reply box on this card again.
		expect(marker.reply_box).toBeNull();

		marker.showReplyBox();
		expect(marker.reply_box).not.toBeNull();
		expect(marker.annotation_thread.querySelector(".cmtr-anno-gutter-reply")).not.toBeNull();
	});
});
