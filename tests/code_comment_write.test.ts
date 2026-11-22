import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import * as obsidian from "obsidian";
import { editorEditorField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { addCommentToView, commitCommentDraft } from "../src/editor/base/edit-logic/add-comment";
import { cancel_empty_comment, remove_comment, remove_thread, resolve_action } from "../src/editor/base/edit-logic/resolve";
import { codeCommentLinks } from "../src/editor/base/edit-util/code-comments";
import { applyToText } from "../src/editor/base/edit-util/range-operations";
import { resolve_source } from "../src/editor/base/edit-logic/resolve";
import { pendingAnnotationMarkers } from "../src/editor/renderers/gutters/annotations-gutter/pending-marker";
import { commentDraftField } from "../src/editor/uix/extensions/comment-draft";
import { commentMode } from "../src/editor/uix/extensions/editing-modes/comment-mode";
import { suggestionMode } from "../src/editor/uix/extensions/editing-modes/suggestion-mode";
import { pill_eligible } from "../src/editor/uix/extensions/comment-pill";
import type { CommentRange } from "../src/editor/base/ranges";
import { createRangeState } from "./helpers";

const NO_META = { add_metadata: false };
const WITH_GUTTER: Extension[] = [commentDraftField, pendingAnnotationMarkers, editorEditorField, codeCommentLinks];

const DOC = "intro\n```js\nlet x = 1\nlet y = 2\n```\n\nafter";
const FENCE_END = DOC.lastIndexOf("```") + 3;

function viewWith(doc: string, anchor: number, head: number, extra: Extension[] = WITH_GUTTER, settings = NO_META) {
	const view = new EditorView({ state: createRangeState(doc, settings, extra) });
	view.dispatch({ selection: { anchor, head } });
	return view;
}

/** Opens a comment on `anchor`-`head` and submits `text`. */
function comment(doc: string, anchor: number, head: number, text = "Why?", extra: Extension[] = WITH_GUTTER) {
	const view = viewWith(doc, anchor, head, extra);
	addCommentToView(view, undefined);
	expect(view.state.doc.toString()).toBe(doc);
	expect(commitCommentDraft(view, text)).toBe(true);
	return view.state.doc.toString();
}

function withNotice<T>(fn: (notice: jest.SpyInstance) => T): T {
	const notice = jest.spyOn(obsidian, "Notice").mockImplementation(() => ({}) as obsidian.Notice);
	try {
		return fn(notice);
	} finally {
		notice.mockRestore();
	}
}

describe("commenting on code writes a comment after the closing fence", () => {
	test("a selection within one line: the exact selection and its line", () => {
		const from = DOC.indexOf("x = 1");
		expect(comment(DOC, from, from + 5)).toBe(
			DOC.slice(0, FENCE_END) + "\n{>>Why?<<}{quote=\"x = 1\" line=1}" + DOC.slice(FENCE_END),
		);
	});

	test("a multi-line selection: the selected part of the first line, its line, and how many lines", () => {
		const from = DOC.indexOf("= 1"), to = DOC.indexOf("y =");
		expect(comment(DOC, from, to)).toBe(
			DOC.slice(0, FENCE_END) + "\n{>>Why?<<}{quote=\"= 1\" line=1 lines=2}" + DOC.slice(FENCE_END),
		);
	});

	test("a backwards selection is the same selection", () => {
		const from = DOC.indexOf("let y");
		expect(comment(DOC, from + 9, from)).toBe(
			DOC.slice(0, FENCE_END) + "\n{>>Why?<<}{quote=\"let y = 2\" line=2}" + DOC.slice(FENCE_END),
		);
	});

	test("the cursor only: a comment on the whole block, with no fields", () => {
		const at = DOC.indexOf("x = 1");
		expect(comment(DOC, at, at)).toBe(DOC.slice(0, FENCE_END) + "\n{>>Why?<<}" + DOC.slice(FENCE_END));
	});

	test("the cursor on a fence line is about the whole block too", () => {
		expect(comment(DOC, FENCE_END, FENCE_END)).toBe(DOC.slice(0, FENCE_END) + "\n{>>Why?<<}" + DOC.slice(FENCE_END));
	});

	test("with metadata on, the author and time come first", () => {
		const from = DOC.indexOf("let x = 1");
		const view = viewWith(DOC, from, from + 9, WITH_GUTTER, { add_metadata: true, author: "Andrew" } as never);
		addCommentToView(view, undefined);
		commitCommentDraft(view, "Why not const?");
		expect(view.state.doc.toString().slice(FENCE_END)).toMatch(
			/^\n\{>>Why not const\?<<\}\{author=Andrew time=\d+ quote="let x = 1" line=1\}\n\nafter$/,
		);
	});

	test("nothing is written inside the block, and the comment belongs to it", () => {
		const from = DOC.indexOf("x = 1");
		const text = comment(DOC, from, from + 5);
		const state = createRangeState(text, NO_META, [codeCommentLinks]);
		expect(state.field(rangeParser).code_regions.map(r => text.slice(r.from, r.to))).toEqual([
			"```js\nlet x = 1\nlet y = 2\n```",
		]);
		const [link] = [...state.field(codeCommentLinks).values()];
		expect(link.target).toEqual({ from, to: from + 5 });
	});

	test("a quote with quotes, braces and a comment closer is written so it reads back unchanged", () => {
		const doc = "```\nf({a: \"<<}\"})\n```";
		const from = 4, to = doc.indexOf("\n```");
		const text = comment(doc, from, to);
		const state = createRangeState(text, NO_META, [codeCommentLinks]);
		const [range] = state.field(rangeParser).ranges.ranges;
		expect(range.fields).toEqual({ quote: "f({a: \"<<}\"})", line: 1 });
		expect(state.field(codeCommentLinks).get(range)?.target).toEqual({ from, to });
	});

	test("a second comment on the same block joins the comment line, after a space", () => {
		const doc = "```\nx\ny\n```\n{>>first<<}{quote=x line=1}\n\nafter";
		const at = doc.indexOf("y");
		const text = comment(doc, at, at + 1, "second");
		expect(text).toBe("```\nx\ny\n```\n{>>first<<}{quote=x line=1} {>>second<<}{quote=y line=2}\n\nafter");
		expect(createRangeState(text, NO_META, [codeCommentLinks]).field(codeCommentLinks).size).toBe(2);
	});

	test("a block at the end of the note gets the comment on a new last line", () => {
		const doc = "```\nx\n```";
		expect(comment(doc, 4, 5)).toBe("```\nx\n```\n{>>Why?<<}{quote=x line=1}");
	});

	test("a block in a quote gets the comment on the next quoted line", () => {
		const doc = "> ```\n> x\n> ```\n\nafter";
		const at = doc.indexOf("x");
		expect(comment(doc, at, at + 1)).toBe("> ```\n> x\n> ```\n> {>>Why?<<}{quote=x line=1}\n\nafter");
	});

	test("a block in a list item keeps the comment in the item", () => {
		const doc = "- step\n  ```\n  x\n  ```\n- next";
		const at = doc.indexOf("x");
		expect(comment(doc, at, at + 1)).toBe("- step\n  ```\n  x\n  ```\n  {>>Why?<<}{quote=x line=1}\n- next");
	});

	test.each([
		["a paragraph", "```\nx\n```\nafter", "```\nx\n```\n{>>Why?<<}\n\nafter"],
		["a setext underline", "```\nx\n```\n---", "```\nx\n```\n{>>Why?<<}\n\n---"],
		["indented code", "```\nx\n```\n    code", "```\nx\n```\n{>>Why?<<}\n\n    code"],
		["a heading", "```\nx\n```\n# H", "```\nx\n```\n{>>Why?<<}\n# H"],
		["a list item", "```\nx\n```\n- item", "```\nx\n```\n{>>Why?<<}\n- item"],
		["a quote's following text", "> ```\n> x\n> ```\ntext", "> ```\n> x\n> ```\n> {>>Why?<<}\n>\ntext"],
	])("text directly after the fence that would join the comment's paragraph (%s) is kept apart", (_, doc, out) => {
		expect(comment(doc, doc.indexOf("x"), doc.indexOf("x"))).toBe(out);
	});

	test("an unclosed block is refused with a notice, and nothing is opened or written", () => {
		const doc = "intro\n```\ncode";
		for (const extra of [WITH_GUTTER, [commentDraftField]]) {
			withNotice(notice => {
				const view = viewWith(doc, doc.indexOf("code"), doc.indexOf("code") + 2, extra);
				addCommentToView(view, undefined);
				expect(view.state.doc.toString()).toBe(doc);
				expect(view.state.field(commentDraftField)).toBeNull();
				expect(notice).toHaveBeenCalledWith("Add a closing ``` to this code block before commenting on it.");
			});
		}
	});

	test("without the gutter, an empty comment with the fields is written after the fence at once", () => {
		const from = DOC.indexOf("x = 1");
		const view = viewWith(DOC, from, from + 5, [commentDraftField, codeCommentLinks]);
		addCommentToView(view, undefined);
		const text = view.state.doc.toString();
		expect(text).toBe(DOC.slice(0, FENCE_END) + "\n{>><<}{quote=\"x = 1\" line=1}" + DOC.slice(FENCE_END));
		expect(view.state.selection.main.head).toBe(text.indexOf("<<}"));
		expect(view.state.field(commentDraftField)).toBeNull();
	});
});

describe("the draft for a comment on code", () => {
	test("a selection opens a draft on the selected code", () => {
		const from = DOC.indexOf("x = 1");
		const view = viewWith(DOC, from, from + 5);
		addCommentToView(view, undefined);
		expect(view.state.field(commentDraftField)).toEqual({ from, to: from + 5, code: "selection" });
	});

	test("the cursor opens a draft on the whole block", () => {
		const at = DOC.indexOf("x = 1");
		const view = viewWith(DOC, at, at);
		addCommentToView(view, undefined);
		expect(view.state.field(commentDraftField)).toEqual({
			from: DOC.indexOf("```"),
			to: FENCE_END,
			code: "block",
		});
	});

	test("submitting collapses a selection on the code, so the pill does not offer it again", () => {
		const from = DOC.indexOf("x = 1");
		const view = viewWith(DOC, from, from + 5);
		addCommentToView(view, undefined);
		commitCommentDraft(view, "Why?");
		expect(view.state.selection.main.empty).toBe(true);
		expect(view.state.selection.main.head).toBe(from + 5);
		expect(pill_eligible(view.state)).toBe(false);
	});

	test("the quote is taken when the comment is submitted, from the code as it is then", () => {
		const from = DOC.indexOf("x = 1");
		const view = viewWith(DOC, from, from + 5);
		addCommentToView(view, undefined);
		// The user edits inside the selection before submitting.
		view.dispatch({ changes: { from: from + 4, to: from + 5, insert: "42" } });
		commitCommentDraft(view, "Why?");
		expect(view.state.doc.toString()).toContain("{>>Why?<<}{quote=\"x = 42\" line=1}");
	});

	test("a draft whose block lost its closing fence is kept, with a notice, and nothing is written", () => {
		const from = DOC.indexOf("x = 1");
		const view = viewWith(DOC, from, from + 5);
		addCommentToView(view, undefined);
		view.dispatch({ changes: { from: FENCE_END - 3, to: FENCE_END, insert: "" } });
		const before = view.state.doc.toString();
		withNotice(notice => {
			expect(commitCommentDraft(view, "Why?")).toBe(false);
			expect(notice).toHaveBeenCalledWith("Add a closing ``` to this code block before commenting on it.");
		});
		expect(view.state.doc.toString()).toBe(before);
		expect(view.state.field(commentDraftField)).not.toBeNull();
	});

	test("a draft whose code is no longer in a block is written as an ordinary comment with its quote", () => {
		const doc = "```\nlet x = 1\n```\n\nafter";
		const from = doc.indexOf("x = 1");
		const view = viewWith(doc, from, from + 5);
		addCommentToView(view, undefined);
		// Both fences removed: the code is plain text now.
		const close = doc.indexOf("\n```");
		view.dispatch({ changes: [{ from: 0, to: 4, insert: "" }, { from: close, to: close + 4, insert: "" }] });
		withNotice(notice => {
			expect(commitCommentDraft(view, "Why?")).toBe(true);
			expect(notice).toHaveBeenCalled();
		});
		expect(view.state.doc.toString()).toBe("let x = 1{>>Why?<<}{quote=\"x = 1\"}\n\nafter");
	});
});

describe("commenting on code in each mode", () => {
	const settings = { ...DEFAULT_SETTINGS, add_metadata: false };

	test("Comment mode: code stays read-only, but the comment is written", () => {
		const from = DOC.indexOf("x = 1");
		const extra = [...WITH_GUTTER, commentMode(settings)];
		const view = viewWith(DOC, from, from + 5, extra);
		view.dispatch({ changes: { from, to: from, insert: "Z" }, userEvent: "input" });
		expect(view.state.doc.toString()).toBe(DOC);
		expect(comment(DOC, from, from + 5, "Why?", extra)).toBe(
			DOC.slice(0, FENCE_END) + "\n{>>Why?<<}{quote=\"x = 1\" line=1}" + DOC.slice(FENCE_END),
		);
	});

	test("Suggest mode: the comment is written as it is, not as a suggestion", () => {
		const at = DOC.indexOf("x = 1");
		const extra = [...WITH_GUTTER, suggestionMode(settings)];
		expect(comment(DOC, at, at, "Why?", extra)).toBe(DOC.slice(0, FENCE_END) + "\n{>>Why?<<}" + DOC.slice(FENCE_END));
	});

	test("the pill is offered for a selection in code, but not in an unclosed block", () => {
		const from = DOC.indexOf("x = 1");
		expect(pill_eligible(createRangeState(DOC, NO_META).update({ selection: { anchor: from, head: from + 5 } }).state))
			.toBe(true);
		const open = "```\ncode";
		expect(pill_eligible(createRangeState(open, NO_META).update({ selection: { anchor: 4, head: 6 } }).state))
			.toBe(false);
	});
});

describe("removing a comment that has a line of its own takes the line too", () => {
	const doc = "```\nx\n```\n{>>c<<}{quote=x line=1}\n\nafter";

	function base(text: string) {
		return createRangeState(text, NO_META).field(rangeParser).ranges.ranges[0];
	}
	function apply(text: string, changes: { from: number; to: number; insert: string }[]) {
		return [...changes].sort((a, b) => b.from - a.from)
			.reduce((out, c) => out.slice(0, c.from) + c.insert + out.slice(c.to), text);
	}

	test("resolve with remove on resolve", () => {
		const state = createRangeState(doc, NO_META);
		const range = state.field(rangeParser).ranges.ranges[0];
		expect(apply(doc, resolve_action(range, { remove_on_resolve: true }, state.doc))).toBe("```\nx\n```\n\nafter");
	});

	test("a whole thread, and a quoted line", () => {
		const text = "> ```\n> x\n> ```\n> {>>c<<}{>>r<<}\n\nafter";
		const state = createRangeState(text, NO_META);
		expect(apply(text, remove_thread(state.field(rangeParser).ranges.ranges[0], state.doc)))
			.toBe("> ```\n> x\n> ```\n\nafter");
	});

	test("the last line of the note takes the line break before it", () => {
		const text = "```\nx\n```\n{>>c<<}";
		const state = createRangeState(text, NO_META);
		expect(apply(text, remove_thread(base(text), state.doc))).toBe("```\nx\n```");
	});

	test("one of several threads on the line leaves the line", () => {
		const text = "```\nx\n```\n{>>a<<} {>>b<<}";
		const state = createRangeState(text, NO_META);
		expect(apply(text, remove_thread(state.field(rangeParser).ranges.ranges[1], state.doc))).toBe("```\nx\n```\n{>>a<<} ");
	});

	test("a comment that shares its line with text leaves the line", () => {
		const text = "see {>>c<<}\nafter";
		const state = createRangeState(text, NO_META);
		expect(apply(text, remove_thread(base(text), state.doc))).toBe("see \nafter");
	});

	test("removing the only comment, and cancelling an empty one", () => {
		const state = createRangeState(doc, NO_META);
		const range = state.field(rangeParser).ranges.ranges[0];
		expect(apply(doc, remove_comment(range, state.doc))).toBe("```\nx\n```\n\nafter");
		const empty = "```\nx\n```\n{>><<}\n\nafter";
		const empty_state = createRangeState(empty, NO_META);
		expect(apply(empty, cancel_empty_comment(empty_state.field(rangeParser).ranges.ranges[0] as CommentRange, empty_state.doc)))
			.toBe("```\nx\n```\n\nafter");
	});

	test("removing the first comment of a thread with replies leaves the line", () => {
		const text = "```\nx\n```\n{>>c<<}{>>r<<}";
		const state = createRangeState(text, NO_META);
		expect(apply(text, remove_comment(base(text), state.doc))).toBe("```\nx\n```\n{>>r<<}");
	});

	test("resolving from the Annotations View (the whole note's text) also takes the line", () => {
		const text = doc.replace("line=1}", "line=1}{>>r<<}");
		const parsed = createRangeState(text, NO_META).field(rangeParser).ranges.ranges;
		expect(parsed).toHaveLength(2);
		expect(applyToText(text, (range, t) => resolve_source(range, t, { remove_on_resolve: true }), parsed))
			.toBe("```\nx\n```\n\nafter");
	});
});
