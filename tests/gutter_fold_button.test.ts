import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { App, editorEditorField, editorInfoField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import {
	annotation_gutter,
	annotationGutterFoldAnnotation,
} from "../src/editor/renderers/gutters/annotations-gutter/annotation-gutter";
import { annotationGutterMarkers } from "../src/editor/renderers/gutters/annotations-gutter/marker";
import { providePluginSettingsExtension } from "../src/editor/uix/extensions";

// EXPL: The annotation gutter's fold button is built with Obsidian's DOM helpers
//       (createEl/createDiv, both the element-scoped and global forms), which Obsidian injects
//       into the real runtime. jsdom lacks them, so provide minimal equivalents here — mirrors
//       the pattern established in gutter_annotation_dispatch.test.ts (per-file prototype patch).
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
(globalThis as any).createDiv = (o?: ElOptions) => {
	const el = document.createElement("div");
	applyElOptions(el, o);
	return el;
};
(globalThis as any).createEl = (tag: string, o?: ElOptions) => {
	const el = document.createElement(tag);
	applyElOptions(el, o);
	return el;
};
// EXPL: Obsidian patches every `HTMLElement` with a `.win` getter (owner window, used for
//       pop-out-window support); `updateFoldButtonPosition()` relies on it. jsdom has no such
//       patch, so provide it here too.
if (!("win" in proto)) {
	Object.defineProperty(proto, "win", {
		get(this: HTMLElement) {
			return this.ownerDocument.defaultView;
		},
	});
}

/**
 * Mounts the real annotation-gutter extension (bypassing the `CommentatorPlugin`-shaped
 * `annotationGutter(plugin)` wrapper in index.ts, which pulls in settings/vault plumbing that
 * isn't needed to exercise the fold button) in a jsdom-backed `EditorView`, wired up enough for
 * `AnnotationSingleGutterView`'s constructor/fold path to run without throwing:
 *  - `parent` is a real `.markdown-source-view` div, so the "hide gutter outside a markdown
 *    view" branch in `AnnotationGutterView`'s constructor is skipped.
 *  - `editorInfoField`'s `app` (mocked `App`, see __mocks__/obsidian.ts) gets its
 *    `workspace.requestSaveLayout` / `vault.getConfig` stubbed, since `foldGutter()`
 *    unconditionally reads both.
 */
function setup(foldState: boolean) {
	const app = new App();
	(app.workspace as any).requestSaveLayout = () => {};
	(app.vault as any).getConfig = () => undefined;

	const { extension } = annotation_gutter({
		class: "cmtr-anno-gutter",
		markers: (v) => v.state.field(annotationGutterMarkers),
		foldState,
		width: 300,
		hideOnEmpty: false,
		includeFoldButton: true,
		includeResizeHandle: false,
	});

	const pluginSettingsField = providePluginSettingsExtension(<any> { settings: { ...DEFAULT_SETTINGS } });

	const state = EditorState.create({
		doc: "hello world",
		extensions: [
			rangeParser,
			pluginSettingsField,
			annotationGutterMarkers,
			editorInfoField.init(() => (<any> { app })),
			editorEditorField,
			extension,
		],
	});

	const parent = document.createElement("div");
	parent.classList.add("markdown-source-view");
	document.body.appendChild(parent);

	const view = new EditorView({ state, parent });
	return { view };
}

function getFoldIcon(view: EditorView): HTMLElement {
	const button = view.dom.querySelector<HTMLElement>(".cmtr-anno-gutter-button");
	expect(button).not.toBeNull();
	const icon = button!.children[0] as HTMLElement;
	expect(icon).toBeDefined();
	return icon;
}

const FOLDED_CLASS = "cmtr-anno-gutter-button-folded";

describe("annotation gutter fold button icon state", () => {
	test("creation while folded starts with the folded class and 'Unfold gutter' label", () => {
		const { view } = setup(true);
		const icon = getFoldIcon(view);
		expect(icon.classList.contains(FOLDED_CLASS)).toBe(true);
		expect(icon.ariaLabel).toBe("Unfold gutter");
		view.destroy();
	});

	test("creation while unfolded starts without the folded class and 'Fold gutter' label", () => {
		const { view } = setup(false);
		const icon = getFoldIcon(view);
		expect(icon.classList.contains(FOLDED_CLASS)).toBe(false);
		expect(icon.ariaLabel).toBe("Fold gutter");
		view.destroy();
	});

	test("clicking the button toggles the folded class both ways", () => {
		const { view } = setup(false);
		const button = view.dom.querySelector<HTMLElement>(".cmtr-anno-gutter-button a")!;
		const icon = getFoldIcon(view);

		button.click();
		expect(icon.classList.contains(FOLDED_CLASS)).toBe(true);
		expect(icon.ariaLabel).toBe("Unfold gutter");

		button.click();
		expect(icon.classList.contains(FOLDED_CLASS)).toBe(false);
		expect(icon.ariaLabel).toBe("Fold gutter");

		view.destroy();
	});

	test("dispatching annotationGutterFoldAnnotation (context menu / command path) toggles the folded class", () => {
		const { view } = setup(false);
		const icon = getFoldIcon(view);

		view.dispatch({ annotations: [annotationGutterFoldAnnotation.of(null)] });
		expect(icon.classList.contains(FOLDED_CLASS)).toBe(true);
		expect(icon.ariaLabel).toBe("Unfold gutter");

		view.dispatch({ annotations: [annotationGutterFoldAnnotation.of(null)] });
		expect(icon.classList.contains(FOLDED_CLASS)).toBe(false);
		expect(icon.ariaLabel).toBe("Fold gutter");

		view.destroy();
	});

	test("dispatching an explicit fold value (state restore path) sets the folded class to match", () => {
		const { view } = setup(false);
		const icon = getFoldIcon(view);

		view.dispatch({ annotations: [annotationGutterFoldAnnotation.of(true)] });
		expect(icon.classList.contains(FOLDED_CLASS)).toBe(true);

		view.dispatch({ annotations: [annotationGutterFoldAnnotation.of(false)] });
		expect(icon.classList.contains(FOLDED_CLASS)).toBe(false);

		view.destroy();
	});
});
