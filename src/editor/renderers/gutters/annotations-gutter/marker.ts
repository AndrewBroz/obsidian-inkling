import { type EditorState, Range, RangeSet, StateField } from "@codemirror/state";
import { EditorView, GutterMarker } from "@codemirror/view";

import { Component, editorEditorField, editorInfoField, MarkdownRenderer, Menu, Notice, setIcon } from "obsidian";

import { EmbeddableMarkdownEditor } from "../../../../ui/embeddable-editor";

import {
	acceptSuggestions,
	addCommentToView,
	cancel_empty_comment,
	comment_text_rejected,
	type CommentRange,
	commitReply,
	create_range,
	CriticMarkupRange,
	type EditorChange,
	rangeParser,
	rejectSuggestions,
	resolve_thread,
	SuggestionType,
	thread_resolvable,
	thread_resolved,
} from "../../../base";

import { AnnotationInclusionType } from "../../../../constants";
import { pluginEditAnnotation } from "../../../uix/extensions/editing-modes";
import { annotationGutterIncludedTypes, annotationGutterIncludedTypesState } from "../../../settings";
import { annotationGutterFocusThreadAnnotation, annotationGutterFoldAnnotation } from "./annotation-gutter";
import { ReplyBox } from "./reply-box";

import { stickyContextMenuPatch } from "../../../../patches";
import { createMetadataInfoElement } from "../../../../ui/snippets";
import { pluginSettingsField } from "../../../uix";

/**
 * Computes the changes that delete an entire annotation thread.
 * - COMMENT base: the whole thread span (base + replies) is removed.
 * - HIGHLIGHT base: the highlight is unwrapped to plain text and its replies are removed.
 * - Suggestion bases (addition/deletion/substitution): only the attached comments are removed,
 *   the suggestion markup itself is kept.
 */
function removeThreadChanges(range: CriticMarkupRange): EditorChange[] {
	const base = range.base_range;
	if (base.type === SuggestionType.COMMENT)
		return [{ from: base.full_range_front, to: base.full_range_back, insert: "" }];
	if (base.type === SuggestionType.HIGHLIGHT)
		return [{ from: base.from, to: base.full_range_back, insert: base.unwrap() }];
	if (base.replies.length) {
		return [{
			from: base.replies[0].from,
			to: base.replies[base.replies.length - 1].to,
			insert: "",
		}];
	}
	return [];
}

class AnnotationNode extends Component {
	text: string;
	new_text: string | null = null;
	// EXPL: Guards the empty-comment auto-cancel dispatch against firing twice when both
	//       onSubmit and onBlur (or the container's own "blur" listener) fire for one action —
	//       same double-call concern the write path below guards against.
	cancelling = false;
	annotation_container: HTMLElement;
	metadata_view: HTMLElement | null = null;
	annotation_view: HTMLElement;

	currentMode: "preview" | "source" | null = null;
	editMode: EmbeddableMarkdownEditor | null = null;

	constructor(public range: CriticMarkupRange, public marker: AnnotationMarker) {
		super();

		this.text = range.unwrap();

		this.annotation_container = this.marker.annotation_thread.createDiv({ cls: "cmtr-anno-gutter-annotation" });
		this.annotation_container.addEventListener("blur", this.renderPreview.bind(this));
		this.annotation_container.addEventListener("dblclick", this.renderSource.bind(this));
		this.annotation_container.addEventListener("contextmenu", this.onCommentContextmenu.bind(this));

		if (this.range.metadata) {
			this.metadata_view = createMetadataInfoElement(this.range);
			this.annotation_container.appendChild(this.metadata_view);
		}

		this.annotation_view = this.annotation_container.createDiv({ cls: "cmtr-anno-gutter-annotation-view" });
		this.renderPreview();
	}

	onload() {
		super.onload();
	}

	onunload() {
		super.onunload();

		this.annotation_container.remove();
		this.editMode = null;
	}

