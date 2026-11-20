import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorEditorField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { findCodeRegions } from "../src/editor/base/edit-util/code-regions";
import { suggestionMode } from "../src/editor/uix/extensions";
import { createRangeState } from "./helpers";

const DOC = "```\nab\n```";

function suggestView(doc: string): EditorView {
	return new EditorView({
		state: createRangeState(doc, { add_metadata: false }, [
			editorEditorField,
			EditorState.allowMultipleSelections.of(true),
			suggestionMode({ ...DEFAULT_SETTINGS, add_metadata: false }),
		]),
	});
}

describe("suggest mode and fenced code", () => {
	test("typing inside a fence is untracked", () => {
		const view = suggestView(DOC);
		view.dispatch({ changes: { from: 5, insert: "X" }, userEvent: "input.type" });
		expect(view.state.doc.toString()).toBe("```\naXb\n```");
		expect(view.state.doc.toString()).not.toContain("{++");
	});

	test("deleting inside a fence is untracked", () => {
		const view = suggestView(DOC);
		view.dispatch({ changes: { from: 4, to: 5 }, userEvent: "delete.backward" });
		expect(view.state.doc.toString()).toBe("```\nb\n```");
	});

	test("an edit crossing a fence edge is tracked", () => {
		const view = suggestView("hi\n" + DOC);
		view.dispatch({ changes: { from: 1, to: 8 }, userEvent: "delete.selection" });
		expect(view.state.doc.toString()).toContain("{--");
	});

	test("typing in prose is still tracked", () => {
		const view = suggestView("hi\n\n" + DOC);
		view.dispatch({ changes: { from: 2, insert: "X" }, userEvent: "input.type" });
		expect(view.state.doc.toString()).toContain("{++X++}");
	});

	test("typing at the start of the first content line is untracked", () => {
		const view = suggestView(DOC);
		view.dispatch({ changes: { from: 4, insert: "X" }, userEvent: "input.type" });
		expect(view.state.doc.toString()).toBe("```\nXab\n```");
	});

	test("Enter at the end of a closing fence is tracked and keeps the fence closed", () => {
		const view = suggestView("```\nx\n```\nafter {++y++}");
		view.dispatch({ changes: { from: 9, insert: "\n" }, userEvent: "input" });
		expect(view.state.doc.toString()).toBe("```\nx\n```{++\n++}\nafter {++y++}");
		const parsed = view.state.field(rangeParser);
		expect(parsed.code_regions.map(r => [r.from, r.to])).toEqual([[0, 9]]);
		expect(parsed.ranges.ranges.length).toBe(2);
	});

	test("deleting a whole block is tracked", () => {
		const view = suggestView("hi\n" + DOC);
		view.dispatch({ changes: { from: 3, to: 3 + DOC.length }, userEvent: "delete.selection" });
		expect(view.state.doc.toString()).toContain("{--");
	});

	test("deleting just the closing fence is tracked", () => {
		const view = suggestView(DOC);
		view.dispatch({ changes: { from: 7, to: 10 }, userEvent: "delete.selection" });
		expect(view.state.doc.toString()).toContain("{--");
	});

	test("typing at the start of the opening fence is tracked", () => {
		const view = suggestView("hi\n" + DOC);
		view.dispatch({ changes: { from: 3, insert: "X" }, userEvent: "input.type" });
		expect(view.state.doc.toString()).toContain("{++X++}");
	});

	test.each([
		["```\nx\n```\nafter {++y++}", 3],
		["~~~\nx\n~~~\nafter {++y++}", 3],
		["```js\nx\n```\nafter {++y++}", 5],
		["```\n```\nafter {++y++}", 3],
	])("Enter at the end of the opening fence of %j is a plain newline", (doc, at) => {
		const view = suggestView(doc);
		view.dispatch({ changes: { from: at, insert: "\n" }, userEvent: "input" });
		const text = view.state.doc.toString();
		expect(text).toBe(doc.slice(0, at) + "\n" + doc.slice(at));
		const parsed = view.state.field(rangeParser);
		expect(parsed.code_regions).toEqual(findCodeRegions(text));
		expect(parsed.ranges.ranges.map(r => text.slice(r.from, r.to))).toEqual(["{++y++}"]);
	});

	test("typing an info string at the end of the opening fence is untracked", () => {
		const view = suggestView(DOC);
		view.dispatch({ changes: { from: 3, insert: "js" }, userEvent: "input.type" });
		expect(view.state.doc.toString()).toBe("```js\nab\n```");
	});

	test.each([false, true])("a multi-cursor edit tracks the prose change and leaves the code change plain (code first: %s)", code_first => {
		const doc = "hi\n\n```\nab\n```";
		const view = suggestView(doc);
		const cursors = code_first ? [9, 2] : [2, 9];
		view.dispatch(view.state.update({
			changes: cursors.map(at => ({ from: at, insert: "X" })),
			selection: EditorSelection.create(cursors.map(at => EditorSelection.cursor(at)), 0),
			userEvent: "input.type",
		}));
		const text = view.state.doc.toString();
		expect(text).toBe("hi{++X++}\n\n```\naXb\n```");
		const heads = view.state.selection.ranges.map(r => r.head).sort((a, b) => a - b);
		expect(heads).toEqual([text.indexOf("X") + 1, text.indexOf("aX") + 2]);
	});

	describe("the closing fence is protected", () => {
		const FENCED = "```\nx\n```\nafter {++y++}";

		function expectIntact(view: EditorView, region_count = 1) {
			const text = view.state.doc.toString();
			const parsed = view.state.field(rangeParser);
			expect(parsed.code_regions).toEqual(findCodeRegions(text));
			expect(parsed.code_regions).toHaveLength(region_count);
			expect(parsed.code_regions[0].to).toBe(text.indexOf("```", parsed.code_regions[0].inner_to) + 3);
			expect(parsed.ranges.ranges.map(r => text.slice(r.from, r.to))).toEqual(["{++y++}"]);
		}

		test("typing at the start of the closing fence line goes on a new line above it", () => {
			const view = suggestView(FENCED);
			view.dispatch({ changes: { from: 6, insert: "a" }, selection: { anchor: 7 }, userEvent: "input.type" });
			expect(view.state.doc.toString()).toBe("```\nx\na\n```\nafter {++y++}");
			expect(view.state.selection.main.head).toBe(7);
			expectIntact(view);
		});

		test("pasting several lines there keeps the fence on its own line", () => {
			const view = suggestView(FENCED);
			view.dispatch({ changes: { from: 6, insert: "\na\nb" }, userEvent: "input.paste" });
			expect(view.state.doc.toString()).toBe("```\nx\n\na\nb\n```\nafter {++y++}");
			expectIntact(view);
		});

		test("Enter there is left alone", () => {
			const view = suggestView(FENCED);
			view.dispatch({ changes: { from: 6, insert: "\n" }, userEvent: "input" });
			expect(view.state.doc.toString()).toBe("```\nx\n\n```\nafter {++y++}");
			expectIntact(view);
		});

		test("Backspace joining the closing fence onto a non-empty line is refused", () => {
			const view = suggestView(FENCED);
			view.dispatch({ selection: { anchor: 6 } });
			view.dispatch({ changes: { from: 5, to: 6 }, selection: { anchor: 5 }, userEvent: "delete.backward" });
			expect(view.state.doc.toString()).toBe(FENCED);
			expect(view.state.selection.main.head).toBe(6);
		});

		test("Backspace joining the closing fence onto the opening fence is refused", () => {
			const doc = "```\n```\nafter {++y++}";
			const view = suggestView(doc);
			view.dispatch({ changes: { from: 3, to: 4 }, userEvent: "delete.backward" });
			expect(view.state.doc.toString()).toBe(doc);
		});

		test("Backspace removing an empty line above the closing fence is allowed, untracked", () => {
			const view = suggestView("```\nx\n\n```");
			view.dispatch({ changes: { from: 6, to: 7 }, userEvent: "delete.backward" });
			expect(view.state.doc.toString()).toBe("```\nx\n```");
		});

		test("selecting and deleting the closing fence is tracked", () => {
			const view = suggestView(FENCED);
			view.dispatch({ changes: { from: 6, to: 9 }, userEvent: "delete.selection" });
			expect(view.state.doc.toString()).toContain("{--");
		});

		test("an unclosed block is not affected", () => {
			const view = suggestView("```\nx\n");
			view.dispatch({ changes: { from: 6, insert: "a" }, userEvent: "input.type" });
			expect(view.state.doc.toString()).toBe("```\nx\na");
		});
	});
});

