import { EditorView } from "@codemirror/view";

import { rangeParser } from "../src/editor/base";
import { CommentIconWidget } from "../src/editor/renderers/live-preview/comment-widget";
import { createRangeState } from "./helpers";

function icon_for(doc: string) {
	const view = new EditorView({ state: createRangeState(doc) });
	const range = view.state.field(rangeParser).ranges.ranges[0];
	const widget = new CommentIconWidget(view, range, false);
	widget.toDOM(view);
	return widget.icon!;
}

describe("CommentIconWidget tooltip wiring", () => {
	test("a comment with only metadata still gets tooltip handlers", () => {
		expect(icon_for(`x{>>{"author":"A"}@@<<}y`).onmouseenter).toBeTruthy();
	});

	test("a comment with content gets tooltip handlers", () => {
		expect(icon_for(`x{>>hi<<}y`).onmouseenter).toBeTruthy();
	});

	test("a fully empty comment gets none", () => {
		expect(icon_for(`x{>><<}y`).onmouseenter).toBeFalsy();
	});
});
