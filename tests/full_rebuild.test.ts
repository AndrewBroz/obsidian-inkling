import { EditorState, Prec, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorEditorField, editorInfoField, editorLivePreviewField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { annotationGutterMarkers } from "../src/editor/renderers/gutters/annotations-gutter/marker";
import { focusRenderer, livepreviewRenderer, markupFocusState } from "../src/editor/renderers/live-preview";
import {
	annotationGutterIncludedTypesState,
	editModeValueState,
	fullReloadEffect,
	previewModeState,
} from "../src/editor/settings";
import { focusAnnotation, providePluginSettingsExtension } from "../src/editor/uix/extensions";
import { EditMode, PreviewMode } from "../src/types";

// EXPL: When an edit opens, closes or reshapes a fenced code block (or settings force a reload), range-state rebuilds
//       every range. It reported the rebuilt ranges as inserted but none as deleted, so the annotation gutter and the
//       live-preview renderer, which update incrementally, kept what they drew for the old ranges and drew the new
//       ones on top: typing ``` at the end of a note with 6 cards showed 12. Found in the sandbox.

const DOC = "a {==some==}{>>x<<}{author=T time=1} b {++add++} c {--del--}\n\n";
const settings = { ...DEFAULT_SETTINGS, add_metadata: false };

function mount(doc: string) {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	const view = new EditorView({ parent });
	view.setState(EditorState.create({
		doc,
		extensions: [
			rangeParser,
			providePluginSettingsExtension(<any> { settings }),
			editModeValueState.of(EditMode.CORRECTED),
			previewModeState.of(PreviewMode.ALL),
			editorInfoField.init(() => (<any> {})),
			editorEditorField.init(() => (<any> view)),
			editorLivePreviewField.init(() => true),
			markupFocusState,
			Prec.highest(focusRenderer),
			focusAnnotation(settings as any),
			Prec.low(livepreviewRenderer(settings as any)),
			annotationGutterIncludedTypesState.of(settings.annotation_gutter_included_types),
			annotationGutterMarkers,
		],
	}));
	return view;
}

function cards(state: EditorState) {
	let count = 0;
	for (const iter = state.field(annotationGutterMarkers).iter(); iter.value; iter.next()) count++;
	return count;
}

const marks = (view: EditorView) => view.contentDOM.querySelectorAll(".cmtr-inline").length;

describe("a full range rebuild replaces what consumers drew, never adds to it", () => {
	test("range-state reports every old range deleted when a fence opens", () => {
		const view = mount(DOC);
		const old = view.state.field(rangeParser).ranges.ranges;
		let tr: Transaction | undefined;
		view.dispatch(tr = view.state.update({ changes: { from: DOC.length, insert: "```" } }));
		const field = tr.state.field(rangeParser);
		expect(field.deleted_ranges).toEqual(old);
		expect(field.inserted_ranges.length).toBe(field.ranges.ranges.length);
		view.destroy();
	});

	test("typing a fence and a code block after the ranges keeps one card and one mark per range", () => {
		const view = mount(DOC);
		const start_cards = cards(view.state), start_marks = marks(view);
		expect(start_cards).toBe(3);
		expect(start_marks).toBe(3);

		for (const ch of "```\nUh oh\n```") {
			const at = view.state.doc.length;
			view.dispatch({ changes: { from: at, insert: ch }, selection: { anchor: at + 1 } });
			expect(cards(view.state)).toBe(start_cards);
			expect(marks(view)).toBe(start_marks);
		}
		view.destroy();
	});

	test("a fence opened above the ranges swallows them; closing it brings each back once", () => {
		const view = mount(DOC);
		view.dispatch({ changes: { from: 0, insert: "```\n" } });
		expect(cards(view.state)).toBe(0);
		expect(marks(view)).toBe(0);
		view.dispatch({ changes: { from: view.state.doc.length, insert: "```" } });
		expect(cards(view.state)).toBe(0);
		view.dispatch({ changes: { from: 0, to: 4 } });
		expect(cards(view.state)).toBe(3);
		expect(marks(view)).toBe(3);
		view.destroy();
	});

	test("a settings reload replaces the cards", () => {
		const view = mount(DOC);
		const before = view.state.field(annotationGutterMarkers);
		view.dispatch({ effects: fullReloadEffect.of(true) });
		expect(cards(view.state)).toBe(3);
		// EXPL: The markers point at the rebuilt range objects, not the stale ones.
		const live = new Set(view.state.field(rangeParser).ranges.ranges);
		for (const iter = view.state.field(annotationGutterMarkers).iter(); iter.value; iter.next())
			expect(live.has(iter.value.annotation)).toBe(true);
		expect(view.state.field(annotationGutterMarkers)).not.toBe(before);
		view.destroy();
	});
});