	renderSource(e?: MouseEvent) {
		if (this.range.type !== SuggestionType.COMMENT) {
			// TODO: Should editing non-comments within the annotation gutter be allowed?
			new Notice("[Inkling] You can only edit comments.");
		} else {
			e?.stopPropagation();
			if (this.currentMode === "source") return;

			const { app } = this.marker.view.state.field(editorInfoField);
			this.annotation_container.toggleClass("cmtr-anno-gutter-annotation-editing", true);
			if (this.range.fields.author && this.range.fields.author !== app.plugins.plugins.inkling.settings.author) {
				new Notice("[Inkling] You cannot edit comments from other authors.");
				return;
			}

			this.annotation_view.empty();
			this.editMode = this.addChild(
				new EmbeddableMarkdownEditor(app, this.annotation_view, {
					value: this.text,
					cls: "cmtr-anno-gutter-annotation-editor",
					onSubmit: (editor) => {
						this.new_text = editor.get();
						this.renderPreview();
					},
					filteredExtensions: [app.plugins.plugins["inkling"].editorExtensions],
					onBlur: (editor) => {
						// Save on blur (same as onSubmit)
						this.new_text = editor.get();
						this.renderPreview();
					},
				}),
			);
			this.currentMode = "source";
		}
	}

	renderPreview() {
		if (this.currentMode === "preview") return;

		// EXPL: The card's comment editor is a `create_range` sink like any other: `<<}` typed into
		//       an existing comment truncates it and strands a dangling `<<}` in the note, `@@` eats
		//       the comment's own metadata. Refuse the write and stay in source mode — the editor
		//       still holds the user's text, so they can fix it (the Notice names the sequence).
		//       `new_text` is dropped so a straggler blur does not re-run the write with the same
		//       rejected content; the DOM, not this field, is the editor's source of truth.
		if (this.new_text !== null && comment_text_rejected(this.new_text)) {
			this.new_text = null;
			return;
		}

		// EXPL: On accepting a new comment (on mod+enter), this function gets called twice:
		//       once for the immediate user event, and again when the write dispatch below rebuilds
		//       the gutter (editor teardown can re-enter via a native blur). The second call must
		//       not dispatch again: the write branch sets `text = new_text` BEFORE dispatching, so
		//       the re-entrant call takes the equal-text render branch above it; the empty-cancel
		//       branch is latched by `cancelling` for the same reason.
		this.annotation_container.toggleClass("cmtr-anno-gutter-annotation-editing", false);

		// EXPL: An empty submit/blur is routed here before the write path below, since renderPreview
		//       is the single choke point every caller (onSubmit, onBlur, the container's own "blur"
		//       listener) funnels through:
		//        - comment was freshly created empty (`this.text` itself is still empty) -> silent
		//          auto-cancel via Task 1's cancel_empty_comment (mirrors the reply editor's guard in
		//          comment-widget.ts); guarded by `cancelling` against the same double-call concern the
		//          write path below already handles for non-empty saves.
		//        - comment already had content -> do not write; reset `new_text` to null so the branch
		//          below takes the regular re-render path and shows the still-current `text` (revert).
		if (this.new_text !== null && !this.new_text.trim()) {
			if (!this.text.trim()) {
				if (!this.cancelling) {
					// EXPL: Latch and clear state BEFORE dispatching, then dispatch SYNCHRONOUSLY
					//       (dispatch-first, same ordering as comment-widget.ts's commitRangeEdit):
					//       range.from/to are only valid in the CURRENT document. A deferred dispatch
					//       raced the card buttons' synchronous dispatches (mousedown blurs the editor
					//       before click fires), splicing stale offsets through the fresh transaction.
					this.cancelling = true;
					this.new_text = null;
					this.marker.view.dispatch({
						changes: cancel_empty_comment(this.range as CommentRange),
						annotations: [pluginEditAnnotation.of(true)],
					});
				}
				this.new_text = null;
				return;
			}
			this.new_text = null;
		}

		// EXPL: Regular (re-)rendering of the annotation
		if (this.text === this.new_text || this.new_text === null) {
			const { app } = this.marker.view.state.field(editorInfoField);
			this.new_text = null;
			if (this.editMode) {
				this.removeChild(this.editMode);
				this.editMode = null;
			}
			this.annotation_view.empty();
			if (this.range.type !== SuggestionType.SUBSTITUTION) {
				let description = "";
				switch (this.range.type) {
					case SuggestionType.ADDITION:
						description = "Added: ";
						break;
					case SuggestionType.DELETION:
						description = "Deleted: ";
						break;
					case SuggestionType.HIGHLIGHT:
						break;
					case SuggestionType.COMMENT:
						break;
				}
				const contents = createDiv({ cls: "cmtr-anno-gutter-annotation-content" });
				MarkdownRenderer.render(app, this.text || "&nbsp;", contents, "", this).then(() => {
					(contents.children[0] ?? contents).prepend(
						createSpan({ cls: "cmtr-anno-gutter-annotation-desc", text: description }),
					);
					this.annotation_view.append(...contents.childNodes as unknown as Node[]);
					contents.remove();
				});
			} else {
				const text_slices = this.range.unwrap_parts();
				const contents_from = createDiv(), contents_to = createDiv();
				MarkdownRenderer.render(app, text_slices[0] || "&nbsp;", contents_from, "", this).then(() => {
					(contents_from.children[0] ?? contents_from).prepend(
						createSpan({ cls: "cmtr-anno-gutter-annotation-desc", text: "Changed: " }),
					);
					this.annotation_view.append(...contents_from.childNodes as unknown as Node[]);
					MarkdownRenderer.render(app, text_slices[1] || "&nbsp;", contents_to, "", this).then(() => {
						(contents_to.children[0] ?? contents_to).prepend(
							createSpan({ cls: "cmtr-anno-gutter-annotation-desc", text: "To: " }),
						);
						this.annotation_view.append(...contents_to.childNodes as unknown as Node[]);
						contents_from.remove();
						contents_to.remove();
					});
				});
			}

			this.annotation_view.addClass("cmtr-anno-gutter-annotation-" + this.range.type);
			this.currentMode = "preview";
		} // EXPL: The annotation gets updated with new text
		else {
			const settings = this.marker.view.state.field(pluginSettingsField);
			// EXPL: Snapshot the change while range.from/to are still valid, set `text = new_text`
			//       (the double-call guard for the re-entrant call described above), then dispatch
			//       SYNCHRONOUSLY. The previous deferred dispatch raced the card buttons' synchronous
			//       resolve/delete dispatches (mousedown blurs the open editor before click fires),
			//       applying pre-resolve offsets to the post-resolve document and corrupting text.
			const changes = {
				from: this.range.from,
				to: this.range.to,
				insert: create_range(settings, SuggestionType.COMMENT, this.new_text),
			};
			this.text = this.new_text;
			this.marker.view.dispatch({ changes, annotations: [pluginEditAnnotation.of(true)] });
		}
	}

