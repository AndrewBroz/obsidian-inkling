import { EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorEditorField, editorInfoField, editorLivePreviewField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { focusRenderer, livepreviewRenderer, markupFocusState } from "../src/editor/renderers/live-preview";
import { editModeValueState, previewModeState } from "../src/editor/settings";
import { focusAnnotation, providePluginSettingsExtension } from "../src/editor/uix/extensions";
import { EditMode, PreviewMode } from "../src/types";

// EXPL: These tests exist because a synthetic reproduction lied. 0.9.3 rewrote every focus rule in
//       editor.scss to assume `.cmtr-focused` is an ANCESTOR of the type span, on the strength of a
//       probe that put both marks in a single RangeSet — where nesting follows containment. The real
//       pipeline composes them from two decoration sources at different precedences
//       (`Prec.highest(focusRenderer)` vs `Prec.low(livepreviewRenderer)`), with the range's brackets
//       hidden by replace decorations, so the focus mark collapses onto the same visible text and
//       lands INSIDE. Selection silently stopped changing anything at all, and no test noticed.
//
//       So: assert the nesting the REAL pipeline produces, not one we reason our way to.
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
			// the exact precedences main.ts registers these with
			markupFocusState,
			Prec.highest(focusRenderer),
			focusAnnotation(settings as any),
			Prec.low(livepreviewRenderer(settings as any)),
		],
	}));
	return view;
}

/** Put the cursor inside `word` and return the type span + the focus span, if any. */
function focusOn(view: EditorView, doc: string, word: string, typeClass: string) {
	const at = doc.indexOf(word) + 1;
	view.dispatch({ selection: { anchor: at, head: at } });
	return {
		type_span: view.contentDOM.querySelector<HTMLElement>(`.${typeClass}`),
		focus_span: view.contentDOM.querySelector<HTMLElement>(".cmtr-focused"),
	};
}

describe("the focus mark is actually rendered against a range", () => {
	test.each([
		["addition", "before {++added++} after", "added", "cmtr-addition"],
		["deletion", "before {--cut--} after", "cut", "cmtr-deletion"],
		["highlight thread", "before {==anchor==}{>>note<<} after", "anchor", "cmtr-highlight"],
	])("%s: putting the cursor inside it renders .cmtr-focused", (_label, doc, word, cls) => {
		const view = mount(doc);

		// nothing focused to begin with
		expect(view.contentDOM.querySelector(".cmtr-focused")).toBeNull();

		const { type_span, focus_span } = focusOn(view, doc, word, cls);
		expect(type_span).not.toBeNull();
		expect(focus_span).not.toBeNull();

		// EXPL: The CSS in editor.scss must match whichever way these nest, so it is written in BOTH
		//       forms (`.cmtr-focused .cmtr-X` and `.cmtr-X:has(.cmtr-focused)`). This asserts the two
		//       spans are genuinely nested one inside the other — if they ever became siblings, or the
		//       same element, neither selector would match and selection would go dead again.
		const nested = focus_span!.contains(type_span!) || type_span!.contains(focus_span!);
		expect(nested).toBe(true);

		view.destroy();
	});

	test("moving the cursor out of a range removes the focus mark", () => {
		const doc = "before {++added++} after";
		const view = mount(doc);

		focusOn(view, doc, "added", "cmtr-addition");
		expect(view.contentDOM.querySelector(".cmtr-focused")).not.toBeNull();

		view.dispatch({ selection: { anchor: 0, head: 0 } });
		expect(view.contentDOM.querySelector(".cmtr-focused")).toBeNull();

		view.destroy();
	});
});
