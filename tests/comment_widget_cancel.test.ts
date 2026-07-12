import { EditorView } from "@codemirror/view";

import { rangeParser } from "../src/editor/base";
import type { CommentRange } from "../src/editor/base/ranges";
import { CommentIconWidget } from "../src/editor/renderers/live-preview/comment-widget";
import type { PreviewEditor } from "../src/ui/preview-editor";
import { createRangeState } from "./helpers";

// EXPL: commitRangeEdit is private wiring; these tests reach it via an `any` cast on the
//       widget, the same way the real onSubmit/onBlur closures invoke it. The DOM-blur
//       reentrancy itself is not reachable under jsdom (EmbeddableMarkdownEditor is fully
//       stubbed — see tests/__mocks__/embeddable-editor.ts — so no native focus/blur wiring
//       exists), but the guard it relies on IS: a reentrant/second call with the same range
//       must never dispatch cancel_empty_comment twice, since the second dispatch would reuse
//       from/to offsets invalidated by the first.

function setup(doc: string) {
	const state = createRangeState(doc);
	const view = new EditorView({ state });
	const ranges = view.state.field(rangeParser).ranges.ranges;
	return { view, ranges };
}

function commit(
	widget: CommentIconWidget,
	range: CommentRange,
	container: HTMLElement,
	editorComponent: PreviewEditor,
) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(widget as any).commitRangeEdit(range, "", true, container, editorComponent);
}

describe("CommentIconWidget empty-cancel reentrancy guard", () => {
	test("reply cancel dispatches once even when editor teardown re-enters the handler", () => {
		const { view, ranges } = setup("x{==sel==}{>><<}y");
		const highlight = ranges[0];
		const reply = highlight.replies[0] as CommentRange;

		const widget = new CommentIconWidget(view, highlight, false);
		const container = document.createElement("div");

		// EXPL: Simulates the Critical repro: unloading the still-focused editor fires a native
		//       blur that synchronously re-enters commitRangeEdit with the SAME range object,
		//       whose from/to are already stale after the first cancel dispatch.
		let unload_calls = 0;
		const editorStub = {
			unload: () => {
				unload_calls++;
				commit(widget, reply, container, editorStub);
			},
		} as unknown as PreviewEditor;

		commit(widget, reply, container, editorStub);

		// EXPL: Exactly one cancel applied: anchor unwrapped, no double-deletion at stale offsets.
		expect(view.state.doc.toString()).toBe("xsely");
		// EXPL: The reentrant call must have hit the latch BEFORE reaching unload again.
		expect(unload_calls).toBe(1);
	});

	test("a straggler blur after a completed cancel is a no-op", () => {
		const { view, ranges } = setup("x{==sel==}{>><<}y");
		const highlight = ranges[0];
		const reply = highlight.replies[0] as CommentRange;

		const widget = new CommentIconWidget(view, highlight, false);
		const container = document.createElement("div");
		const editorStub = { unload: () => {} } as unknown as PreviewEditor;

		commit(widget, reply, container, editorStub);
		expect(view.state.doc.toString()).toBe("xsely");

		commit(widget, reply, container, editorStub);
		expect(view.state.doc.toString()).toBe("xsely");
	});

	test("base-comment cancel is latched too (second call with the widget's own range is a no-op)", () => {
		const { view, ranges } = setup("x{>><<}y");
		const base = ranges[0] as CommentRange;

		const widget = new CommentIconWidget(view, base, false);
		// EXPL: unrenderTooltip -> setFocused dereferences the icon, which toDOM would normally create.
		widget.icon = document.createElement("span");
		const container = document.createElement("div");
		const editorStub = { unload: () => {} } as unknown as PreviewEditor;

		commit(widget, base, container, editorStub);
		expect(view.state.doc.toString()).toBe("xy");

		commit(widget, base, container, editorStub);
		expect(view.state.doc.toString()).toBe("xy");
	});
});