	onCommentContextmenu(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();

		stickyContextMenuPatch(true);

		const menu = new Menu();
		if (this.range.type !== SuggestionType.COMMENT && this.range.type !== SuggestionType.HIGHLIGHT) {
			menu.addItem((item) => {
				item.setTitle("Accept changes")
					.setIcon("check")
					.setSection("close-annotation")
					.onClick(() => {
						this.marker.view.dispatch({
							changes: acceptSuggestions(this.marker.view.state, this.range.from, this.range.to),
							annotations: [pluginEditAnnotation.of(true)],
						});
					});
			});
			menu.addItem((item) => {
				item.setTitle("Reject changes")
					.setIcon("cross")
					.setSection("close-annotation")
					.onClick(() => {
						this.marker.view.dispatch({
							changes: rejectSuggestions(this.marker.view.state, this.range.from, this.range.to),
							annotations: [pluginEditAnnotation.of(true)],
						});
					});
			});
		}

		if (this.range.type === SuggestionType.COMMENT) {
			if (this.range.replies.length > 0) {
				menu.addItem((item) => {
					item.setTitle("Close comment thread")
						.setIcon("message-square-off")
						.setSection("close-annotation")
						.onClick(() => {
							this.marker.view.dispatch({
								changes: removeThreadChanges(this.range),
								annotations: [pluginEditAnnotation.of(true)],
							});
						});
				});
			}

			menu.addItem((item) => {
				item.setTitle("Add reply")
					.setSection("comment-handling")
					.setIcon("reply")
					.onClick(() => {
						addCommentToView(this.marker.view, this.range);
					});
			});

			menu.addItem((item) => {
				item.setTitle("Edit comment")
					.setIcon("pencil")
					.setSection("comment-handling")
					.onClick(() => {
						this.renderSource();
					});
			});

			// TODO: When removing comments, use a handler function that determines whether it should be archived or not
			menu.addItem((item) => {
				item.setTitle("Remove comment")
					.setIcon("cross")
					.setSection("comment-handling")
					.onClick(() => {
						this.marker.view.dispatch({
							changes: { from: this.range.from, to: this.range.to, insert: "" },
							annotations: [pluginEditAnnotation.of(true)],
						});
					});
			});
		} else if (this.range.type !== SuggestionType.HIGHLIGHT) {
			menu.addItem((item) => {
				item.setTitle("Add reply")
					.setSection("comment-handling")
					.setIcon("reply")
					.onClick(() => {
						addCommentToView(this.marker.view, this.range);
					});
			});

			if (this.range.replies.length > 0) {
				menu.addItem((item) => {
					item.setTitle("Remove all comments")
						.setIcon("message-square-x")
						.setSection("comment-handling")
						.onClick(() => {
							this.marker.view.dispatch({
								changes: removeThreadChanges(this.range),
								annotations: [pluginEditAnnotation.of(true)],
							});
						});
				});
			}
		} else {
			menu.addItem((item) => {
				item.setTitle("Add reply")
					.setSection("comment-handling")
					.setIcon("reply")
					.onClick(() => {
						addCommentToView(this.marker.view, this.range);
					});
			});
		}

		// EXPL: Resolve is a comment-thread concept (HIGHLIGHT/COMMENT base only, see
		//       `thread_resolvable`) — suggestion threads are closed via accept/reject instead.
		//       No "Reopen thread" counterpart here: resolved comment/anchored threads never render
		//       a gutter card (see `createMarkers`), so a resolved thread can't open this menu —
		//       reopen lives in the Annotations View (Resolved filter) and the editor context menu.
		if (thread_resolvable(this.range)) {
			menu.addItem((item) => {
				item.setTitle("Resolve thread")
					.setIcon("check")
					.setSection("close-annotation")
					.onClick(() => {
						this.marker.view.dispatch({
							changes: resolve_thread(this.range),
							annotations: [pluginEditAnnotation.of(true)],
						});
					});
			});
		}

		menu.addItem((item) => {
			item.setTitle("Fold gutter")
				.setSection("gutter-controls")
				.setIcon("arrow-right-from-line")
				.onClick(() => {
					this.marker.view.dispatch({
						annotations: [annotationGutterFoldAnnotation.of(null)],
					});
				});
		});
		menu.addItem((item) => {
			const submenu = item.setTitle("Included annotations")
				.setIcon("eye")
				.setSection("gutter-controls")
				.setSubmenu();

			let current_settings = this.marker.view.state.facet(annotationGutterIncludedTypesState);

			for (
				const { title, icon, value } of [
					{ title: "Additions", icon: "plus-circle", value: AnnotationInclusionType.ADDITION },
					{ title: "Deletions", icon: "minus-square", value: AnnotationInclusionType.DELETION },
					{ title: "Substitutions", icon: "replace", value: AnnotationInclusionType.SUBSTITUTION },
					{ title: "Highlights", icon: "highlighter", value: AnnotationInclusionType.HIGHLIGHT },
					{ title: "Comments", icon: "message-square", value: AnnotationInclusionType.COMMENT },
				]
			) {
				submenu.addItem((item) => {
					item.setTitle(title)
						.setIcon(icon)
						.setChecked((current_settings & value) !== 0)
						.onClick(() => {
							current_settings ^= value;
							item.setChecked((current_settings & value) !== 0);
							this.marker.view.dispatch(this.marker.view.state.update({
								effects: [
									annotationGutterIncludedTypes.reconfigure(annotationGutterIncludedTypesState.of(current_settings)),
								],
							}));
						});
				});
			}
		});

		menu.showAtPosition(e);
	}
}

