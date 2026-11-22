import { EditorSelection, type Extension, MapMode, StateEffect, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorEditorField, editorInfoField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { editMode, suggestionMode } from "../src/editor/uix/extensions";
import { createRangeState } from "./helpers";

const settings = { ...DEFAULT_SETTINGS, add_metadata: false };

// EXPL: Obsidian auto-pairs a bracket or quote typed before a space or line end: one edit inserts `()` with the cursor
//       between. Suggest mode put the cursor after the pair, so `(a` came out as `()a`. Found in the sandbox.

/** `doc` after typing `pair` at `at` the way auto-pairing does (cursor after its first character), then `then`. */
function autopair(doc: string, at: number, pair: string, then: string) {
	const view = new EditorView({
		state: createRangeState(doc, { add_metadata: false }, [
			editorEditorField,
			suggestionMode(settings),
		]),
	});
	view.dispatch({ selection: EditorSelection.cursor(at) });
	view.dispatch(view.state.update({
		changes: { from: at, insert: pair },
		selection: EditorSelection.cursor(at + 1),
		userEvent: "input.type",
	}));
	for (const ch of then) {
		const head = view.state.selection.main.head;
		view.dispatch(view.state.update({
			changes: { from: head, insert: ch },
			selection: EditorSelection.cursor(head + 1),
			userEvent: "input.type",
		}));
	}
	const out = view.state.doc.toString();
	view.destroy();
	return out;
}

test.each([
	["a bracket at a line's end", "Para.", 5, "()", "a", "Para.{++(a)++}"],
	["a quote on an empty line", "a\n\nb", 2, "\"\"", "q", "a\n{++\"q\"++}\nb"],
	["a bracket inside one's own addition", "x{++ y++}", 6, "[]", "z", "x{++ y[z]++}"],
])("Suggest mode keeps the cursor between an auto-paired pair: %s", (_, doc, at, pair, then, expected) => {
	expect(autopair(doc, at, pair, then)).toBe(expected);
});

// EXPL: Obsidian types over an auto-paired closer by remembering where it put it, in an effect on the edit that
//       inserted the pair (mapped through later changes). Inkling's rewritten edits dropped their effects, so typing
//       `)` before the paired `)` inserted another one, in Editing mode as well as Suggest mode. Found in the sandbox.
describe("an auto-paired edit's effects survive Inkling's rewrite", () => {
	const closedAt = StateEffect.define<number>({ map: (pos, mapping) => mapping.mapPos(pos) });
	const remembered = StateField.define<number | null>({
		create: () => null,
		update: (value, tr) => {
			for (const effect of tr.effects) if (effect.is(closedAt)) return effect.value;
			return value === null ? null : tr.changes.mapPos(value);
		},
	});

	function typePair(doc: string, at: number, mode: Extension) {
		const view = new EditorView({
			state: createRangeState(doc, { add_metadata: false }, [
				editorEditorField,
				editorInfoField.init(() => (<any> { app: { workspace: { activeEditor: null } } })),
				remembered,
				mode,
			]),
		});
		view.dispatch({ selection: EditorSelection.cursor(at) });
		view.dispatch(view.state.update({
			changes: { from: at, insert: "()" },
			selection: EditorSelection.cursor(at + 1),
			effects: closedAt.of(at + 1),
			userEvent: "input.type",
		}));
		const result = {
			doc: view.state.doc.toString(),
			head: view.state.selection.main.head,
			closer: view.state.field(remembered),
		};
		view.destroy();
		return result;
	}

	test.each([
		["Suggest mode, starting an addition", "Para.", 5, suggestionMode(settings), "Para.{++()++}"],
		["Suggest mode, in one's own addition", "x{++ y++}", 6, suggestionMode(settings), "x{++ y()++}"],
		["Editing mode", "Para.", 5, editMode(settings), "Para.()"],
		["Editing mode, next to a range", "{++a++} b", 9, editMode(settings), "{++a++} b()"],
	])("%s", (_, doc, at, mode, expected) => {
		const result = typePair(doc, at, mode);
		expect(result.doc).toBe(expected);
		expect(result.closer).toBe(result.head);
		expect(result.doc[result.head]).toBe(")");
	});
});

test("Suggest mode keeps an auto-paired closer's position while typing inside the pair", () => {
	const closedAt = StateEffect.define<number>({ map: (pos, mapping) => mapping.mapPos(pos) });
	const remembered = StateField.define<number | null>({
		create: () => null,
		update: (value, tr) => {
			for (const effect of tr.effects) if (effect.is(closedAt)) return effect.value;
			return value === null ? null : tr.changes.mapPos(value, 1, MapMode.TrackDel);
		},
	});
	const view = new EditorView({
		state: createRangeState("Para.", { add_metadata: false }, [
			editorEditorField,
			remembered,
			suggestionMode(settings),
		]),
	});
	view.dispatch({ selection: EditorSelection.cursor(5) });
	view.dispatch(view.state.update({
		changes: { from: 5, insert: "()" },
		selection: EditorSelection.cursor(6),
		effects: closedAt.of(6),
		userEvent: "input.type",
	}));
	for (const ch of "ab") {
		const head = view.state.selection.main.head;
		view.dispatch(view.state.update({
			changes: { from: head, insert: ch },
			selection: EditorSelection.cursor(head + 1),
			userEvent: "input.type",
		}));
	}
	expect(view.state.doc.toString()).toBe("Para.{++(ab)++}");
	// EXPL: Still found (not deleted with a rewritten range), and right before the `)`.
	expect(view.state.field(remembered)).toBe(view.state.doc.toString().indexOf(")"));
	view.destroy();
});
