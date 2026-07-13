import { type App, Component } from "obsidian";

import { EmbeddableMarkdownEditor } from "../../../../ui/embeddable-editor";

export interface ReplyBoxOptions {
	placeholder: string;
	/**
	 * Text to open with. Non-empty when a card is REBUILT around an in-progress reply (see
	 * AnnotationMarker.toDOM) — the box is a fresh object, but the user's words are not.
	 */
	value?: string;
	/** Returns true if the text was accepted and written; false for blank/rejected input. */
	onCommit: (text: string) => boolean;
	onDismiss: () => void;
}

/**
 * The always-one-click-away reply input at the foot of a gutter thread card.
 *
 * EXPL: Enter submits and Shift+Enter newlines, which inverts EmbeddableMarkdownEditor's default
 *       (`onEnter` ships as "Mod+Enter submits, bare Enter newlines" — embeddable-editor.ts:66-70).
 *       Returning true from onEnter means "handled, don't insert a newline"; returning false lets
 *       CodeMirror insert one. That single hook is the whole keybinding — no custom keymap.
 *
 * EXPL: Blur NEVER writes. It dismisses only when the box is empty; a blur with text in it leaves
 *       the box standing, so clicking into the note to check a word cannot silently commit a
 *       half-written reply. This deliberately diverges from AnnotationNode's editor, which saves on
 *       blur — that one is editing text the document already holds, this one is composing text the
 *       document has never seen.
 *
 * EXPL: `committing` latches the submit path. A successful commit dispatches synchronously, which
 *       rebuilds the gutter and tears this box down; teardown removes the editor from the DOM, and
 *       Chrome fires a native blur on removal. Without the latch, that blur could re-enter onCommit
 *       /onDismiss during our own unload — the same re-entrancy class that AnnotationNode's
 *       `cancelling` latch guards (marker.ts:138-171).
 */
export class ReplyBox extends Component {
	editor: EmbeddableMarkdownEditor | null = null;
	committing = false;

	constructor(
		public app: App,
		public container: HTMLElement,
		public options: ReplyBoxOptions,
	) {
		super();
	}

	/**
	 * The text currently in the box.
	 *
	 * EXPL: Read it BEFORE unloading — `onunload` drops the editor, and with it the only copy of
	 *       whatever the user had typed. AnnotationMarker/PendingAnnotationMarker call this on their
	 *       way into a rebuild so a gutter re-home cannot swallow an in-progress comment.
	 */
	text(): string {
		return this.editor?.get() ?? "";
	}

	onload() {
		super.onload();

		this.editor = this.addChild(
			new EmbeddableMarkdownEditor(this.app, this.container, {
				value: this.options.value ?? "",
				cls: "cmtr-anno-gutter-reply-editor",
				placeholder: this.options.placeholder,
				focus: true,
				filteredExtensions: [this.app.plugins.plugins["inkling"].editorExtensions],

				onEnter: (editor, _mod, shift) => {
					if (shift)
						return false;
					if (this.committing)
						return true;

					// EXPL: Latch BEFORE dispatching (never after): the commit dispatch is synchronous
					//       and can tear this component down from inside this very call, re-entering
					//       here via the teardown blur.
					this.committing = true;
					if (!this.options.onCommit(editor.get()))
						this.committing = false;
					return true;
				},

				onEscape: () => {
					this.options.onDismiss();
				},

				onBlur: (editor) => {
					if (this.committing)
						return;
					if (!editor.get().trim())
						this.options.onDismiss();
				},
			}),
		);
	}

	onunload() {
		super.onunload();
		this.editor = null;
		this.container.remove();
	}
}