export class AnnotationMarker extends GutterMarker {
	annotation_thread!: HTMLElement;
	component: Component = new Component();
	preventUnload: boolean = false;
	reply_box: ReplyBox | null = null;
	/** In-progress reply text, cached across a card rebuild. @see toDOM */
	reply_text: string = "";
	/** Whether a reply box was open when the card was last torn down. @see toDOM */
	reply_open: boolean = false;
	/**
	 * Set by toDOM() when a reopened reply box is owed to this card once it is actually attached
	 * (see afterAttach below) -- showReplyBox() cannot run from inside toDOM() itself, since its
	 * return value is not attached to the document yet at that point.
	 */
	private reopen_on_attach: boolean = false;

	constructor(
		public annotation: CriticMarkupRange,
		public annotations: CriticMarkupRange[],
		public view: EditorView,
		public itr = 0,
	) {
		super();
	}

	eq(other: AnnotationMarker) {
		return this.itr === other.itr && this.annotations === other.annotations &&
			this.annotations[0].equals(other.annotations[0]);
	}

	onCommentThreadClick() {
		// EXPL: When the annotation gets focused, ensure that it is aligned to the block it is attached to,
		// 		 pushing other annotations up/down
		this.view.dispatch({
			annotations: [
				annotationGutterFocusThreadAnnotation.of({
					marker: this,
					index: -1,
					scroll: true,
					focus_markup: true,
				}),
			],
		});

		this.annotation_thread.classList.toggle("cmtr-anno-gutter-thread-highlight", true);

		this.showReplyBox();
	}