describe("the fence guard keeps fenced code intact (B1-B7)", () => {
	function parsed(view: EditorView) {
		const text = view.state.doc.toString();
		const field = view.state.field(rangeParser);
		expect(field.code_regions).toEqual(findCodeRegions(text));
		return {
			text,
			regions: field.code_regions.map(r => [r.from, r.to]),
			ranges: field.ranges.ranges.map(r => text.slice(r.from, r.to)),
		};
	}

	function typeAtHead(view: EditorView, chars: string) {
		for (const ch of chars) {
			const head = view.state.selection.main.head;
			view.dispatch({
				changes: { from: head, insert: ch },
				selection: { anchor: head + 1 },
				userEvent: ch === "\n" ? "input" : "input.type",
			});
		}
	}

	test("B1: typing a whole nested block into the addition after a closing fence keeps the first block closed", () => {
		const doc = "before {++y++}\n\n```\nx\n```\nafter";
		const fence_end = doc.indexOf("```\nafter") + 3;
		const view = suggestView(doc);
		view.dispatch({ selection: { anchor: fence_end } });
		for (const chunk of ["\n", "foo", "\n", "```", "js", "\n", "code", "\n", "```", "\n", "bar"]) {
			for (const ch of chunk) {
				typeAtHead(view, ch);
				const { regions, ranges } = parsed(view);
				expect(regions[0]).toEqual([16, fence_end]);
				expect(ranges[0]).toBe("{++y++}");
				expect(ranges.length).toBe(2);
			}
		}
		const { text, regions } = parsed(view);
		expect(text).toBe("before {++y++}\n\n```\nx\n```{++\nfoo\n```js\ncode\n```\nbar++}\nafter");
		const nested = text.indexOf("```js");
		expect(regions).toEqual([[16, fence_end], [nested, nested + 14]]);
	});

	test.each([
		["B2 Enter", "\n", "hi\n\n\n```\nab\n```\nafter {++y++}", 5],
		["B2 typing", "X", "hi\n\n{++X++}\n```\nab\n```\nafter {++y++}", 8],
	])("%s at the start of an opening fence line keeps the fence", (_, insert, expected, cursor) => {
		const view = suggestView("hi\n\n```\nab\n```\nafter {++y++}");
		view.dispatch({
			changes: { from: 4, insert },
			selection: { anchor: 5 },
			userEvent: insert === "\n" ? "input" : "input.type",
		});
		const { text, regions, ranges } = parsed(view);
		expect(text).toBe(expected);
		expect(regions).toHaveLength(1);
		expect(ranges).toContain("{++y++}");
		expect(view.state.selection.main.head).toBe(cursor);
	});

	test.each([
		[
			"B3 indented, after the indent",
			"- item\n  ```\n  code\n  ```\nafter {++y++}",
			22,
			"- item\n  ```\n  code\n  a\n  ```\nafter {++y++}",
		],
		[
			"B3 indented, column 0",
			"- item\n  ```\n  code\n  ```\nafter {++y++}",
			20,
			"- item\n  ```\n  code\n  a\n  ```\nafter {++y++}",
		],
		["B3 quoted, after the marker", "> ```\n> x\n> ```\nafter {++y++}", 12, "> ```\n> x\n> a\n> ```\nafter {++y++}"],
		["B4 quoted, column 0", "> ```\n> x\n> ```\nafter {++y++}", 10, "> ```\n> x\n> a\n> ```\nafter {++y++}"],
	])("%s: text typed on a closing fence line goes above it, untracked, inside the prefix", (_, doc, at, expected) => {
		const view = suggestView(doc);
		view.dispatch({ changes: { from: at, insert: "a" }, selection: { anchor: at + 1 }, userEvent: "input.type" });
		const { text, regions, ranges } = parsed(view);
		expect(text).toBe(expected);
		expect(regions.map(([, to]) => to)).toEqual([expected.indexOf("```", expected.indexOf("a\n")) + 3]);
		expect(ranges).toEqual(["{++y++}"]);
		expect(view.state.selection.main.head).toBe(expected.indexOf("a\n") + 1);
	});

	test.each([
		["Backspace at the start of the first code line", "delete.backward"],
		["Delete at the end of the opening fence line", "delete.forward"],
	])("B5: %s is refused when that line is not empty", (_, userEvent) => {
		const view = suggestView(DOC);
		view.dispatch({ selection: { anchor: userEvent === "delete.backward" ? 4 : 3 } });
		view.dispatch({ changes: { from: 3, to: 4 }, userEvent });
		expect(view.state.doc.toString()).toBe(DOC);
	});

	test("B5: Backspace removing an empty first code line is plain", () => {
		const view = suggestView("```\n\nab\n```");
		view.dispatch({ changes: { from: 3, to: 4 }, userEvent: "delete.backward" });
		const { text, regions } = parsed(view);
		expect(text).toBe(DOC);
		expect(regions).toEqual([[0, 10]]);
	});

	test("B6: replacing everything between the fence lines keeps both fences on their lines", () => {
		const view = suggestView("```\nx\n```\nafter {++y++}");
		view.dispatch({ changes: { from: 3, to: 6, insert: "Z" }, selection: { anchor: 4 }, userEvent: "input.type" });
		const { text, regions, ranges } = parsed(view);
		expect(text).toBe("```\nZ\n```\nafter {++y++}");
		expect(regions).toEqual([[0, 9]]);
		expect(ranges).toEqual(["{++y++}"]);
		expect(view.state.selection.main.head).toBe(5);
	});

	test("B7: a refused change does not cancel another cursor's change", () => {
		const doc = "hi there\n\n```\nab\n```";
		const view = suggestView(doc);
		view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(17)]) });
		view.dispatch(view.state.update({
			changes: [{ from: 1, to: 2 }, { from: 16, to: 17 }],
			selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(15)]),
			userEvent: "delete.backward",
		}));
		const { text, regions } = parsed(view);
		expect(text).toBe("h{--i--} there\n\n```\nab\n```");
		expect(regions).toEqual([[16, 26]]);
	});

	test("deleting the closing fence leaves a parsed deletion, not inert markup in code", () => {
		const view = suggestView("```\nx\n```\nafter {++y++}");
		view.dispatch({ changes: { from: 6, to: 9 }, userEvent: "delete.selection" });
		const { text, ranges } = parsed(view);
		expect(text).toBe("```\nx\n{--```--}\nafter {++y++}");
		expect(ranges).toEqual(["{--```--}", "{++y++}"]);
	});
});
