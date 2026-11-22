import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorEditorField, editorInfoField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { bracketMatcher } from "../src/editor/uix/extensions/bracket-matcher";
import { editMode } from "../src/editor/uix/extensions/editing-modes";
import { rangeCorrecter } from "../src/editor/uix/extensions/range-correcter";
import { createRangeState } from "./helpers";

// EXPL: Inside a fenced code block (its content or a fence line) every keystroke does what it does without Inkling:
//       code is plain text. Owner's report: in a code block, select some text, type `{` (Obsidian wraps the selection
//       in braces), then `~~`; tag completion deleted the selection and wrote `{~~~>~~}}`.

const settings = { ...DEFAULT_SETTINGS, add_metadata: false };

function mount(doc: string, extensions: Extension[]) {
	return new EditorView({
		state: createRangeState(doc, { add_metadata: false }, [
			editorEditorField,
			editorInfoField.init(() => (<any> { app: { workspace: { activeEditor: null } } })),
			...extensions,
		]),
	});
}

/** Runs the editor's input handlers for `text` typed over the selection, as a keystroke does; true if one took it. */
function input(view: EditorView, text: string): boolean {
	const { from, to } = view.state.selection.main;
	const handled = view.state.facet(EditorView.inputHandler)
		.some(handler => handler(view, from, to, text, () => view.state.update({ changes: { from, to, insert: text } })));
	if (!handled) {
		view.dispatch({
			changes: { from, to, insert: text },
			selection: EditorSelection.cursor(from + text.length),
			userEvent: "input.type",
		});
	}
	return handled;
}

describe("tag completion", () => {
	const CODE = "prose\n```\nalpha {~ gamma\n```\n";

	test.each(["{++", "{--", "{~~", "{==", "{>>"])("does nothing in a code block: %s", opener => {
		const doc = `prose\n\`\`\`\nalpha ${opener.slice(0, 2)}}\n\`\`\`\n`;
		const view = mount(doc, [bracketMatcher]);
		const at = doc.indexOf("}", doc.indexOf("alpha"));
		view.dispatch({ selection: EditorSelection.cursor(at) });
		expect(input(view, opener[2])).toBe(false);
		view.destroy();
	});

	test.each(["```", "```js"])("does nothing on a fence line: %s", fence => {
		const doc = `a\n${fence} {+}\nb\n\`\`\`\n`;
		const view = mount(doc, [bracketMatcher]);
		view.dispatch({ selection: EditorSelection.cursor(doc.indexOf("}")) });
		expect(input(view, "+")).toBe(false);
		view.destroy();
	});

	test("does nothing over a selection, in prose or code: the owner's repro", () => {
		for (const doc of ["alpha {~beta~} gamma", CODE.replace("{~", "{~beta~}")]) {
			const view = mount(doc, [bracketMatcher]);
			const beta = doc.indexOf("beta");
			view.dispatch({ selection: EditorSelection.range(beta, beta + 4) });
			expect(input(view, "~")).toBe(false);
			view.destroy();
		}
	});

	test("in prose, completes an opener and replaces the auto-paired brace", () => {
		const view = mount("a {+} b", [bracketMatcher]);
		view.dispatch({ selection: EditorSelection.cursor(4) });
		expect(input(view, "+")).toBe(true);
		expect(view.state.doc.toString()).toBe("a {++++} b");
		expect(view.state.selection.main.head).toBe(5);
		view.destroy();
	});

	test("in prose with no auto-paired brace, completes without deleting the next character", () => {
		const view = mount("a {+x b", [bracketMatcher]);
		view.dispatch({ selection: EditorSelection.cursor(4) });
		expect(input(view, "+")).toBe(true);
		expect(view.state.doc.toString()).toBe("a {++++}x b");
		view.destroy();
	});
});

// A range can span a code block (no range opens or closes in code), so edits in the code are inside it.
const SPANNING = "{++a\n```\nb {--x--} c\n\n```\nd++}";

// EXPL: Regression guard: Editing mode's syntax protection acts only next to range brackets, which never sit in code,
//       so these held before too; the explicit check keeps it that way.
describe("Editing mode applies edits in a code block as typed", () => {
	const inner = SPANNING.indexOf("{--"), closer = SPANNING.indexOf("--}");
	test.each([
		["typing before a markup-looking opener", { from: inner, insert: "Q" }],
		["typing inside markup-looking text", { from: inner + 3, insert: "Q" }],
		["Backspace over a markup-looking closer", { from: closer + 2, to: closer + 3 }],
		["Delete over a markup-looking opener", { from: inner, to: inner + 1 }],
		["replacing a selection across markup-looking text", { from: inner + 1, to: closer + 1, insert: "Z" }],
		["typing on the closing fence line", { from: SPANNING.lastIndexOf("```") + 3, insert: "Q" }],
	] as [string, { from: number; to?: number; insert?: string }][])("%s", (_, change) => {
		const view = mount(SPANNING, [editMode(settings)]);
		view.dispatch({ selection: EditorSelection.cursor(change.from) });
		view.dispatch({
			changes: change,
			userEvent: change.insert ? "input.type" : "delete.backward",
		});
		expect(view.state.doc.toString()).toBe(
			EditorState.create({ doc: SPANNING }).update({ changes: change }).state.doc.toString(),
		);
		view.destroy();
	});
});

test("leaving a highlight that spans a code block leaves the code's blank lines alone", () => {
	const doc = "{==a\n```\nx\n\ny\n```\nb==} after";
	const state = createRangeState(doc, { add_metadata: false }, [rangeCorrecter])
		.update({ selection: EditorSelection.cursor(2) }).state;
	const tr = state.update({ selection: EditorSelection.cursor(doc.length), userEvent: "select" });
	expect(tr.state.doc.toString()).toBe(doc);
});