	// EXPL: Google-Docs behaviour — focusing a thread reveals its reply input. Idempotent: a second
	//       click on an already-open card must not stack a second editor onto the card.
	showReplyBox() {
		// EXPL: `pill_eligible` refuses to offer a NEW comment in a read-only editor, but nothing
		//       stopped a click on an existing card from opening a writable reply here — and
		//       `commitReply` dispatches programmatically, which CodeMirror's `readOnly` facet does
		//       not block. Refuse the box outright rather than showing one that will refuse to send.
		if (this.reply_box || this.view.state.readOnly)
			return;

		const { app } = this.view.state.field(editorInfoField);
		const container = this.annotation_thread.createDiv({ cls: "cmtr-anno-gutter-reply" });

		this.reply_open = true;
		this.reply_box = this.component.addChild(
			new ReplyBox(app, container, {
				placeholder: "Reply…",
				value: this.reply_text,
				onCommit: (text) => {
					// EXPL: Drop the cache BEFORE dispatching, restore it only if the write was
					//       refused. commitReply's dispatch is synchronous and rebuilds the gutter
					//       from inside this call, re-entering toDOM()/hideReplyBox() — with the
					//       cache still armed, that teardown would stash the text we just WROTE and
					//       re-open a box pre-filled with a duplicate of the reply.
					this.reply_text = "";
					this.reply_open = false;
					if (commitReply(this.view, this.annotation, text))
						return true;
					this.reply_text = text;
					this.reply_open = true;
					return false;
				},
				onDismiss: () => this.dismissReplyBox(),
			}),
		);
	}

	// EXPL: The user closing the box on purpose (Escape, or blurring it while empty) — unlike a
	//       structural teardown, this DISCARDS the in-progress text, so the card does not resurrect a
	//       reply the user just walked away from.
	dismissReplyBox() {
		this.reply_text = "";
		this.reply_open = false;
		this.hideReplyBox();
	}

	// EXPL: Clear the field BEFORE removing the child (never after): removeChild unloads the box,
	//       which pulls its editor out of the DOM, which makes Chrome fire a native blur that can
	//       re-enter here through onDismiss. Nulling first makes the re-entrant call a no-op —
	//       same state-before-teardown ordering as AnnotationNode's `cancelling` latch above.
	// EXPL: This is a TEARDOWN, not a dismissal: it runs when the card is rebuilt under the user
	//       (toDOM below) as well as when the card dies. So it saves the text on the way out —
	//       `reply_open` is the flag for "this box was live when we pulled it down", and toDOM uses
	//       it to put the box (and the words) back.
	hideReplyBox() {
		if (!this.reply_box)
			return;
		const reply_box = this.reply_box;
		if (this.reply_open)
			this.reply_text = reply_box.text();
		this.reply_box = null;
		this.component.removeChild(reply_box);
	}

