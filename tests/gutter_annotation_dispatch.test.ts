import { EditorView } from "@codemirror/view";

import { editorInfoField } from "obsidian";

import { rangeParser, resolve_thread, SuggestionType } from "../src/editor/base";
import type { CriticMarkupRange } from "../src/editor/base/ranges";
import { AnnotationMarker } from "../src/editor/renderers/gutters/annotations-gutter/marker";
import { createRangeState } from "./helpers";

// EXPL: The annotation gutter's card DOM is built with Obsidian's DOM helpers (createDiv/createEl
//       on elements, global createDiv/createSpan, toggleClass/addClass/empty), which Obsidian
//       injects into the real runtime. jsdom lacks them, so provide minimal equivalents here —
//       per-file, jest sandboxes prototype patches per test file.
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

// EXPL: `add_metadata: false` keeps the written markup deterministic (no author/timestamp blob).
function setup(doc: string) {
	const state = createRangeState(doc, { add_metadata: false }, [editorInfoField]);
	const view = new EditorView({ state });
	const ranges = view.state.field(rangeParser).ranges.ranges;
	return { view, ranges };
}

/**
 * Builds a card the way `createMarkers` does (an anchored highlight's anchor never renders as a
 * card of its own) and returns the marker plus its first AnnotationNode. The node's blur/submit
 * path (`renderPreview`) is exercised directly, the same way the container's blur listener and
 * the embedded editor's onSubmit/onBlur closures invoke it.
 */
function mountThread(view: EditorView, base: CriticMarkupRange) {
	let thread = base.full_thread;
	if (thread[0] === base && base.type === SuggestionType.HIGHLIGHT && base.replies.length)
		thread = thread.slice(1);
	const marker = new AnnotationMarker(base, thread, view);
	marker.toDOM();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const node = (marker.component as any)._children[0];
	return { marker, node };
}

describe("annotation gutter blur-path dispatches are synchronous", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	test("blur-save dispatches synchronously; a following resolve never meets stale deferred offsets", () => {
		const { view, ranges } = setup("x{>>old<<}y");
		const { node } = mountThread(view, ranges[0]);

		// EXPL: The gesture from the Critical repro: type in the card's editor, then click its
		//       own Resolve button. mousedown blurs the editor (this call) BEFORE click fires.
		node.currentMode = "source";
		node.new_text = "edited comment";
		node.renderPreview();

		// EXPL: The write must already be in the document when the blur handler returns —
		//       under the old deferred dispatch this assertion fails (doc still has "old").
		expect(view.state.doc.toString()).toBe("x{>>edited comment<<}y");

		// EXPL: The click then dispatches resolve_thread synchronously against the CURRENT state.
		const fresh = view.state.field(rangeParser).ranges.ranges[0];
		view.dispatch({ changes: resolve_thread(fresh) });
		expect(view.state.doc.toString()).toBe(`x{>>{"done":true}@@edited comment<<}y`);

		// EXPL: Nothing deferred may fire afterwards — the old setTimeout applied pre-resolve
		//       offsets to the post-resolve document, splicing through the metadata blob.
		jest.advanceTimersByTime(1000);
		expect(view.state.doc.toString()).toBe(`x{>>{"done":true}@@edited comment<<}y`);
	});

	test("re-entered write path (FIXME scenario: mod+enter on a new comment) writes exactly once", () => {
		const { view, ranges } = setup("x{>><<}y");
		const { node } = mountThread(view, ranges[0]);

		node.currentMode = "source";
		node.new_text = "first";
		node.renderPreview();
		expect(view.state.doc.toString()).toBe("x{>>first<<}y");

		// EXPL: The write dispatch rebuilds the gutter; editor teardown can re-enter via a native
		//       blur with the same content. `text` was set to `new_text` BEFORE the dispatch, so
		//       the re-entrant call must take the equal-text render branch — no second insert.
		node.new_text = "first";
		node.renderPreview();
		expect(view.state.doc.toString()).toBe("x{>>first<<}y");

		jest.advanceTimersByTime(1000);
		expect(view.state.doc.toString()).toBe("x{>>first<<}y");
	});

	test("empty-comment cancel dispatches synchronously and is latched against re-entry", () => {
		const { view, ranges } = setup("x{>><<}y");
		const { node } = mountThread(view, ranges[0]);

		node.currentMode = "source";
		node.new_text = "";
		node.renderPreview();

		// EXPL: Cancel applied synchronously, while range.from/to are still valid.
		expect(view.state.doc.toString()).toBe("xy");

		// EXPL: A straggler/reentrant blur with the same (now-stale) range must be a no-op —
		//       the `cancelling` latch was set BEFORE the dispatch.
		node.new_text = "";
		node.renderPreview();
		expect(view.state.doc.toString()).toBe("xy");

		jest.advanceTimersByTime(1000);
		expect(view.state.doc.toString()).toBe("xy");
	});

	test("cancelling the only empty reply of an anchored thread unwraps the anchor synchronously", () => {
		const { view, ranges } = setup("x{==sel==}{>><<}y");
		const highlight = ranges[0];
		const { node } = mountThread(view, highlight);

		// EXPL: The card holds only the reply (the anchor never renders as a card).
		expect(node.range).toBe(highlight.replies[0]);

		node.currentMode = "source";
		node.new_text = "";
		node.renderPreview();
		expect(view.state.doc.toString()).toBe("xsely");

		jest.advanceTimersByTime(1000);
		expect(view.state.doc.toString()).toBe("xsely");
	});
});

describe("card action buttons are gated to comment/anchored threads", () => {
	test("comment and anchored-highlight cards render Resolve/Delete actions", () => {
		const { view, ranges } = setup("x{>>hi<<}y{==sel==}{>>reply<<}z");
		const comment_card = mountThread(view, ranges[0]).marker;
		const anchored_card = mountThread(view, ranges[1]).marker;

		expect(comment_card.annotation_thread.querySelector(".cmtr-anno-gutter-thread-actions")).not.toBeNull();
		expect(anchored_card.annotation_thread.querySelector("[aria-label='Resolve thread']")).not.toBeNull();
		expect(anchored_card.annotation_thread.querySelector("[aria-label='Delete thread']")).not.toBeNull();
	});

	test("suggestion cards render no Resolve/Delete actions (standalone or with replies)", () => {
		const { view, ranges } = setup("x{++add++}y{--del--}{>>note<<}z");
		const standalone_addition = mountThread(view, ranges[0]).marker;
		const deletion_with_reply = mountThread(view, ranges[1]).marker;

		expect(standalone_addition.annotation_thread.querySelector(".cmtr-anno-gutter-thread-actions")).toBeNull();
		expect(deletion_with_reply.annotation_thread.querySelector(".cmtr-anno-gutter-thread-actions")).toBeNull();
	});
});
