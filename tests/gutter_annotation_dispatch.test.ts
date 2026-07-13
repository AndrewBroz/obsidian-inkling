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

	// EXPL: The card's comment editor is a `create_range` sink exactly like the reply box, and it was
	//       the unguarded one: CriticMarkup has no escapes, so saving `see a<<}b` into an existing
	//       comment wrote `{>>see a<<}b<<}` — the inner `<<}` closes the comment early, `b<<}` is
	//       orphaned as plain text and a bare `<<}` is left DANGLING in the note. Refuse the write,
	//       keep the editor open (still in source mode, text intact in the DOM) so the user can fix
	//       it, and leave the note untouched.
	test("a comment body containing a closing delimiter is refused, not written", () => {
		const { view, ranges } = setup("x{>>old<<}y");
		const { node } = mountThread(view, ranges[0]);

		node.currentMode = "source";
		node.new_text = "see a<<}b";
		node.renderPreview();

		expect(view.state.doc.toString()).toBe("x{>>old<<}y");
		// EXPL: the editor is still open — renderPreview did not switch the card back to preview
		expect(node.currentMode).toBe("source");

		jest.advanceTimersByTime(1000);
		expect(view.state.doc.toString()).toBe("x{>>old<<}y");

		// EXPL: ...and the same editor, once fixed, still saves normally.
		node.new_text = "see a b";
		node.renderPreview();
		expect(view.state.doc.toString()).toBe("x{>>see a b<<}y");
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

describe("card action buttons are gated by thread type", () => {
	test("comment and anchored-highlight cards render Resolve, not Accept/Reject", () => {
		const { view, ranges } = setup("x{>>hi<<}y{==sel==}{>>reply<<}z");
		const comment_card = mountThread(view, ranges[0]).marker;
		const anchored_card = mountThread(view, ranges[1]).marker;

		expect(comment_card.annotation_thread.querySelector(".cmtr-anno-gutter-thread-actions")).not.toBeNull();
		expect(anchored_card.annotation_thread.querySelector("[aria-label='Resolve thread']")).not.toBeNull();
		expect(comment_card.annotation_thread.querySelector("[aria-label='Accept changes']")).toBeNull();
		expect(anchored_card.annotation_thread.querySelector("[aria-label='Reject changes']")).toBeNull();

		// EXPL: action buttons carry Obsidian's own `clickable-icon` class so they inherit the
		//       app's native icon-button treatment (transparent at rest, flat hover tint) instead
		//       of a bespoke shadow/outline style.
		const resolve_button = anchored_card.annotation_thread.querySelector("[aria-label='Resolve thread']")!;
		expect(resolve_button.classList.contains("clickable-icon")).toBe(true);
	});

	// EXPL: Deleting a thread destroys the only copy of what people wrote — and on a HIGHLIGHT base
	//       `removeThreadChanges` also unwraps the anchor back into plain text. It must NOT sit as a
	//       one-click, hover-revealed icon a few pixels from Resolve, distinguishable only by glyph.
	//       Resolve is reversible; delete is not, so delete costs an extra step (the context menu).
	test("no destructive Delete button sits next to Resolve on a comment card", () => {
		const { view, ranges } = setup("x{>>hi<<}y{==sel==}{>>reply<<}z");
		const comment_card = mountThread(view, ranges[0]).marker;
		const anchored_card = mountThread(view, ranges[1]).marker;

		for (const card of [comment_card, anchored_card]) {
			expect(card.annotation_thread.querySelector("[aria-label='Delete thread']")).toBeNull();
			// nothing else destructive snuck into the hover row either
			const actions = card.annotation_thread.querySelectorAll(".cmtr-anno-gutter-thread-action");
			expect(actions).toHaveLength(1);
			expect(actions[0].getAttribute("aria-label")).toBe("Resolve thread");
		}
	});

	test("suggestion cards render Accept/Reject actions, not Resolve/Delete (standalone or with replies)", () => {
		const { view, ranges } = setup("x{++add++}y{--del--}{>>note<<}z{~~old~>new~~}w");
		const standalone_addition = mountThread(view, ranges.find((r) => r.type === SuggestionType.ADDITION)!)
			.marker;
		const deletion_with_reply = mountThread(view, ranges.find((r) => r.type === SuggestionType.DELETION)!)
			.marker;
		const substitution = mountThread(view, ranges.find((r) => r.type === SuggestionType.SUBSTITUTION)!).marker;

		for (const card of [standalone_addition, deletion_with_reply, substitution]) {
			const accept_button = card.annotation_thread.querySelector("[aria-label='Accept changes']");
			const reject_button = card.annotation_thread.querySelector("[aria-label='Reject changes']");
			expect(accept_button).not.toBeNull();
			expect(reject_button).not.toBeNull();
			expect(card.annotation_thread.querySelector("[aria-label='Resolve thread']")).toBeNull();
			expect(card.annotation_thread.querySelector("[aria-label='Delete thread']")).toBeNull();

			// EXPL: same Obsidian-native `clickable-icon` treatment applies to Accept/Reject.
			expect(accept_button!.classList.contains("clickable-icon")).toBe(true);
			expect(reject_button!.classList.contains("clickable-icon")).toBe(true);
		}
	});
});

describe("suggestion card Accept/Reject buttons dispatch synchronously", () => {
	test("clicking Accept on an addition card applies the suggestion (keeps the added text, drops markup)", () => {
		const { view, ranges } = setup("x{++add++}y");
		const { marker } = mountThread(view, ranges[0]);

		const accept_button = marker.annotation_thread.querySelector<HTMLButtonElement>(
			"[aria-label='Accept changes']",
		)!;
		accept_button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(view.state.doc.toString()).toBe("xaddy");
	});

	test("clicking Reject on an addition card discards the suggestion entirely", () => {
		const { view, ranges } = setup("x{++add++}y");
		const { marker } = mountThread(view, ranges[0]);

		const reject_button = marker.annotation_thread.querySelector<HTMLButtonElement>(
			"[aria-label='Reject changes']",
		)!;
		reject_button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(view.state.doc.toString()).toBe("xy");
	});

	test("clicking Accept on a deletion card removes the deleted text", () => {
		const { view, ranges } = setup("x{--del--}y");
		const { marker } = mountThread(view, ranges[0]);

		const accept_button = marker.annotation_thread.querySelector<HTMLButtonElement>(
			"[aria-label='Accept changes']",
		)!;
		accept_button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(view.state.doc.toString()).toBe("xy");
	});

	test("clicking Reject on a deletion card keeps the deleted text and drops markup", () => {
		const { view, ranges } = setup("x{--del--}y");
		const { marker } = mountThread(view, ranges[0]);

		const reject_button = marker.annotation_thread.querySelector<HTMLButtonElement>(
			"[aria-label='Reject changes']",
		)!;
		reject_button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(view.state.doc.toString()).toBe("xdely");
	});

	test("Accept/Reject clicks stop propagation (thread-click focus handler does not also fire)", () => {
		const { view, ranges } = setup("x{++add++}y");
		const { marker } = mountThread(view, ranges[0]);

		const thread_click = jest.fn();
		marker.annotation_thread.addEventListener("click", thread_click);

		const accept_button = marker.annotation_thread.querySelector<HTMLButtonElement>(
			"[aria-label='Accept changes']",
		)!;
		accept_button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(thread_click).not.toHaveBeenCalled();
	});
});

describe("gutter card shape: action row must not steal :first-child/:last-child from entries", () => {
	test("hypothesis check: the actions row is inserted BEFORE the annotation entry in DOM order", () => {
		// EXPL: This documents *why* the plain `.cmtr-anno-gutter-annotation:first-child` /
		//       `:last-child` CSS selectors break for a lone comment card: `toDOM()` appends the
		//       actions row to `annotation_thread` before looping over `this.annotations` to build
		//       the entries, so the actions row — not the entry — is the literal first DOM child.
		//       `:last-child` still matches the entry (nothing follows it), so the card renders
		//       with square top / rounded bottom, i.e. a "bottom segment" — matching the report.
		const { view, ranges } = setup("x{>>hi<<}y");
		const { marker } = mountThread(view, ranges[0]);

		const children = Array.from(marker.annotation_thread.children);
		expect(children[0].classList.contains("cmtr-anno-gutter-thread-actions")).toBe(true);

		const entry = marker.annotation_thread.querySelector(".cmtr-anno-gutter-annotation")!;
		expect(marker.annotation_thread.firstElementChild).not.toBe(entry);
		expect(marker.annotation_thread.firstElementChild!.classList.contains("cmtr-anno-gutter-annotation")).toBe(
			false,
		);
		// EXPL: `:last-child` was never broken — the entry IS the literal last child.
		expect(marker.annotation_thread.lastElementChild).toBe(entry);
	});

	test("lone-entry card: exactly one .cmtr-anno-gutter-annotation, first AND last among its own kind", () => {
		// EXPL: The fix (annotation-gutter.scss) selects entries with `:nth-child(1 of S)` /
		//       `:nth-last-child(1 of S)` (S = .cmtr-anno-gutter-annotation), which matches the
		//       first/last child *among elements matching S*, ignoring interleaved siblings like
		//       the actions row entirely. jsdom can't evaluate that selector (no computed CSS
		//       either way), so assert the structural fact the selector keys on directly: among
		//       `.cmtr-anno-gutter-annotation`-classed children, there is exactly one, so it is
		//       trivially both the first and the last of its kind -> gets full corner rounding.
		const { view, ranges } = setup("x{>>hi<<}y");
		const { marker } = mountThread(view, ranges[0]);

		const entries = Array.from(marker.annotation_thread.children).filter((el) =>
			el.classList.contains("cmtr-anno-gutter-annotation")
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toBe(marker.annotation_thread.querySelector(".cmtr-anno-gutter-annotation"));
	});

	test("multi-entry thread: first/last-of-kind still resolve correctly around the actions row", () => {
		const { view, ranges } = setup("x{==sel==}{>>a<<}{>>b<<}y");
		const { marker } = mountThread(view, ranges[0]);

		const entries = Array.from(marker.annotation_thread.children).filter((el) =>
			el.classList.contains("cmtr-anno-gutter-annotation")
		);
		expect(entries).toHaveLength(2);
		// EXPL: nth-child(1 of S)/nth-last-child(1 of S) pick these two regardless of the actions
		//       row's position among the children — unlike plain :first-child/:last-child.
		expect(entries[0]).not.toBe(entries[1]);
	});
});
