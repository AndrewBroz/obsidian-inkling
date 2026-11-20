import { type App, MarkdownView, Notice } from "obsidian";

import { ChangeSet, type Extension, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import type CommentatorPlugin from "../../main";
import type { PluginSettings } from "../../types";
import { cleanupChanges } from "../base/edit-logic";
import { pluginEditAnnotation } from "./extensions/editing-modes";

// EXPL: Runs the conservative cleanup (see cleanup.ts) on the note the user is looking at: when it opens or becomes
//       active, after it changes from outside the editor (sync), and by command. Only the active editor is ever
//       touched, never a file on disk, and every run is one undoable transaction. See "G4" in
//       docs/superpowers/specs/2026-11-20-0.13.0-stable-design.md.

// EXPL: Removing a fragment can expose another (`{+{+++` becomes `{++`). A few passes per run settle that; the cap
//       means a run always ends, and a later run finding nothing produces no transaction, so runs cannot loop.
const MAX_PASSES = 3;

/** How long the user must be idle before automatic cleanup runs. */
const IDLE_MS = 2000;

export function cleanupNotice(count: number): string {
	return `Inkling cleaned ${count} broken markup fragment${count === 1 ? "" : "s"}. Undo to restore.`;
}

/**
 * Removes broken markup from `view` in one undoable transaction, tagged so suggest mode does not wrap it.
 * Dispatches nothing when the document is clean.
 * @returns The number of fragments removed.
 */
export function cleanupView(view: EditorView, settings: PluginSettings): number {
	let doc = view.state.doc;
	let changes = ChangeSet.empty(doc.length);
	let count = 0;
	for (let pass = 0; pass < MAX_PASSES; pass++) {
		const result = cleanupChanges(doc.toString(), settings);
		if (!result.count) break;
		const step = ChangeSet.of(result.changes, doc.length);
		changes = changes.compose(step);
		doc = step.apply(doc);
		count += result.count;
	}
	if (count)
		view.dispatch({ changes, annotations: [pluginEditAnnotation.of(true)] });
	return count;
}

/** Typing, deleting, undo or redo: the user is working in the note, so automatic cleanup waits. */
export function isTyping(tr: Transaction): boolean {
	return tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("undo") || tr.isUserEvent("redo");
}

/**
 * A document change that neither the user nor Inkling made: Obsidian reloading the note after sync or another app
 * changed the file.
 * @remark Undo is a user event, so undoing a cleanup does not trigger another one.
 */
export function isExternalChange(tr: Transaction): boolean {
	return tr.docChanged && !tr.annotation(pluginEditAnnotation) &&
		!["input", "delete", "move", "undo", "redo"].some(event => tr.isUserEvent(event));
}

/**
 * Runs `run` once the user has been idle for `idle_ms` after a `request`. Typing reschedules a pending run rather
 * than dropping it; repeated requests run once.
 */
export class CleanupScheduler {
	private pending = false;
	private last_activity = -Infinity;
	private timer: number | undefined;

	constructor(private run: () => void, private now: () => number = Date.now, private idle_ms = IDLE_MS) {}

	noteTyping(): void {
		this.last_activity = this.now();
	}

	request(): void {
		this.pending = true;
		this.last_activity = Math.max(this.last_activity, this.now());
		this.arm(this.idle_ms);
	}

	dispose(): void {
		this.pending = false;
		window.clearTimeout(this.timer);
		this.timer = undefined;
	}

	private arm(delay: number) {
		window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => this.fire(), delay);
	}

	private fire() {
		this.timer = undefined;
		if (!this.pending) return;
		const wait = this.last_activity + this.idle_ms - this.now();
		if (wait > 0) {
			this.arm(wait);
			return;
		}
		this.pending = false;
		this.run();
	}
}

/** The editor of the active Markdown note in source or live preview, if any. */
function activeEditor(app: App): EditorView | undefined {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	return view && view.getMode() === "source" ? view.editor.cm : undefined;
}

/**
 * Wires automatic cleanup into the workspace, gated by `cleanup_broken_markup`.
 * @returns The editor extension that reports typing and external changes; register it with the editor extensions.
 */
export function cleanupTrigger(plugin: CommentatorPlugin): Extension {
	// EXPL: The active editor is looked up when the run fires, not when it was requested, so a note the user has
	//       since left is never cleaned.
	const scheduler = new CleanupScheduler(() => {
		const view = plugin.settings.cleanup_broken_markup ? activeEditor(plugin.app) : undefined;
		if (!view) return;
		const count = cleanupView(view, plugin.settings);
		if (count) new Notice(cleanupNotice(count));
	});
	plugin.register(() => scheduler.dispose());

	const request = () => {
		if (plugin.settings.cleanup_broken_markup && activeEditor(plugin.app)) scheduler.request();
	};
	plugin.registerEvent(plugin.app.workspace.on("file-open", request));
	plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", request));
	// EXPL: The note restored at startup was opened before the plugin loaded.
	plugin.app.workspace.onLayoutReady(request);

	// EXPL: Inkling's own helpers (the bracket auto-closer) dispatch without a user event while the user types, so a
	//       change only counts as external once the user has been idle for a while.
	let last_typing = -Infinity;
	return EditorView.updateListener.of(update => {
		if (update.transactions.some(isTyping)) {
			last_typing = Date.now();
			scheduler.noteTyping();
		} else if (
			update.transactions.some(isExternalChange) && Date.now() - last_typing >= IDLE_MS &&
			update.view === activeEditor(plugin.app)
		) {
			request();
		}
	});
}
