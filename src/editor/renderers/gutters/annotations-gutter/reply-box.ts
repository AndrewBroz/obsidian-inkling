import { type App, Component } from "obsidian";

import { PLUGIN_ID } from "../../../../plugin-id";
import { EmbeddableMarkdownEditor } from "../../../../ui/embeddable-editor";

export interface ReplyBoxOptions {
	placeholder: string;
	/**
	 * Text to open with. Non-empty when a card is REBUILT around an in-progress reply (see
	 * AnnotationMarker.toDOM) — the box is a fresh object, but the user's words are not.
	 */
	value?: string;
	/**
	 * Whether the box's editor grabs focus as soon as it finishes loading. Defaults to true.
	 * Pass false when the box is being built INSIDE toDOM() -- its container is not attached to
	 * the document yet at that point, so focusing then is a silent no-op. The caller is expected
	 * to call this box's own `focus()` once its DOM is actually attached (see
	 * PendingAnnotationMarker.afterAttach).
	 */
	focus?: boolean;
	/**
	 * Whether losing focus with text in the box commits it, as Enter does. Off by default: a reply
	 * to an existing thread keeps its box open on blur. The comment draft turns it on, because a
	 * draft left standing has nowhere to go and blocks every new comment.
	 */
	commitOnBlur?: boolean;
	/** Returns true if the text was accepted and written; false for blank/rejected input. */
	onCommit: (text: string) => boolean;
	onDismiss: () => void;
}

/**
 * The always-one-click-away reply input at the foot of a gutter thread card.
 *
 * EXPL: Enter submits and Shift+Enter newlines, the convention every comment editor shares
 *       (enterSubmits, comment-keys.ts). This box keeps its own onEnter for the `committing` latch.
 *       Returning true from onEnter means "handled, don't insert a newline"; returning false lets
 *       CodeMirror insert one. That single hook is the whole keybinding — no custom keymap.
 *
 * EXPL: Blur dismisses an empty (or whitespace-only) box. With text in it, a reply box stays
 *       standing, so clicking into the note to check a word cannot silently commit a half-written
 *       reply; a box opened with `commitOnBlur` (the new-comment draft) commits instead, exactly as
 *       Enter would; for that box, blur caused by the WINDOW losing focus (switching apps) neither
 *       commits nor discards, since focus comes back to the box with the window.
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

	/**
	 * Focuses this box's editor. Only meaningful once this box's own DOM is actually attached to
	 * the document -- see the `focus` option above and PendingAnnotationMarker.afterAttach, the
	 * caller that uses this to escape the toDOM()-time no-op.
	 */
	focus() {
		this.editor?.focus();
	}

	onload() {
		super.onload();

		this.editor = this.addChild(
			new EmbeddableMarkdownEditor(this.app, this.container, {
				value: this.options.value ?? "",
				cls: "cmtr-anno-gutter-reply-editor",
				placeholder: this.options.placeholder,
				focus: this.options.focus ?? true,
				filteredExtensions: [this.app.plugins.plugins[PLUGIN_ID].editorExtensions],

				onEnter: (editor, _mod, shift) => {
					if (shift)
						return false;
					this.commit(editor.get());
					return true;
				},

				onEscape: () => {
					this.options.onDismiss();
				},

				onBlur: (editor) => {
					if (this.committing)
						return;
					// EXPL: The window losing focus (switching apps) blurs the box too, but the user has not
					//       left the draft: focus comes back to the box with the window.
					if (this.options.commitOnBlur && !this.container.ownerDocument.hasFocus())
						return;
					const text = editor.get();
					if (!text.trim())
						this.options.onDismiss();
					else if (this.options.commitOnBlur)
						this.commit(text);
				},
			}),
		);
	}

	private commit(text: string) {
		if (this.committing)
			return;
		// EXPL: Latch BEFORE dispatching (never after): the commit dispatch is synchronous and can
		//       tear this component down from inside this very call, re-entering here via the
		//       teardown blur.
		this.committing = true;
		if (!this.options.onCommit(text))
			this.committing = false;
	}

	onunload() {
		super.onunload();
		this.editor = null;
		this.container.remove();
	}
}
