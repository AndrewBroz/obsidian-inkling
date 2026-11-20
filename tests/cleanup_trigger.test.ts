import { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorEditorField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { cleanupChanges } from "../src/editor/base/edit-logic";
import {
	CleanupScheduler,
	CleanupUndoTracker,
	cleanupView,
	isExternalChange,
	isTyping,
} from "../src/editor/uix/cleanup-trigger";
import { suggestionMode } from "../src/editor/uix/extensions";
import { pluginEditAnnotation } from "../src/editor/uix/extensions/editing-modes";
import { createRangeState } from "./helpers";

function viewOf(doc: string, suggest = false): EditorView {
	return new EditorView({
		state: createRangeState(
			doc,
			{ add_metadata: false },
			suggest ? [editorEditorField, suggestionMode({ ...DEFAULT_SETTINGS, add_metadata: false })] : [],
		),
	});
}

function spyTransactions(view: EditorView): Transaction[] {
	const seen: Transaction[] = [];
	const dispatch = view.dispatch.bind(view);
	jest.spyOn(view, "dispatch").mockImplementation((...args: any[]) => {
		const tr = args[0] instanceof Transaction ? args[0] : view.state.update(...args);
		seen.push(tr);
		dispatch(tr);
	});
	return seen;
}

describe("cleanupView", () => {
	test("dispatches once and is undoable", () => {
		const view = viewOf("a {++b");
		const seen = spyTransactions(view);
		expect(cleanupView(view, DEFAULT_SETTINGS)).toBe(1);
		expect(view.state.doc.toString()).toBe("a b");
		expect(seen).toHaveLength(1);
		expect(seen[0].annotation(pluginEditAnnotation)).toBe(true);
		expect(seen[0].annotation(Transaction.addToHistory)).not.toBe(false);
		expect(seen[0].changes.invert(seen[0].startState.doc).apply(view.state.doc).toString()).toBe("a {++b");
	});

	test("no transaction when clean", () => {
		const view = viewOf("a {++b++} c");
		const seen = spyTransactions(view);
		expect(cleanupView(view, DEFAULT_SETTINGS)).toBe(0);
		expect(seen).toHaveLength(0);
	});

	test("debris exposed by a removal is cleaned in the same transaction, without looping", () => {
		const doc = "a {+{+++ b";
		// EXPL: Guard the premise: a single run leaves debris behind for the next.
		const once = cleanupChanges(doc, DEFAULT_SETTINGS);
		const after = [...once.changes].reverse().reduce((t, c) => t.slice(0, c.from) + t.slice(c.to), doc);
		expect(cleanupChanges(after, DEFAULT_SETTINGS).count).toBeGreaterThan(0);

		const view = viewOf(doc);
		const seen = spyTransactions(view);
		expect(cleanupView(view, DEFAULT_SETTINGS)).toBeGreaterThan(once.count);
		expect(seen).toHaveLength(1);
		expect(cleanupChanges(view.state.doc.toString(), DEFAULT_SETTINGS).count).toBe(0);
		expect(view.state.doc.toString()).toBe("a  b");
	});

	test("suggest mode doesn't wrap cleanup", () => {
		const view = viewOf("a {++b", true);
		expect(cleanupView(view, DEFAULT_SETTINGS)).toBe(1);
		expect(view.state.doc.toString()).toBe("a b");
		expect(view.state.doc.toString()).not.toContain("{--");
	});
});

describe("CleanupScheduler", () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	test("rescheduled while typing; no transaction when clean", () => {
		const view = viewOf("a {++b");
		const seen = spyTransactions(view);
		let runs = 0;
		const scheduler = new CleanupScheduler(() => {
			runs++;
			cleanupView(view, DEFAULT_SETTINGS);
		});

		scheduler.request();
		jest.advanceTimersByTime(1500);
		scheduler.noteTyping();
		jest.advanceTimersByTime(500);
		expect(runs).toBe(0);
		jest.advanceTimersByTime(1499);
		expect(runs).toBe(0);
		jest.advanceTimersByTime(1);
		expect(runs).toBe(1);
		expect(view.state.doc.toString()).toBe("a b");
		expect(seen).toHaveLength(1);

		scheduler.request();
		jest.advanceTimersByTime(2000);
		expect(runs).toBe(2);
		expect(seen).toHaveLength(1);
		scheduler.dispose();
	});

	test("typing alone never runs; dispose cancels a pending run", () => {
		const run = jest.fn();
		const scheduler = new CleanupScheduler(run);
		scheduler.noteTyping();
		jest.advanceTimersByTime(5000);
		expect(run).not.toHaveBeenCalled();

		scheduler.request();
		scheduler.dispose();
		jest.advanceTimersByTime(5000);
		expect(run).not.toHaveBeenCalled();
	});

	test("repeated requests run once", () => {
		const run = jest.fn();
		const scheduler = new CleanupScheduler(run);
		scheduler.request();
		jest.advanceTimersByTime(1000);
		scheduler.request();
		jest.advanceTimersByTime(5000);
		expect(run).toHaveBeenCalledTimes(1);
		scheduler.dispose();
	});
});

