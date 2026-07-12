import { type EditorState, Range, RangeSet, StateField } from "@codemirror/state";
import { EditorView, GutterMarker } from "@codemirror/view";

import { Component, editorEditorField, editorInfoField, MarkdownRenderer, Menu, Notice, setIcon } from "obsidian";

import { EmbeddableMarkdownEditor } from "../../../../ui/embeddable-editor";

import {
	acceptSuggestions,
	addCommentToView,
	cancel_empty_comment,
	type CommentRange,
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
import { annotationGutterIncludedTypes, annotationGutterIncludedTypesState } from "../../../settings";
import { annotationGutterFocusThreadAnnotation, annotationGutterFoldAnnotation } from "./annotation-gutter";

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
					this.marker.view.dispatch({ changes: cancel_empty_comment(this.range as CommentRange) });
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
			this.marker.view.dispatch({ changes });
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
						this.marker.view.dispatch({ changes: { from: this.range.from, to: this.range.to, insert: "" } });
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
						this.marker.view.dispatch({ changes: resolve_thread(this.range) });
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
	}

	toDOM() {
		this.annotation_thread = createDiv({ cls: "cmtr-anno-gutter-thread" });
		this.annotation_thread.addEventListener("click", this.onCommentThreadClick.bind(this));

		// EXPL: Compact per-card actions (visible on hover/focus, see annotation-gutter.scss).
		//       Resolve/Delete are comment-thread concepts: only rendered when the base is a
		//       HIGHLIGHT anchor or a COMMENT. Suggestion bases (addition/deletion/substitution)
		//       get Accept/Reject instead, dispatching the same `acceptSuggestions`/
		//       `rejectSuggestions` helpers as the "Accept changes"/"Reject changes" context-menu
		//       items below, scoped to this thread's own span — a Resolve button there would
		//       contradict itself across views (suggestions have their own accept/reject
		//       lifecycle), and Delete on a standalone suggestion card would be a silent no-op
		//       (`removeThreadChanges` returns [] for it). Both branches reuse the same
		//       `.cmtr-anno-gutter-thread-actions` row/hover mechanism so suggestion cards get
		//       identical hover-reveal treatment to comment/anchored cards.
		if (thread_resolvable(this.annotation)) {
			const actions = this.annotation_thread.createDiv({ cls: "cmtr-anno-gutter-thread-actions" });
			const resolve_button = actions.createEl("button", {
				cls: "cmtr-anno-gutter-thread-action",
				attr: { "aria-label": "Resolve thread" },
			});
			setIcon(resolve_button, "check");
			resolve_button.addEventListener("click", (e) => {
				e.stopPropagation();
				this.view.dispatch({ changes: resolve_thread(this.annotation) });
			});
			const delete_button = actions.createEl("button", {
				cls: "cmtr-anno-gutter-thread-action",
				attr: { "aria-label": "Delete thread" },
			});
			setIcon(delete_button, "trash-2");
			delete_button.addEventListener("click", (e) => {
				e.stopPropagation();
				this.view.dispatch({ changes: removeThreadChanges(this.annotation) });
			});
		} else if (
			this.annotation.type === SuggestionType.ADDITION ||
			this.annotation.type === SuggestionType.DELETION ||
			this.annotation.type === SuggestionType.SUBSTITUTION
		) {
			const actions = this.annotation_thread.createDiv({ cls: "cmtr-anno-gutter-thread-actions" });
			const accept_button = actions.createEl("button", {
				cls: "cmtr-anno-gutter-thread-action",
				attr: { "aria-label": "Accept changes" },
			});
			setIcon(accept_button, "check");
			accept_button.addEventListener("click", (e) => {
				e.stopPropagation();
				this.view.dispatch({
					changes: acceptSuggestions(this.view.state, this.annotation.from, this.annotation.to),
				});
			});
			const reject_button = actions.createEl("button", {
				cls: "cmtr-anno-gutter-thread-action",
				attr: { "aria-label": "Reject changes" },
			});
			setIcon(reject_button, "x");
			reject_button.addEventListener("click", (e) => {
				e.stopPropagation();
				this.view.dispatch({
					changes: rejectSuggestions(this.view.state, this.annotation.from, this.annotation.to),
				});
			});
		}

		for (const range of this.annotations)
			this.component.addChild(new AnnotationNode(range, this));
		this.component.load();

		return this.annotation_thread;
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
