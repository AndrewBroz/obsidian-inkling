import { EditorState } from "@codemirror/state";
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

		const stale_box = marker.reply_box;
		marker.toDOM();

		// EXPL: Without the fix, `reply_box` would still hold the box bound to the OLD (now
		// detached) annotation_thread, and showReplyBox()'s `if (this.reply_box) return;` guard
		// would permanently refuse to ever open a reply box on this card again. The box on the card
		// now must be a NEW one, parented to the NEW thread.
		expect(marker.reply_box).not.toBe(stale_box);
		expect(marker.annotation_thread.querySelectorAll(".cmtr-anno-gutter-reply")).toHaveLength(1);
	});

	// EXPL: The re-home is invisible to the user — GutterElement.setMarkers re-runs toDOM() on this
	//       instance whenever its GutterElement index shifts, i.e. whenever an annotation ABOVE it
	//       appears or disappears. That is precisely what the "blur the box with text in it, go fix a
	//       word in the note" flow invites. Before the fix, the rebuilt card got NO box at all: an
	//       open reply with text in it simply vanished, with no undo and no trace. (jsdom has no
	//       layout, so every line collapses into one block and the real re-home cannot be provoked
	//       end-to-end here — hence driving toDOM() directly, which is exactly what setMarkers does.)
	test("FIX regression: a re-home does not discard an in-progress reply", () => {
		const { view, ranges } = setup("x{>>hi<<}y");
		const marker = mountThread(view, ranges[0]);
		openReplyBox(marker);
		(marker.reply_box!.editor as unknown as MockEditor).set("half-written reply");

		marker.toDOM();
		marker.reply_box?.load();

		expect(marker.reply_box).not.toBeNull();
		expect(marker.reply_box!.options.value).toBe("half-written reply");
		expect(marker.reply_box!.text()).toBe("half-written reply");
	});

	// EXPL: A closed card must STAY closed through a re-home — reopening one the user never opened
	//       would steal focus out of the note.
	test("a re-home does not open a reply box on a card that had none", () => {
		const { view, ranges } = setup("x{>>hi<<}y");
		const marker = mountThread(view, ranges[0]);

		marker.toDOM();
		expect(marker.reply_box).toBeNull();
	});

	// EXPL: Escape / blur-while-empty is the user closing the box ON PURPOSE. That must discard the
	//       text, or the next click on the card would resurrect a reply they walked away from.
	test("dismissing the box discards its text", () => {
		const { view, ranges } = setup("x{>>hi<<}y");
		const marker = mountThread(view, ranges[0]);
		openReplyBox(marker);
		(marker.reply_box!.editor as unknown as MockEditor).set("abandoned");

		marker.dismissReplyBox();
		marker.toDOM();
		expect(marker.reply_box).toBeNull();

		marker.showReplyBox();
		expect(marker.reply_box!.options.value).toBe("");
	});

	// EXPL: `pill_eligible` refuses to offer a NEW comment in a read-only editor, but nothing stopped
	//       a click on an existing thread card from opening a writable reply — and commitReply
	//       dispatches programmatically, which CodeMirror's `readOnly` facet does NOT block.
	test("no reply box in a read-only editor", () => {
		const state = createRangeState("x{>>hi<<}y", { add_metadata: false }, [
			editorInfoField,
			EditorState.readOnly.of(true),
		]);
		const view = new EditorView({ state });
		(view.state.field(editorInfoField).app as any).plugins = stubPluginManager();
		const marker = mountThread(view, view.state.field(rangeParser).ranges.ranges[0]);

		marker.showReplyBox();
		expect(marker.reply_box).toBeNull();
		expect(marker.annotation_thread.querySelector(".cmtr-anno-gutter-reply")).toBeNull();
	});
});