describe("transaction classification", () => {
	const view = () => viewOf("hello");

	test("typing, deleting, undo and redo count as typing; cleanup's own edit does not", () => {
		const state = view().state;
		expect(isTyping(state.update({ changes: { from: 0, insert: "x" }, userEvent: "input.type" }))).toBe(true);
		expect(isTyping(state.update({ changes: { from: 0, to: 1 }, userEvent: "delete.backward" }))).toBe(true);
		expect(isTyping(state.update({ changes: { from: 0, insert: "x" }, userEvent: "undo" }))).toBe(true);
		expect(isTyping(state.update({ changes: { from: 0, insert: "x" }, userEvent: "redo" }))).toBe(true);
		expect(isTyping(state.update({ changes: { from: 0, to: 1 }, annotations: [pluginEditAnnotation.of(true)] })))
			.toBe(false);
		expect(isTyping(state.update({ selection: { anchor: 1 }, userEvent: "select" }))).toBe(false);
	});

	test("a doc change with no user event and not ours is external", () => {
		const state = view().state;
		expect(isExternalChange(state.update({ changes: { from: 0, insert: "x" } }))).toBe(true);
		expect(isExternalChange(state.update({ changes: { from: 0, insert: "x" }, userEvent: "input.paste" }))).toBe(false);
		expect(isExternalChange(state.update({ changes: { from: 0, insert: "x" }, userEvent: "move.drop" }))).toBe(false);
		expect(isExternalChange(state.update({ changes: { from: 0, insert: "x" }, userEvent: "undo" }))).toBe(false);
		expect(
			isExternalChange(state.update({ changes: { from: 0, to: 1 }, annotations: [pluginEditAnnotation.of(true)] })),
		)
			.toBe(false);
		expect(isExternalChange(state.update({ selection: { anchor: 1 } }))).toBe(false);
	});
});

describe("CleanupUndoTracker", () => {
	// EXPL: Feeds every transaction of `view` to the tracker, as the trigger's update listener does.
	function tracked(doc: string, tracker: CleanupUndoTracker): EditorView {
		const view = viewOf(doc);
		const dispatch = view.dispatch.bind(view);
		jest.spyOn(view, "dispatch").mockImplementation((...args: any[]) => {
			const tr = args[0] instanceof Transaction ? args[0] : view.state.update(...args);
			tracker.observe(view, "note.md", tr);
			dispatch(tr);
		});
		return view;
	}

	function undo(view: EditorView, before: string) {
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: before }, userEvent: "undo" });
	}

	test("undoing a cleanup marks the file to be skipped", () => {
		const tracker = new CleanupUndoTracker();
		const view = tracked("a {++b", tracker);
		cleanupView(view, DEFAULT_SETTINGS);
		expect(tracker.skips("note.md")).toBe(false);
		undo(view, "a {++b");
		expect(tracker.skips("note.md")).toBe(true);
		expect(tracker.skips("other.md")).toBe(false);
	});

	test("an undo after another change does not count", () => {
		const tracker = new CleanupUndoTracker();
		const view = tracked("a {++b", tracker);
		cleanupView(view, DEFAULT_SETTINGS);
		view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });
		undo(view, "a b");
		expect(tracker.skips("note.md")).toBe(false);
	});

	test("an undo without a cleanup does not count", () => {
		const tracker = new CleanupUndoTracker();
		const view = tracked("a b", tracker);
		view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });
		undo(view, "a b");
		expect(tracker.skips("note.md")).toBe(false);
	});

	test("only the first undo after a cleanup counts", () => {
		const tracker = new CleanupUndoTracker();
		const view = tracked("a {++b", tracker);
		cleanupView(view, DEFAULT_SETTINGS);
		view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "redo" });
		undo(view, "a b");
		expect(tracker.skips("note.md")).toBe(false);
	});

	test("a cleanup in another editor does not arm this one", () => {
		const tracker = new CleanupUndoTracker();
		const view = viewOf("a {++b");
		const seen = spyTransactions(view);
		cleanupView(view, DEFAULT_SETTINGS);
		tracker.observe({}, "other.md", seen[0]);
		tracker.observe(view, "note.md", view.state.update({ changes: { from: 0, insert: "x" }, userEvent: "undo" }));
		expect(tracker.skips("note.md")).toBe(false);
		expect(tracker.skips("other.md")).toBe(false);
	});

	test("forget clears the file", () => {
		const tracker = new CleanupUndoTracker();
		const view = tracked("a {++b", tracker);
		cleanupView(view, DEFAULT_SETTINGS);
		undo(view, "a {++b");
		tracker.forget("note.md");
		expect(tracker.skips("note.md")).toBe(false);
	});
});