	toDOM() {
		// EXPL: toDOM can run a SECOND time on this same instance: GutterElement.setMarkers
		//       (base.ts:168-190) re-homes a marker between GutterElements without calling
		//       destroy() when preventUnload is set (see that file's own FIXME at :172-180), then
		//       builds a fresh `annotation_thread` here. Without this reset, `reply_box` would
		//       still point at the container from the OLD (now-detached) annotation_thread, so
		//       showReplyBox()'s `if (this.reply_box) return;` guard would permanently refuse to
		//       ever open a reply box on the new card again.
		// EXPL: A re-home is INVISIBLE to the user — it fires whenever this marker's GutterElement
		//       index shifts, i.e. whenever an annotation above it appears or disappears, which is
		//       exactly what the "blur the box with text in it, go fix a word in the note" flow
		//       invites. Tearing the box down here is the right safety (it prevents an orphaned
		//       editor), but doing ONLY that would make a half-written reply vanish with no undo and
		//       no trace. hideReplyBox() now saves the text; the tail of this method puts it back.
		const reopen = this.reply_open;
		this.hideReplyBox();

		this.annotation_thread = createDiv({ cls: "cmtr-anno-gutter-thread" });
		this.annotation_thread.addEventListener("click", this.onCommentThreadClick.bind(this));

		// EXPL: Compact per-card actions (visible on hover/focus, see annotation-gutter.scss).
		//       Resolve is a comment-thread concept: only rendered when the base is a HIGHLIGHT anchor
		//       or a COMMENT. Suggestion bases (addition/deletion/substitution) get Accept/Reject
		//       instead, dispatching the same `acceptSuggestions`/`rejectSuggestions` helpers as the
		//       "Accept changes"/"Reject changes" context-menu items below, scoped to this thread's
		//       own span — a Resolve button there would contradict itself across views (suggestions
		//       have their own accept/reject lifecycle). Both branches reuse the same
		//       `.cmtr-anno-gutter-thread-actions` row/hover mechanism so suggestion cards get
		//       identical hover-reveal treatment to comment/anchored cards.
		//
		// EXPL: There is deliberately NO delete button here. Resolving is reversible (reopen from the
		//       Annotations View or the editor context menu); deleting a thread destroys the only copy
		//       of what people wrote, and `removeThreadChanges` on a HIGHLIGHT base also unwraps the
		//       anchor back into plain text. A one-click, hover-revealed control sitting a few pixels
		//       from Resolve is the wrong affordance for an action that severe — the two were adjacent
		//       icons distinguishable only by glyph. Deletion stays available, one step further away,
		//       via the card's context menu ("Remove comment" / "Remove all comments" below).
		if (thread_resolvable(this.annotation)) {
			const actions = this.annotation_thread.createDiv({ cls: "cmtr-anno-gutter-thread-actions" });
			const resolve_button = actions.createEl("button", {
				cls: ["cmtr-anno-gutter-thread-action", "clickable-icon"],
				attr: { "aria-label": "Resolve thread" },
			});
			setIcon(resolve_button, "check");
			resolve_button.addEventListener("click", (e) => {
				e.stopPropagation();
				this.view.dispatch({
					changes: resolve_thread(this.annotation),
					annotations: [pluginEditAnnotation.of(true)],
				});
			});
		} else if (
			this.annotation.type === SuggestionType.ADDITION ||
			this.annotation.type === SuggestionType.DELETION ||
			this.annotation.type === SuggestionType.SUBSTITUTION
		) {
			const actions = this.annotation_thread.createDiv({ cls: "cmtr-anno-gutter-thread-actions" });
			const accept_button = actions.createEl("button", {
				cls: ["cmtr-anno-gutter-thread-action", "clickable-icon"],
				attr: { "aria-label": "Accept changes" },
			});
			setIcon(accept_button, "check");
			accept_button.addEventListener("click", (e) => {
				e.stopPropagation();
				this.view.dispatch({
					changes: acceptSuggestions(this.view.state, this.annotation.from, this.annotation.to),
					annotations: [pluginEditAnnotation.of(true)],
				});
			});
			const reject_button = actions.createEl("button", {
				cls: ["cmtr-anno-gutter-thread-action", "clickable-icon"],
				attr: { "aria-label": "Reject changes" },
			});
			setIcon(reject_button, "x");
			reject_button.addEventListener("click", (e) => {
				e.stopPropagation();
				this.view.dispatch({
					changes: rejectSuggestions(this.view.state, this.annotation.from, this.annotation.to),
					annotations: [pluginEditAnnotation.of(true)],
				});
			});
		}

		for (const range of this.annotations)
			this.component.addChild(new AnnotationNode(range, this));
		this.component.load();

		// EXPL: showReplyBox() builds and focuses a box -- but `annotation_thread` has not been
		//       returned to insertBefore yet at this point, so its DOM is still disconnected and
		//       that focus would be a silent no-op. Defer to afterAttach(), which runs once
		//       GutterElement.setMarkers has actually attached this node. `reply_text` survived the
		//       hideReplyBox() above, so the box that opens there holds exactly what the user had
		//       typed.
		this.reopen_on_attach = reopen;

		return this.annotation_thread;
	}

