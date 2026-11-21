import { EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorEditorField, editorInfoField, editorLivePreviewField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { focusRenderer, livepreviewRenderer, markupFocusState } from "../src/editor/renderers/live-preview";
import { editModeValueState, previewModeState } from "../src/editor/settings";
import { focusAnnotation, providePluginSettingsExtension } from "../src/editor/uix/extensions";
import { EditMode, PreviewMode } from "../src/types";

// EXPL: The live-preview renderer updates incrementally: on a selection move it drops the decorations of the ranges
//       the old and new selections touch and rebuilds them. A legacy range's highlight mark spans the replace that
//       hides its `{…}@@` metadata, so CodeMirror keeps that mark in a second layer, and the drop filter (a cursor that
//       assumed one pass in document order) never matched it there. Each move then left the old mark and added a new
//       one, nesting one more `.cmtr-highlight` per move. Found in the sandbox after committing a draft (which writes
//       legacy metadata by default) and clicking back into the note.
function mount(doc: string) {
	const settings = { ...DEFAULT_SETTINGS, add_metadata: false };
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
			// the precedences main.ts registers these with
			markupFocusState,
			Prec.highest(focusRenderer),
			focusAnnotation(settings as any),
			Prec.low(livepreviewRenderer(settings as any)),
		],
	}));
	return view;
}

describe("incremental live-preview updates never stack a range's decorations", () => {
	test.each([
		["legacy metadata", "a {=={\"author\":\"T\",\"time\":1}@@some==}{>>{\"author\":\"T\",\"time\":1}@@x<<} b"],
		["attribute metadata", "a {==some==}{>>x<<}{author=T time=1} b"],
		["no metadata", "a {==some==}{>>x<<} b"],
	])("%s: moving the cursor in and out of a highlight keeps exactly one highlight mark", (_name, doc) => {
		const view = mount(doc);
		const marks = () => view.contentDOM.querySelectorAll(".cmtr-highlight").length;
		const inside = doc.indexOf("some") + 1;

		expect(marks()).toBe(1);
		for (const pos of [inside, 0, inside, 0, doc.length]) {
			view.dispatch({ selection: { anchor: pos } });
			expect(marks()).toBe(1);
		}

		view.destroy();
	});

	test("an edit next to a legacy highlight keeps exactly one highlight mark", () => {
		const doc = "a {=={\"author\":\"T\",\"time\":1}@@some==}{>>{\"author\":\"T\",\"time\":1}@@x<<} b";
		const view = mount(doc);
		const marks = () => view.contentDOM.querySelectorAll(".cmtr-highlight").length;

		view.dispatch({ changes: { from: 0, to: 0, insert: "zz " }, selection: { anchor: doc.indexOf("some") + 4 } });
		expect(marks()).toBe(1);
		view.dispatch({ changes: { from: 0, to: 3 }, selection: { anchor: 0 } });
		expect(marks()).toBe(1);

		view.destroy();
	});
});
