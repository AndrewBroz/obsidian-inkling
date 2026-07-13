import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { App, editorEditorField, editorInfoField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { annotation_gutter } from "../src/editor/renderers/gutters/annotations-gutter/annotation-gutter";
import { annotationGutterMarkers } from "../src/editor/renderers/gutters/annotations-gutter/marker";
import {
	PendingAnnotationMarker,
	pendingAnnotationMarkers,
} from "../src/editor/renderers/gutters/annotations-gutter/pending-marker";
import { annotationGutterIncludedTypesState } from "../src/editor/settings";
import { providePluginSettingsExtension } from "../src/editor/uix/extensions";
import { clearCommentDraft, commentDraftField, setCommentDraft } from "../src/editor/uix/extensions/comment-draft";
import { EmbeddableMarkdownEditor as MockEditor } from "./__mocks__/embeddable-editor";

// EXPL: The gutter's card DOM is built with Obsidian's DOM helpers (createDiv/createEl, both the
//       element-scoped and global forms), which Obsidian injects into the real runtime. jsdom lacks
//       them, so provide minimal equivalents here — mirrors the per-file prototype patch established
//       in gutter_annotation_dispatch.test.ts / gutter_fold_button.test.ts.
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
(globalThis as any).createEl = (tag: string, o?: ElOptions) => {
	const el = document.createElement(tag);
	applyElOptions(el, o);
	return el;
};
if (!("win" in proto)) {
	Object.defineProperty(proto, "win", {
		get(this: HTMLElement) {
			return this.ownerDocument.defaultView;
		},
	});
}

// EXPL: reply-box.ts eagerly reads `app.plugins.plugins["inkling"].editorExtensions` while building
//       its EmbeddableMarkdownEditor options; the App stand-in (__mocks__/obsidian.ts) has no
//       plugin manager, so stub the shape the card actually touches.
function stubApp() {
	const app = new App();
	(app.workspace as any).requestSaveLayout = () => {};
	(app.vault as any).getConfig = () => undefined;
	(app as any).plugins = { plugins: { inkling: { editorExtensions: [] } } };
	return app;
}

/**
 * Mounts the REAL annotation gutter (as index.ts wires it: annotation markers joined with the
 * pending ones) over a jsdom EditorView, so these tests exercise the actual
 * GutterView/GutterElement/GutterMarker machinery — which is where the provisional card's one
 * genuinely dangerous behaviour lives (see the "survives an unrelated edit" test).
 */
function setup(doc: string, { hideOnEmpty = false } = {}) {
	const app = stubApp();

	const { extension } = annotation_gutter({
		class: "cmtr-anno-gutter",
		markers: v => [v.state.field(annotationGutterMarkers), v.state.field(pendingAnnotationMarkers)],
		foldState: false,
		width: 300,
		hideOnEmpty,
		includeFoldButton: true,
		includeResizeHandle: true,
	});

	const pluginSettingsField = providePluginSettingsExtension(
		<any> { settings: { ...DEFAULT_SETTINGS, add_metadata: false } },
	);

	const parent = document.createElement("div");
	parent.classList.add("markdown-source-view");
	document.body.appendChild(parent);

	// EXPL: `editorEditorField` is the StateField Obsidian populates with the live EditorView, and
	//       both marker StateFields read the view out of it. The jest stand-in
	//       (__mocks__/obsidian.ts) can only default it to `{}` — it has no view to hand out — so
	//       build the view first and `init()` the field with it, which is the state the plugin
	//       actually runs against.
	const view = new EditorView({ parent });
	view.setState(EditorState.create({
		doc,
		extensions: [
			rangeParser,
			pluginSettingsField,
			// EXPL: `annotationGutterIncludedTypesState` combines to `values[0]`, i.e. undefined when
			//       nothing provides it — and `undefined & AnnotationInclusionType.COMMENT` is 0, so
			//       every annotation type would be filtered out of the gutter. main.ts supplies it from
			//       settings (main.ts:200); supply it the same way here or no card ever renders.
			annotationGutterIncludedTypesState.of(DEFAULT_SETTINGS.annotation_gutter_included_types),
			commentDraftField,
			annotationGutterMarkers,
			pendingAnnotationMarkers,
			editorInfoField.init(() => (<any> { app })),
			editorEditorField.init(() => (<any> view)),
			extension,
		],
	}));

	MockEditor.instances = [];
	return { view };
}

function pendingCards(view: EditorView): HTMLElement[] {
	return Array.from(view.dom.querySelectorAll<HTMLElement>(".cmtr-anno-gutter-thread-pending"));
}

function pendingMarker(view: EditorView): PendingAnnotationMarker | null {
	let found: PendingAnnotationMarker | null = null;
	view.state.field(pendingAnnotationMarkers).between(0, view.state.doc.length, (_f, _t, value) => {
		found = value;
		return false;
	});
	return found;
}

/**
 * EXPL: The jest Component stub (__mocks__/obsidian.ts) does not replicate Obsidian's addChild
 *       auto-load cascade, so the ReplyBox's editor is never constructed at toDOM time under jest.
 *       Drive that load explicitly — standing in for what Obsidian does at runtime — and hand back
 *       the mock editor the box's Enter/Escape/blur hooks are wired to.
 */
function openEditor(view: EditorView): MockEditor {
	const marker = pendingMarker(view)!;
	marker.reply_box!.load();
	return MockEditor.instances[MockEditor.instances.length - 1];
}

describe("provisional comment card", () => {
	test("opening a draft renders a card quoting the selection, and writes nothing to the note", () => {
		const { view } = setup("hello world");
		expect(pendingCards(view)).toHaveLength(0);

		view.dispatch({ effects: setCommentDraft.of({ from: 6, to: 11 }) });

		const cards = pendingCards(view);
		expect(cards).toHaveLength(1);
		expect(cards[0].querySelector(".cmtr-anno-gutter-pending-quote")!.textContent).toBe("world");
		expect(cards[0].querySelector(".cmtr-anno-gutter-reply")).not.toBeNull();
		expect(view.state.doc.toString()).toBe("hello world");

		view.destroy();
	});

	// EXPL: THE dangerous seam. The pending StateField recomputes on every transaction while a draft
	//       is open, and CodeMirror decides whether to tear a marker's DOM down and rebuild it via
	//       GutterMarker.compare (identity, then eq). If that verdict comes out "different", the card
	//       is rebuilt — destroying the ReplyBox the user is mid-sentence in. An edit BEFORE the
	//       anchor is the case that matters: it MAPS the draft's from/to, so a from/to-based eq
	//       reports "changed" and the DOM is torn down. Identity is what actually holds here.
	test("the card and its reply box survive an edit elsewhere in the note that shifts the anchor", () => {
		const { view } = setup("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 6, to: 11 }) });

		const card = pendingCards(view)[0];
		const marker = pendingMarker(view)!;
		const editor = openEditor(view);
		editor.set("half-typed");
		const editors_before = MockEditor.instances.length;

		// EXPL: An insertion BEFORE the anchor — the draft maps 6..11 -> 8..13
		view.dispatch({ changes: { from: 0, to: 0, insert: "XX" } });

		expect(view.state.field(commentDraftField)).toEqual({ from: 8, to: 13 });
		// The very same DOM node is still mounted: no teardown, no rebuild
		expect(pendingCards(view)).toHaveLength(1);
		expect(pendingCards(view)[0]).toBe(card);
		// ...and no second reply editor was built, so the half-typed text is still there
		expect(MockEditor.instances).toHaveLength(editors_before);
		expect(editor.get()).toBe("half-typed");
		expect(pendingMarker(view)).toBe(marker);
		// The marker's anchor tracked the edit (the gutter sorts cards by `annotation.from`)
		expect(marker.annotation).toEqual({ from: 8, to: 13 });

		view.destroy();
	});

	// EXPL: AnnotationGutterUpdateContext.addElement sorts a block's markers through an UNCHECKED
	//       cast — `(markers as unknown as AnnotationMarker[]).sort((a, b) => a.annotation.from -
	//       b.annotation.from)` (annotation-gutter.ts:284). TypeScript cannot catch a missing
	//       `annotation.from`: it sorts as NaN and scrambles the order of every card in the block.
	test("the pending marker duck-types annotation.from/to for the gutter's marker sort", () => {
		const { view } = setup("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 6, to: 11 }) });

		const marker = pendingMarker(view)!;
		expect(typeof marker.annotation.from).toBe("number");
		expect(typeof marker.annotation.to).toBe("number");
		expect(marker.annotation).toEqual({ from: 6, to: 11 });

		view.destroy();
	});

	// EXPL: GutterElement.setMarkers (gutters/base.ts:168-190) can call toDOM() a SECOND time on the
	//       same marker instance without a destroy() in between (that is what `preventUnload` is for
	//       — see its FIXME). A second card must not orphan the first card's ReplyBox on the shared
	//       Component.
	test("toDOM twice on one marker instance leaves exactly one live reply box", () => {
		const { view } = setup("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 6, to: 11 }) });

		const marker = pendingMarker(view)!;
		const first_box = marker.reply_box;
		expect(first_box).not.toBeNull();

		const second = marker.toDOM();
		expect(second.querySelectorAll(".cmtr-anno-gutter-reply")).toHaveLength(1);
		expect(marker.reply_box).not.toBe(first_box);
		expect(marker.reply_box).not.toBeNull();

		view.destroy();
	});

	test("Escape discards the draft: the card disappears and the note is untouched", () => {
		const { view } = setup("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 6, to: 11 }) });

		const editor = openEditor(view);
		editor.set("never mind");
		editor.pressEscape();

		expect(view.state.field(commentDraftField)).toBeNull();
		expect(pendingCards(view)).toHaveLength(0);
		expect(view.state.doc.toString()).toBe("hello world");

		view.destroy();
	});

	test("Enter writes the comment to the note exactly once and retires the card", () => {
		const { view } = setup("hello world");
		view.dispatch({ effects: setCommentDraft.of({ from: 6, to: 11 }) });

		const editor = openEditor(view);
		editor.set("nice");
		editor.pressEnter(false);

		expect(view.state.doc.toString()).toBe("hello {==world==}{>>nice<<}");
		expect(view.state.field(commentDraftField)).toBeNull();
		expect(pendingCards(view)).toHaveLength(0);
		// The committed comment now renders as a normal card
		expect(view.dom.querySelectorAll(".cmtr-anno-gutter-thread")).toHaveLength(1);

		view.destroy();
	});

	// EXPL: `annotation_gutter_hide_empty` defaults to TRUE, and the gutter's emptiness test only
	//       counted `annotationGutterMarkers` — so in a note with no annotations yet (the FIRST
	//       comment, the single most common case) the gutter stays pinned at width 0 and the
	//       provisional card is invisible. A draft has to count as content.
	test("a hide-on-empty gutter opens up for a draft in a note with no annotations", () => {
		const { view } = setup("hello world", { hideOnEmpty: true });
		const gutter = view.dom.querySelector<HTMLElement>(".cmtr-anno-gutter")!;
		const width = () => parseInt(gutter.style.width) || 0;
		expect(width()).toBe(0);

		view.dispatch({ effects: setCommentDraft.of({ from: 6, to: 11 }) });
		expect(width()).toBe(300);

		// ...and collapses again once the draft is abandoned
		view.dispatch({ effects: clearCommentDraft.of(null) });
		expect(width()).toBe(0);

		view.destroy();
	});
});