	/**
	 * Called by GutterElement.setMarkers right after `insertBefore` -- but for THIS gutter that is
	 * not the same as "attached to the document". AnnotationUpdateContext (annotation-gutter.ts)
	 * builds a block's GutterElement DETACHED and only appends it to the live gutter tree later, in
	 * its `finish()` -- so a freshly-created block's `dom` is often still disconnected right here.
	 * Reopening (and focusing) a reply box from inside toDOM() is a silent no-op too: the node is
	 * not attached yet either way.
	 */
	afterAttach(dom: HTMLElement) {
		if (!this.reopen_on_attach) return;
		this.reopen_on_attach = false;

		if (dom.isConnected) {
			this.showReplyBox();
			return;
		}

		// Not attached yet -- defer to the next measure, by which point
		// AnnotationUpdateContext.finish() has appended this block's GutterElement to the live
		// gutter. Re-check that `dom` is still this card's CURRENT thread -- a further rebuild
		// (another re-home before this callback runs) would have replaced `annotation_thread`
		// with a fresh node, and this stale one must not be reopened.
		this.view.requestMeasure({
			read: () => {
				if (dom.isConnected && this.annotation_thread === dom)
					this.showReplyBox();
			},
		});
	}

	focus() {
		this.annotation_thread.focus();
	}

	focus_annotation(index: number = -1, scroll: boolean = false) {
		if (index === -1)
			this.annotation_thread.classList.toggle("cmtr-anno-gutter-thread-highlight", true);
		else if (index >= 0 && index < this.annotation_thread.children.length)
			this.annotation_thread.children.item(index)!.dispatchEvent(new MouseEvent("dblclick"));
		else
			console.error("[Inkling] Invalid index for focusing annotation:", index);

		if (scroll) {
			activeWindow.setTimeout(() => {
				const top = this.view.lineBlockAt(this.annotations[0].from).top - 100;
				this.view.scrollDOM.scrollTo({ top, behavior: "smooth" });
			}, 200);
		}
	}

	unfocus_annotation(index: number = -1) {
		if (index === -1)
			this.annotation_thread.classList.toggle("cmtr-anno-gutter-thread-highlight", false);
		else
			this.annotation_thread.children.item(index)!.classList.toggle("cmtr-anno-gutter-thread-highlight", false);
	}

	destroy(dom: HTMLElement) {
		this.hideReplyBox();
		this.component.unload();
		this.annotation_thread.remove();
		super.destroy(dom);
	}
}

function createMarkers(state: EditorState, changed_ranges: CriticMarkupRange[], types: number) {
	const view = state.field(editorEditorField);

	const includeAdditions = (types & AnnotationInclusionType.ADDITION) !== 0;
	const includeDeletions = (types & AnnotationInclusionType.DELETION) !== 0;
	const includeSubstitutions = (types & AnnotationInclusionType.SUBSTITUTION) !== 0;
	const includeHighlights = (types & AnnotationInclusionType.HIGHLIGHT) !== 0;
	const includeComments = (types & AnnotationInclusionType.COMMENT) !== 0;

	const cm_ranges: Range<AnnotationMarker>[] = [];
	for (const range of changed_ranges) {
		// EXPL: Resolved comment/anchored threads never render a gutter card (reopen via the
		//       Annotations View's Resolved filter or the editor context menu). Suggestion bases
		//       are exempt: a done-flagged suggestion (legacy "Set completed" data) keeps its card,
		//       since resolve is not a suggestion concept (see `thread_resolvable`).
		if (thread_resolvable(range) && thread_resolved(range))
			continue;

		let full_thread = range.full_thread;

		if (!includeComments)
			full_thread = full_thread.slice(0, 1);

		switch (range.type) {
			case SuggestionType.ADDITION:
				if (!includeAdditions) full_thread.shift();
				break;
			case SuggestionType.DELETION:
				if (!includeDeletions) full_thread.shift();
				break;
			case SuggestionType.SUBSTITUTION:
				if (!includeSubstitutions) full_thread.shift();
				break;
			case SuggestionType.HIGHLIGHT:
				if (!includeHighlights) full_thread.shift();
				break;
			case SuggestionType.COMMENT:
				if (!includeComments) full_thread.shift();
				break;
		}

		// EXPL: An anchored highlight is only the thread's anchor, not an annotation of its own —
		//       never render it as a card (its replies carry the thread); standalone highlights
		//       (no replies) keep their card, governed by the included-types pruning above
		if (full_thread[0] === range && range.type === SuggestionType.HIGHLIGHT && range.replies.length)
			full_thread.shift();

		if (full_thread.length) {
			// MODIFICATION: advanceCursor in base.ts required markers to be inserted into the rangeset at exactly
			//      the positions where line starts, this caused some issues with correct adjustment of positions through updates,
			//      so adjustment is that markers can now occur at any position before the start of the line
			const marker = new AnnotationMarker(range, full_thread, view, itr);
			marker.preventUnload = true;
			cm_ranges.push(marker.range(range.from, range.to));
		}
	}

	return cm_ranges;
}

let itr = 0;
export const annotationGutterMarkers = StateField.define<RangeSet<AnnotationMarker>>({
	create(state) {
		const ranges = state.field(rangeParser).ranges.ranges.reduce((acc, range) => {
			const base = range.base_range;
			if (!acc.includes(base))
				acc.push(base);
			return acc;
		}, [] as CriticMarkupRange[]);

		return RangeSet.of<AnnotationMarker>(
			createMarkers(
				state,
				ranges,
				state.facet(annotationGutterIncludedTypesState),
			),
		);
	},

	update(oldSet, tr) {
		const includedTypes = tr.state.facet(annotationGutterIncludedTypesState);

		// NOTE: While it is *slightly* inefficient to recreate all markers (since the existing markers could be re-used),
		//       the included types are barely ever changed, so the impact is negligible
		if (tr.startState.facet(annotationGutterIncludedTypesState) !== includedTypes)
			return this.create(tr.state);

		if (!tr.docChanged)
			return oldSet;

		itr += 1;

		const added_ranges: CriticMarkupRange[] = [];
		for (const range of tr.state.field(rangeParser).inserted_ranges) {
			if (!added_ranges.includes(range.base_range))
				added_ranges.push(range.base_range);
		}
		const deleted_ranges = tr.state.field(rangeParser).deleted_ranges
			.map(range => range.base_range);

		return oldSet
			.map(tr.changes)
			.update({
				filter: (from, to, value) => {
					// EXPL: This code prevents AnnotationMarkers in existing GutterMarkers from being unloaded
					//       when the marker is moved from one GutterElement to another
					const keep = !deleted_ranges.includes(value.annotation);
					value.preventUnload = keep;
					return keep;

					// return !deleted_ranges.includes(value.annotation);
				},
				add: createMarkers(tr.state, added_ranges.map(range => range.full_thread[0]), includedTypes),
			});
	},
});
