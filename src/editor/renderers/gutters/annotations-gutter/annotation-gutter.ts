/**
 * This gutter is a modified version of the one defined in @codemirror/view/gutter
 * The main changes are:
 *  1. Gutter is inserted next to the contentDOM (instead of before)
 *  2. Height of gutterElement is not specified
 *  3. GutterElement can be of arbitrary height
 *  4. Added annotation listeners for focusing GutterMarkers
 *  5. Gutter *can* be zero-width if there are no markers in the document
 */
import { Annotation, type EditorState, type Extension, Facet } from "@codemirror/state";
import { BlockInfo, EditorView, GutterMarker, ViewUpdate } from "@codemirror/view";

import { debounce, editorInfoField, setIcon } from "obsidian";
import { commentDraftField } from "../../../uix/extensions/comment-draft";
import { markupFocusEffect } from "../../live-preview";
import {
	createGutterViewPlugin,
	createGutterWithConfig,
	type GutterConfig,
	GutterElement,
	type GutterSide,
	GutterView,
	sameMarkers,
	SingleGutterView,
	UpdateContext,
} from "../base";
import { annotationGutterCompartment } from "./index";
import { annotationGutterMarkers, AnnotationMarker } from "./marker";

// EXPL: Margin between the gutter and the content
const ANNOTATION_GUTTER_MARGIN = 24;

/**
 * The space the gutter takes from the note's readable line width (annotation-gutter.scss `.cm-sizer`): its width and
 * the margin before it, or nothing while folded. Set as one so the two can never disagree.
 */
function setReservedWidth(view: EditorView, width: number, folded: boolean) {
	view.dom.style.setProperty("--cmtr-anno-gutter-width", folded ? "0px" : width + "px");
	view.dom.style.setProperty("--cmtr-anno-gutter-margin", folded ? "0px" : ANNOTATION_GUTTER_MARGIN + "px");
}

// EXPL: Diameter (px) of the round fold button; annotation-gutter.scss sizes it from `--cmtr-fold-button-size`, which
//       createFoldButton sets from this, so the CSS and the position maths can't disagree.
// EXPL: 30px so that, folded, it fits inside Obsidian's 32px right file margin (`--file-margins-x`) clear of the text.
const FOLD_BUTTON_SIZE = 30;
// EXPL: Where the divider line (the resize handle's border) sits, measured leftwards from the gutter panel's left
//       edge. The handle is translated -10px and is `--divider-width-hover` (3px) wide with a 1px border on its right,
//       so the line's centre is 7.5px before the panel. The unfolded button is centred on it.
const DIVIDER_OFFSET = 7.5;
// EXPL: Smallest inset (px) of the folded button from the pane's right edge, so its outline isn't cut off by the edge.
const FOLDED_FOLD_BUTTON_EDGE_INSET = 1;
// EXPL: How close (px, either side) the pointer must come to the divider line for the line and the round button on it to
//       show while the comments are showing (Google Docs reveals its comment-column controls the same way). The one
//       number to tune. The button is 30px across, so it lies wholly inside this range. Watching for it takes nothing
//       from the text or cards under the pointer (onPointerMove), however wide it is.
const DIVIDER_REVEAL_RANGE = 48;

/**
 * Whether the gutter has anything to show — i.e. whether `hideOnEmpty` should keep it collapsed.
 *
 * EXPL: An open comment DRAFT counts as content even though it puts nothing in the document. It has
 *       no AnnotationMarker (it isn't in the note yet, that is the whole point) — it renders a
 *       PROVISIONAL card from `pendingAnnotationMarkers`. Counting only annotationGutterMarkers left
 *       the gutter pinned at width 0 for the FIRST comment in a note (`annotation_gutter_hide_empty`
 *       defaults to true), which is the single most common case there is: the provisional card would
 *       render into a zero-width gutter and the user would see nothing happen.
 * EXPL: Keyed off `commentDraftField` rather than `pendingAnnotationMarkers` — the two are
 *       equivalent (the pending set is non-empty exactly when a draft is open), and the draft field
 *       is a leaf module, so this stays clear of the marker/gutter import cycle. `false` as the
 *       second argument keeps the gutter usable in states that never installed the field.
 */
function has_gutter_content(state: EditorState): boolean {
	return state.field(annotationGutterMarkers).size > 0 || state.field(commentDraftField, false) != null;
}

const unfixGutters = Facet.define<boolean, boolean>({
	combine: values => values.some(x => x),
});

const activeGutters = Facet.define<Required<AnnotationGutterConfig>>();

export const annotationGutterFocusAnnotation = Annotation.define<
	{ from: number; to: number; index?: number; scroll?: boolean }
>();
export const annotationGutterFoldAnnotation = Annotation.define<boolean | null>();
export const annotationGutterFocusThreadAnnotation = Annotation.define<
	{ marker: AnnotationMarker; index: number; scroll?: boolean; focus_markup?: boolean }
>();
export const annotationGutterWidthAnnotation = Annotation.define<number>();
export const annotationGutterHideEmptyAnnotation = Annotation.define<boolean>();
export const annotationGutterFoldButtonAnnotation = Annotation.define<boolean>();
export const annotationGutterResizeHandleAnnotation = Annotation.define<boolean>();

export class AnnotationGutterView extends GutterView {
	declare gutters: AnnotationSingleGutterView[];

	previously_focused: AnnotationMarker | undefined = undefined;

	constructor(view: EditorView) {
		super(view, unfixGutters, activeGutters);
		// FIXME: this still causes a layout shift
		// EXPL: If the gutter is not inside a Markdown View, hide it and remove it from the gutter extension from the view
		if (!view.dom.parentElement!.classList.contains("markdown-source-view")) {
			// NOTE: Prevents gutter from appearing for a brief second (until the deferred reconfigure runs)
			this.dom.hide();
			// NOTE: Codemirror doesn't allow state changes during updates, so reconfiguration needs to be delayed
			window.setTimeout(() => {
				view.dispatch(view.state.update({
					effects: [
						annotationGutterCompartment.reconfigure([]),
					],
				}));
			}, 0);
		}
	}

	// EXPL: When moving a selection inside the editor, multiple moveGutter calls are triggered,
	//       causing wonkyness and ever greater up/downwards movement
	debouncedMoveGutter = debounce(this.moveGutter.bind(this), 200);

	createGutters(view: EditorView) {
		return view.state.facet(activeGutters).map(conf => new AnnotationSingleGutterView(view, conf, this.dom));
	}

	// EXPL: This gutter is a Google-Docs-style comment column on the RIGHT — `insertGutters`
	//       below places it *after* contentDOM, unlike the base class which places it before.
	static readonly side: GutterSide = "after";

	insertGutters(view: EditorView) {
		view.contentDOM.parentNode!.insertBefore(this.dom, view.contentDOM.nextSibling);
	}

	insertDetachedGutters(after: HTMLElement) {
		this.view.contentDOM.parentNode!.insertBefore(this.dom, this.view.contentDOM.nextSibling);
	}

	getUpdateContexts(): UpdateContext[] {
		return this.gutters.map(gutter =>
			new AnnotationUpdateContext(gutter, this.view.viewport, -this.view.documentPadding.top)
		);
	}

	update(update: ViewUpdate) {
		for (const transaction of update.transactions) {
			const thread_focus = transaction.annotation(annotationGutterFocusThreadAnnotation);
			if (thread_focus) {
				const { marker, index, scroll = false, focus_markup = false } = thread_focus;
				this.unfocusAnnotation();
				this.focusAnnotation(marker, index, scroll, focus_markup);
			}
		}
		super.update(update);
	}

	unfocusAnnotation() {
		this.previously_focused?.unfocus_annotation();
		this.previously_focused = undefined;
	}

	focusAnnotation(marker: AnnotationMarker, index: number, scroll: boolean = false, focus_markup = false) {
		this.previously_focused = marker;
		this.debouncedMoveGutter(marker);
		marker.focus_annotation(index, scroll);

		if (focus_markup) {
			window.setTimeout(() => {
				this.view.dispatch(
					this.view.state.update({
						effects: [
							markupFocusEffect.of({
								from: marker.annotation.from,
								to: marker.annotation.full_range_back,
							}),
						],
					}),
				);
			});
		}
	}

	updateGutters(update: ViewUpdate): boolean {
		// EXPL: Check all transactions, figure out if they have been annotated with a focus shift annotation
		// TODO: Is there a better way to check the annotations of a ViewUpdate?
		const annotation = update.transactions.flatMap(tr => tr.annotation(annotationGutterFocusAnnotation)).find(e => e);
		if (annotation || update.startState.selection !== update.state.selection)
			this.unfocusAnnotation();

		if (annotation) {
			const { from, to, index = -1, scroll = false } = annotation;

			// EXPL: Find a GutterElement and then GutterMarker that contains the cursor
			// NOTE: In a previous version of this code, AnnotationGutterElement's `block.to` was used
			//       in order to find the GutterMarker that contains the cursor, however,
			//       the block only represents the starting line of the GutterElement, and does not work
			//       for markers that span multiple lines
			// TODO: Improve the performance of this code, I am not a big fan of linearly searching like this
			// NOTE: Did you know you can label loops? I didn't. Neat huh?
			outer_loop:
			for (const element of this.gutters[0].elements) {
				if (from >= element.block!.from) {
					for (const marker of element.markers as AnnotationMarker[]) {
						if (from >= marker.annotation.from && to <= marker.annotation.full_range_back) {
							this.focusAnnotation(marker, index, scroll);
							break outer_loop;
						}
					}
				} else if (from < element.block!.from) {
					break;
				}
			}
		}

		return super.updateGutters(update);
	}

	/**
	 * Moves the initial GutterElement of the gutter up or down to align provided marker with its block
	 * @param marker - Marker to align the gutter by
	 */
	public moveGutter(marker: GutterMarker) {
		// EXPL: While a comment draft is being composed, the provisional card is added/removed across
		//       frames, so the element heights and the marker<->DOM-child mapping are transient.
		//       moveGutter's margin shift is CUMULATIVE and never reset (see the debounce note above),
		//       so a shift measured against that transient state permanently displaces a run of cards
		//       until reload. Skip alignment during a draft; the next focus with a stable DOM re-aligns.
		if (this.view.state.field(commentDraftField, false) != null)
			return;

		// NOTE: We can assume that only one gutter exists
		const activeGutter = this.gutters[0];

		// EXPL: Given the 'highlighted' marker, fetch the gutterElement it belongs to
		const element = activeGutter.elements.find(element => element.markers.includes(marker));
		if (!element)
			return;
		const markerIndex = element.markers.indexOf(marker);

		// EXPL: Where the gutter element should be located (i.e. flush with the top of the block)
		const desiredLocation = element.block!.top;
		// EXPL: Where the gutter element is currently located (possibly pushed down by other gutter elements)
		// EXPL: The child can be absent while a pending (draft) comment card is alive -- the marker
		//       list and the DOM children can disagree for one frame during the draft's lifecycle.
		//       Bail rather than throw; the next update will place it.
		const marker_el = element.dom.children[markerIndex] as HTMLElement | undefined;
		if (!marker_el)
			return;
		const currentLocation = marker_el.offsetTop;

		// EXPL: Determine the offset between the current location and the desired location
		let offset = desiredLocation - currentLocation;

		// EXPL: It is preferred not to make micro-adjustments on the gutter, so a small offset is ignored
		if (Math.abs(offset) >= 10 && offset) {
			const element = activeGutter.elements[0];
			element.dom.style.marginTop = parseInt(element.dom.style.marginTop || "0") + offset + "px";
		}
	}

	public foldGutter() {
		this.gutters[0].foldGutter();
	}
}

export const annotationGutterView = createGutterViewPlugin(AnnotationGutterView);

export interface AnnotationGutterConfig extends GutterConfig {
	/**
	 * Whether the gutter should be folded by default
	 */
	foldState: boolean;

	/**
	 * The width of the gutter in pixels
	 */
	width: number;

	/**
	 * Whether the gutter should be hidden when empty
	 */
	hideOnEmpty: boolean;

	/**
	 * Whether the gutter should include a fold button
	 */
	includeFoldButton: boolean;

	/**
	 * Whether the gutter should include a resize handle
	 */
	includeResizeHandle: boolean;
}

export function annotation_gutter(
	config: AnnotationGutterConfig,
): { extension: Extension; config: Required<AnnotationGutterConfig> } {
	return createGutterWithConfig(annotationGutterView, config, activeGutters, unfixGutters);
}

class AnnotationUpdateContext extends UpdateContext {
	/**
	 * Describes the y-position of the bottom of the previous gutter element
	 */
	previous_element_end: number = 0;
	new_gutter_elements: AnnotationGutterElement[] = [];
	added_elements: AnnotationGutterElement[] = [];

	constructor(
		readonly gutter: AnnotationSingleGutterView,
		viewport: { from: number; to: number },
		public height: number,
	) {
		super(gutter, viewport, height);
		this.previous_element_end = height;
	}

	addElement(view: EditorView, block: BlockInfo, markers: readonly GutterMarker[]) {
		/**
		 * Describes the amount of space between the previous gutter element and the y-postion for the one that will be constructed for the current block
		 * @remark This prevents the overlap of the gutter elements
		 */
		const above = Math.max(block.top - this.previous_element_end, 0);
		/**
		 * Iff there is overlap with the previous block (i.e. the top of the block is lower than the bottom of the previous gutter element),
		 * then place the gutter element at the bottom of the previous gutter element (above = 0)
		 */
		const block_start = above <= 0 ? this.previous_element_end : block.top;

		/**
		 * SOLUTION: ensures ordering of markers of same block (bit inefficient but very easy solution)
		 * Works by sorting the markers in-place
		 * @todo Investigate whether the markers can be sorted earlier in the pipeline
		 */
		// FIXME: Marker without comment_range issue
		// NOTE: This may be addresses by using the startSide bias in gutterMarker (warning: update concern)
		(markers as unknown as AnnotationMarker[])
			.sort((a, b) => a.annotation.from - b.annotation.from);

		const UNKNOWN_HEIGHT = 36;

		/**
		 * Complete height of the GutterElement, including BOTTOM margin (i.e. spacing between gutter elements)
		 * @remark The reason *why* this is an absolutely essential value, is that it ensures that no elements can overlap,
		 *     if estimated height is lower than actual height, then GutterElements of two blocks risk overlapping
		 *     if estimated height is higher than actual height, then GutterElements will have an unnecessarily large gap between them
		 *   however, we cannot directly grab the height of the element, as it is not yet rendered, so we need to either:
		 *   	1. Estimate the height of the element (clunky, and error-prone with different styles)
		 *   	2. Wait till element is rendered, grab height from rendered element
		 * @remark Current implementation relies on the fact that CodeMirror does a second pass through all of the elements,
		 *     at which point the height of the gutter element is known due to the DOM being rendered
		 *     when SyncGutter is called, the height is again reset to 0, which causes desync issues and additional gutter movement
		 * @warning This is THE only part of the algorithm that needs an implementation (a.k.a. the unsettled height problem),
		 * 	   in short, a better approximation for UNKNOWN_HEIGHT when the element is not rendered yet would be fantastic
		 * 	   please - and I mean this with all sincerity in the world - please let me know if you are able to come up with a more elegant solution
		 */
		const height = this.gutter.elements[this.i]?.dom.clientHeight || UNKNOWN_HEIGHT;

		// EXPL: Search for an existing GutterElement with the same markers
		const element_idx = this.gutter.elements
			.findIndex(e => sameMarkers(e.markers, markers));

		// EXPL: If a GutterElement already exists, and it has the exact same markers,
		//      remove all the GutterElements before this element
		//    	and re-insert all the newly added elements before this element
		if (element_idx !== -1) {
			const element = this.gutter.elements[element_idx];
			for (let i = this.i; i < element_idx; i++) {
				this.gutter.dom.removeChild(this.gutter.elements[i].dom);
				this.gutter.elements[i].destroy();
			}
			for (const added_element of this.added_elements)
				this.gutter.dom.insertBefore(added_element.dom, element.dom);
			this.new_gutter_elements.push(...this.added_elements);
			this.added_elements = [];

			this.i = element_idx + 1;
			this.new_gutter_elements.push(element);
			element.update(view, height, above, markers, block);
		} // EXPL: Otherwise, if the GutterElement does not exist, create a new one and it to the gutter later
		else {
			this.added_elements.push(new AnnotationGutterElement(view, height, above, markers, block));
		}

		this.previous_element_end = block_start + height;
	}

	finish() {
		// EXPL: Finally, at the end of the update, remove all remaining GutterElements
		for (let i = this.i; i < this.gutter.elements.length; i++) {
			this.gutter.dom.removeChild(this.gutter.elements[i].dom);
			this.gutter.elements[i].destroy();
		}

		// EXPL: Add all the remaining added GutterElements to the gutter
		for (const added_element of this.added_elements)
			this.gutter.dom.appendChild(added_element.dom);
		this.gutter.elements = [...this.new_gutter_elements, ...this.added_elements];
		this.new_gutter_elements = [];
		this.added_elements = [];
	}
}

class AnnotationSingleGutterView extends SingleGutterView {
	/**
	 * The fold state the user chose (button, command, context menu, a draft opening the gutter). Saved in the layout
	 * (main.ts reads it), and the state the gutter returns to whenever the pane is wide enough for it.
	 */
	folded: boolean = false;
	/**
	 * Whether the pane is too narrow for the note's readable text and the gutter side by side (see `measureNarrow`).
	 * While it is, the gutter folds on its own; that is never saved, so it can't overwrite `folded`.
	 */
	narrow: boolean = false;
	/** The user asked to see the gutter while the pane is narrow. Lasts until the pane leaves (or re-enters) narrow. */
	peek: boolean = false;
	/** The fold state the DOM currently shows, so a change in `collapsed` animates exactly once. */
	private shown_collapsed: boolean = false;
	private measured: boolean = false;
	/** A fold animation is running (foldGutter); the button's position is estimated until it ends. */
	private folding: boolean = false;
	private folding_timer: number | undefined = undefined;
	private resize_observer: ResizeObserver | undefined = undefined;
	private line_width_probe: HTMLElement | undefined = undefined;
	/** The pointer is within DIVIDER_REVEAL_RANGE of the divider line (see onPointerMove). */
	private near_divider: boolean = false;
	hide_on_empty: boolean = false;
	width: number = 0;
	add_fold_button: boolean = false;
	add_resize_handle: boolean = false;

	fold_button_el: HTMLElement | undefined = undefined;
	resize_handle_el: HTMLElement | undefined = undefined;
	declare elements: AnnotationGutterElement[];

	constructor(
		public view: EditorView,
		public config: Required<AnnotationGutterConfig>,
		private gutterDom: HTMLElement,
	) {
		super(view, config);

		this.folded = config.foldState;
		this.width = config.width;
		// EXPL: If the gutter takes up too much space, fold it by default (even if the user has allowed it to be unfoled in the past)
		// if (this.view.dom.clientWidth - this.width < 200) {
		// 	this.folded = true;
		// }
		// TODO: This is specifically done for popovers, there may be a better fix for this
		if (this.view.dom.parentElement?.parentElement?.parentElement?.classList.contains("markdown-embed"))
			this.folded = true;

		this.hide_on_empty = config.hideOnEmpty;
		this.add_fold_button = config.includeFoldButton;
		this.add_resize_handle = config.includeResizeHandle;

		this.shown_collapsed = this.collapsed;
		this.setGutterWidth((this.hide_on_empty && !has_gutter_content(view.state)) || this.collapsed ? 0 : this.width);
		setReservedWidth(this.view, this.width, this.collapsed);
		this.gutterDom.style.marginInlineStart = this.collapsed ? "0" : ANNOTATION_GUTTER_MARGIN + "px";

		if (this.add_fold_button)
			this.createFoldButton();

		if (this.add_resize_handle)
			this.createResizeHandle();

		// EXPL: The scroller's width doesn't depend on the gutter (the gutter is inside it), so folding in response to
		//       its size can't feed back into another resize. `.win` keeps this right in pop-out windows.
		const Observer = (this.view.dom.win as typeof window).ResizeObserver;
		this.resize_observer = new Observer(() => this.onPaneResize());
		this.resize_observer.observe(this.view.scrollDOM);

		// EXPL: Listened for on the whole pane, not on a hover strip over the divider: a strip wide enough to reveal the
		//       controls from 24px away would cover the end of every line and the edge of every card, and take their
		//       clicks and text selection. A passive listener only watches the pointer, so nothing under it changes.
		this.view.dom.addEventListener("mousemove", this.onPointerMove, { passive: true });
		this.view.dom.addEventListener("mouseleave", this.onPointerLeave, { passive: true });
	}

	/**
	 * Marks the pane `data-cmtr-near-divider` while the pointer is within DIVIDER_REVEAL_RANGE of the divider line
	 * between the note and the comment column. While the comments show, the line and the round "Hide comments" button
	 * on it are only drawn then (annotation-gutter.scss), so they don't sit over the page while the user reads.
	 */
	private onPointerMove = (event: MouseEvent) => {
		let near = false;
		if (!this.shown_collapsed) {
			const gutters = this.gutterDom.getBoundingClientRect();
			near = gutters.width > 0 &&
				Math.abs(event.clientX - (gutters.left - DIVIDER_OFFSET)) <= DIVIDER_REVEAL_RANGE;
		}
		this.setNearDivider(near);
	};

	private onPointerLeave = () => this.setNearDivider(false);

	private setNearDivider(near: boolean) {
		if (near === this.near_divider) return;
		this.near_divider = near;
		// EXPL: An attribute, not a class: CodeMirror rewrites `view.dom`'s class attribute whenever the editor's own
		//       classes change (`cm-focused` on every focus change, for one), which dropped a class set here as soon as
		//       the user clicked a card (seen in the sandbox). It leaves attributes it doesn't manage alone.
		this.view.dom.toggleAttribute("data-cmtr-near-divider", near);
	}

	/** Whether the gutter shows folded: the user's choice, unless the pane is too narrow (then folded, unless peeked). */
	get collapsed(): boolean {
		return this.narrow ? !this.peek : this.folded;
	}

	/**
	 * Whether the pane can't fit the note's readable line width and the gutter (with its margin) side by side.
	 *
	 * EXPL: The threshold is `--file-line-width` (Obsidian's readable line width, 700px by default) + the gutter's
	 *       width + its margin: the narrowest pane where showing the gutter leaves the text its full readable width.
	 *       Below it, an open gutter takes its width from the text (at a narrow enough pane, all of it). The readable
	 *       width is used with readable line length off too, as the width text needs to read comfortably.
	 * EXPL: Measured from a probe sized `width: var(--file-line-width)` rather than parsed from the variable, so a
	 *       theme that sets it in rem, ch or a calc() still resolves to pixels.
	 */
	private measureNarrow(): boolean | undefined {
		const scroller = this.view.scrollDOM;
		const style = scroller.win.getComputedStyle(scroller);
		const available = scroller.clientWidth - (parseFloat(style.paddingLeft) || 0) -
			(parseFloat(style.paddingRight) || 0);
		// EXPL: Not laid out yet (a note opening in a background tab): nothing to decide until it is.
		if (scroller.clientWidth <= 0)
			return undefined;
		return available < this.readableWidth() + this.width + ANNOTATION_GUTTER_MARGIN;
	}

	private onPaneResize() {
		// EXPL: A drag of the resize handle changes the gutter's width, not the pane's; it settles on mouseup.
		if (this.view.dom.classList.contains("cmtr-anno-gutter-resizing"))
			return;
		const narrow = this.measureNarrow();
		if (narrow === undefined)
			return;
		const first = !this.measured;
		this.measured = true;
		if (narrow !== this.narrow) {
			this.narrow = narrow;
			// EXPL: A peek is for the narrow pane it was asked in; crossing the threshold either way returns to the
			//       automatic state (folded when narrow, the user's own choice when wide).
			this.peek = false;
		}
		// EXPL: The first measurement comes as the note opens: it sets the state without the fold animation, so a note
		//       opened in a narrow pane doesn't play a fold every time.
		this.applyCollapsed(!first);
	}

	/** Shows `collapsed` if the DOM doesn't yet: animated, or at once (`animate` false). */
	private applyCollapsed(animate = true) {
		if (this.collapsed === this.shown_collapsed) {
			// EXPL: The button's position depends on the pane's width (the readable-width side margins), even when the
			//       fold state doesn't change.
			this.updateFoldButtonPosition();
			return;
		}
		this.shown_collapsed = this.collapsed;
		// EXPL: The divider moves (or goes) with the fold; whether the pointer is near it is known again on its next move.
		this.setNearDivider(false);
		if (animate) {
			this.foldGutter();
			return;
		}
		// EXPL: `cmtr-anno-gutter-instant` turns the gutter's transitions off (annotation-gutter.scss) while the new
		//       values are committed, then they're back on for later changes.
		this.view.dom.classList.add("cmtr-anno-gutter-instant");
		this.setGutterWidth(
			(this.hide_on_empty && !has_gutter_content(this.view.state)) || this.collapsed ? 0 : this.width,
		);
		this.gutterDom.style.marginInlineStart = this.collapsed ? "0" : ANNOTATION_GUTTER_MARGIN + "px";
		setReservedWidth(this.view, this.width, this.collapsed);
		this.setFoldButtonState();
		void this.dom.offsetWidth;
		this.view.dom.classList.remove("cmtr-anno-gutter-instant");
	}

	/**
	 * Sets the fold state the user asked for (`null` toggles what they see). While the pane is narrow, the request is a
	 * peek that isn't saved: the saved choice is made, and kept, at a width where the gutter fits.
	 */
	private requestFold(fold: boolean | null) {
		const target = fold ?? !this.collapsed;
		if (this.narrow)
			this.peek = !target;
		else if (target !== this.folded) {
			this.folded = target;
			this.view.state.field(editorInfoField).app.workspace.requestSaveLayout();
		}
		this.applyCollapsed();
	}

	/** The gutter's width in pixels: 0 while it is folded or hidden for having nothing to show. */
	private setGutterWidth(width: number) {
		this.dom.style.width = width + "px";
		// EXPL: The room the gutter takes beside the text right now, with its margin. Under Minimal the gutter
		//       container is out of flow (annotation-gutter.scss), so the text keeps this much clear of it.
		this.view.dom.style.setProperty(
			"--cmtr-anno-gutter-space",
			width > 0 ? width + ANNOTATION_GUTTER_MARGIN + "px" : "0px",
		);
		// EXPL: 1 while the gutter takes room, 0 while it doesn't: scales the right inset Minimal's out-of-flow column
		//       keeps from the pane's edge (annotation-gutter.scss).
		this.view.dom.style.setProperty("--cmtr-anno-gutter-open", width > 0 ? "1" : "0");
	}

	createFoldButton() {
		// EXPL: A real <button>, so it takes keyboard focus and Enter/Space; the old `<a>` without an href took neither.
		//       One chevron, pointing right (the way the gutter moves when it hides); the folded class turns it to
		//       point left.
		const foldButtonElement = createEl("button", { cls: ["cmtr-anno-gutter-fold"], attr: { type: "button" } });
		setIcon(foldButtonElement, "chevron-right");
		foldButtonElement.setAttribute("data-tooltip-position", "left");
		foldButtonElement.onclick = () => this.requestFold(null);

		this.fold_button_el = createDiv({ cls: ["cmtr-anno-gutter-button"] });
		this.fold_button_el.style.setProperty("--cmtr-fold-button-size", FOLD_BUTTON_SIZE + "px");
		this.fold_button_el.appendChild(foldButtonElement);
		// EXPL: Hidden on the wrapper, which is what `update` shows and hides as the gutter gains and loses content.
		//       Hiding the inner button here (as before) left it hidden for good when a note's first draft gave the
		//       gutter something to show.
		this.fold_button_el.toggle(has_gutter_content(this.view.state));
		// EXPL: The button is anchored to `view.dom` (`.cm-editor`, position: relative per CM6's
		//       base theme) rather than the gutter container, so its absolute `right` offset is
		//       measured from the PANE's right edge — correct in split layouts and with sidebars
		//       open — and it stays put while the gutter itself folds to zero width
		this.view.dom.appendChild(this.fold_button_el);
		// NOTE: Must run after fold_button_el is assigned above (setFoldButtonState is a no-op
		//       while it's still undefined) so the button gets its rotate/aria-label/position state
		//       immediately instead of only after the first fold toggle
		this.setFoldButtonState();
	}

	createResizeHandle() {
		this.resize_handle_el = createEl("hr", { cls: ["cmtr-anno-gutter-resize-handle"] });
		this.resize_handle_el.toggle(has_gutter_content(this.view.state) && !this.collapsed);
		this.resize_handle_el.addEventListener("mousedown", (e) => {
			let initialPosition = e.clientX;
			let isReadableLineWidth = this.view.state.field(editorInfoField).app.vault.getConfig("readableLineLength");
			const temporarySheet = this.view.dom.doc.styleSheets[0];

			// EXPL: Debounce to prevent excessive state updates and DOM redraws while dragging the handle
			const setWidth = debounce((width: number) => {
				this.width = Math.round(Math.max(0, width));
				this.view.state.field(editorInfoField).app.workspace.requestSaveLayout();
				this.setGutterWidth(this.width);
				this.view.dom.style.setProperty("--cmtr-anno-gutter-width", this.width + "px");
				this.updateFoldButtonPosition();

				// TODO: Improve resizing logic when user has readable line length enabled
				//       When resizing, .cm-line's width adjust even when not necessary, causing jarring content shifts
				// EXPL: Freezes the width of .cm-line to prevent content shifting, reduces the amount of shifts a lot
				// 		 (Trust me, it is _much_ worse without this bodge)
				if (isReadableLineWidth) {
					temporarySheet.deleteRule(temporarySheet.cssRules.length - 1);
					temporarySheet.insertRule(
						`.cmtr-anno-gutter-resizing .cm-line { width: ${this.view.contentDOM.clientWidth}px !important; }`,
						temporarySheet.cssRules.length,
					);
				}
			}, 25);

			this.resize_handle_el!.classList.toggle("cmtr-anno-gutter-resize-handle-hover", true);
			// EXPL: Toggled on view.dom (not scrollDOM) so the `.cmtr-anno-gutter-resizing …` rules
			//       reach the fold button too, which lives in view.dom rather than inside the scroller
			this.view.dom.classList.toggle("cmtr-anno-gutter-resizing", true);

			let currentWidth = parseInt(this.dom.style.width.slice(0, -2));
			const onMouseMove = (evt: MouseEvent) => {
				const deltaX = evt.clientX - initialPosition;
				initialPosition = evt.clientX;
				currentWidth -= deltaX;
				setWidth(currentWidth);
				return true;
			};

			const onMouseStop = () => {
				this.view.dom.doc.removeEventListener("mousemove", onMouseMove);
				this.view.dom.doc.removeEventListener("mouseup", onMouseStop);
				this.resize_handle_el!.classList.toggle("cmtr-anno-gutter-resize-handle-hover", false);
				this.view.dom.classList.toggle("cmtr-anno-gutter-resizing", false);

				if (isReadableLineWidth)
					temporarySheet.deleteRule(temporarySheet.cssRules.length - 1);

				// EXPL: setWidth places the button by measuring the column while its 50ms width transition is still
				//       running, so after a drag the button was left where the divider had been (50px off after a 100px
				//       drag, seen in the sandbox). Measure again once the last debounced width has landed and settled: a
				//       width that lands after mouseup animates over the full 400ms, `cmtr-anno-gutter-resizing` being gone.
				window.setTimeout(() => this.updateFoldButtonPosition(), 450);

				// EXPL: Widening the gutter by hand can make the pane "narrow" for it. Folding it the moment the user
				//       lets go would undo what they just did, so the new state starts as a peek: still showing, and
				//       folding on its own once the pane next crosses the threshold. The other way round (narrowed until it
				//       fits), the gutter the user was resizing stays open: that's their choice now, and setWidth has
				//       already asked for the layout to be saved.
				const narrow = this.measureNarrow();
				if (narrow !== undefined && narrow !== this.narrow) {
					this.narrow = narrow;
					this.peek = narrow;
					if (!narrow)
						this.folded = false;
					this.applyCollapsed();
				}
			};

			this.view.dom.doc.addEventListener("mousemove", onMouseMove);
			this.view.dom.doc.addEventListener("mouseup", onMouseStop);

			return true;
		});

		this.gutterDom.appendChild(this.resize_handle_el);
	}

	setFoldButtonState() {
		if (this.fold_button_el) {
			// EXPL: Class-based (not `setAttribute("style", "rotate: …")`): a toggled class composes with the `rotate`
			//       transition in annotation-gutter.scss, and `setAttribute("style", …)` would replace the whole style
			//       attribute, clobbering the `display: none` set on this element in `createFoldButton` for empty gutters.
			const icon = this.fold_button_el.children[0] as HTMLElement;
			icon.classList.toggle("cmtr-anno-gutter-button-folded", this.shown_collapsed);
			// EXPL: Folded, the button is the only way back, so it always shows; open, it shows near the divider
			//       (onPointerMove, annotation-gutter.scss).
			this.fold_button_el.classList.toggle("is-folded", this.shown_collapsed);
			if (this.shown_collapsed) {
				icon.ariaLabel = "Show comments";
				this.resize_handle_el?.hide();
			} else {
				icon.ariaLabel = "Hide comments";
				this.resize_handle_el?.show();
			}
			this.updateFoldButtonPosition();
		}
	}

	/** The readable line width in pixels (see measureNarrow). */
	private readableWidth(): number {
		if (!this.line_width_probe)
			this.line_width_probe = this.view.dom.createDiv({ cls: "cmtr-anno-gutter-line-probe" });
		return this.line_width_probe.offsetWidth || 700;
	}

	/**
	 * Sets the fold button's `right` offset (pane-relative: the button is an absolutely positioned child of `view.dom`,
	 * which doesn't scroll, so the button stays in view).
	 * - Shown: centred on the divider line between the text and the gutter. Once the layout is settled that line is
	 *   MEASURED (the gutter container's left edge, less the divider's offset), so it holds in any theme: Minimal, for
	 *   one, drops the scroller's padding and lays the gutter out differently. While a fold animates, the CSS
	 *   transitions `right` towards an estimate for Obsidian's default layout (the gutter panel's right edge is the
	 *   `.cm-sizer`'s, inside the scroller's padding and scrollbar and, with readable line length on, centred), and
	 *   the measured position replaces it when the animation ends.
	 * - Folded: centred in the strip right of the text: the scroller's right padding (`padding: var(--file-margins)`),
	 *   or `--file-margins-x` where a theme moves that margin elsewhere (Minimal zeroes the scroller's padding and keeps
	 *   the lines that far from the edge). The 30px button fits in the default 32px strip, clear of the text.
	 */
	updateFoldButtonPosition() {
		if (!this.fold_button_el) return;
		if (this.shown_collapsed) {
			const scroller_style = this.view.scrollDOM.win.getComputedStyle(this.view.scrollDOM);
			const strip = Math.max(
				parseFloat(scroller_style.paddingRight) || 0,
				parseFloat(scroller_style.getPropertyValue("--file-margins-x")) || 0,
			);
			this.fold_button_el.style.right = `${Math.max(FOLDED_FOLD_BUTTON_EDGE_INSET, (strip - FOLD_BUTTON_SIZE) / 2)}px`;
			return;
		}
		const gutters = this.gutterDom.getBoundingClientRect();
		if (!this.folding && gutters.width > 0) {
			const pane = this.view.dom.getBoundingClientRect();
			const divider = gutters.left - DIVIDER_OFFSET;
			this.fold_button_el.style.right = `${pane.right - divider - FOLD_BUTTON_SIZE / 2}px`;
			return;
		}
		const scroller = this.view.scrollDOM;
		const style = scroller.win.getComputedStyle(scroller);
		const padding_right = parseFloat(style.paddingRight) || 0;
		const scrollbar = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
		let side_margin = 0;
		if (this.view.state.field(editorInfoField).app.vault.getConfig("readableLineLength")) {
			const inner = scroller.clientWidth - (parseFloat(style.paddingLeft) || 0) - padding_right;
			const sizer = this.readableWidth() + this.width + ANNOTATION_GUTTER_MARGIN;
			side_margin = Math.max(0, (inner - sizer) / 2);
		}
		const divider = scrollbar + padding_right + side_margin + this.width + DIVIDER_OFFSET;
		this.fold_button_el.style.right = `${divider - FOLD_BUTTON_SIZE / 2}px`;
	}

	foldGutter() {
		// EXPL: Measured before anything below restyles the gutter: reading it after the gutter's margin is
		//       applied forces a layout in which that margin has already squeezed the content.
		const content_width = this.view.contentDOM.clientWidth;
		// EXPL: The animation is 400ms (annotation-gutter.scss); a timer rather than transitionend, which never comes
		//       when the width doesn't change (a gutter hidden for having nothing to show).
		this.folding = true;
		window.clearTimeout(this.folding_timer);
		this.folding_timer = window.setTimeout(() => {
			this.folding = false;
			this.updateFoldButtonPosition();
		}, 450);
		this.setFoldButtonState();

		// EXPL: Set the height for every marker to fixed so that they won't resize while the gutter is changing width
		if (this.shown_collapsed) {
			this.elements.forEach(element => {
				Array.from(element.dom.getElementsByClassName("cmtr-anno-gutter-annotation")).forEach(comment => {
					comment.setAttribute("style", `max-height: ${comment.clientHeight}px; overflow: hidden;`);
				});
			});
		} else {
			this.afterWidthTransition(() => {
				this.elements.forEach(element => {
					Array.from(element.dom.getElementsByClassName("cmtr-anno-gutter-annotation")).forEach(comment => {
						comment.removeAttribute("style");
					});
				});
			});
		}
		this.setGutterWidth(this.shown_collapsed ? 0 : this.width);
		this.gutterDom.style.marginInlineStart = this.shown_collapsed ? "0" : ANNOTATION_GUTTER_MARGIN + "px";

		// EXPL: Not under Minimal: its `.cm-sizer` fills the pane rather than centring at the readable width, so the
		//       margins below slid the text the wrong way for 0.4s and then jumped it (by up to 300px, measured in the
		//       sandbox). There the gutter is out of flow and the text's margin transitions with the gutter's width
		//       (annotation-gutter.scss), which is the whole animation.
		if (this.dom.classList.contains("is-minimal"))
			setReservedWidth(this.view, this.width, this.shown_collapsed);
		else if (this.view.state.field(editorInfoField).app.vault.getConfig("readableLineLength")) {
			// EXPL: Computes the margin before and after the gutter has been folded
			const readableLineWidth = parseInt(
				getComputedStyle(this.view.scrollDOM).getPropertyValue("--file-line-width").trim(),
			);
			const marginWithoutGutter = Math.max(0, this.view.scrollDOM.innerWidth - readableLineWidth);
			const marginWithGutter = Math.max(0, marginWithoutGutter - this.width - ANNOTATION_GUTTER_MARGIN);
			const newMargin = (this.shown_collapsed ? marginWithoutGutter : marginWithGutter) / 2;
			const oldMargin = (this.shown_collapsed ? marginWithGutter : marginWithoutGutter) / 2;

			// EXPL: Freeze the contentDOM to prevent content shifting while the gutter is being folded
			// EXPL: Through setProperty: assigning `"…px !important"` to `style.width` is an invalid value, which the
			//       browser drops, so the freeze never applied and the text rewrapped mid-animation. No margin
			//       correction either way: the text column is the readable line width whether or not the gutter shows
			//       (`--cmtr-anno-gutter-margin`, annotation-gutter.scss). `flex-shrink` too: the content sits in a flex
			//       row with the gutters, which otherwise squeezes it below its width while the gutter grows.
			this.view.contentDOM.style.setProperty("width", content_width + "px", "important");
			this.view.contentDOM.style.setProperty("min-width", content_width + "px", "important");
			// EXPL: Set the old margin to transition from
			this.view.scrollDOM.children[0].setAttribute(
				"style",
				`margin: 0 ${oldMargin}px; transition: margin 0.4s ease-in-out, max-width 0.4s ease-in-out;`,
			);
			if (!this.shown_collapsed)
				setReservedWidth(this.view, this.width, false);

			window.setTimeout(() => {
				// EXPL: Transition to the new margin
				this.view.scrollDOM.children[0].setAttribute(
					"style",
					`margin: 0 ${newMargin}px; transition: margin 0.4s ease-in-out, max-width 0.4s ease-in-out;`,
				);
				// EXPL: Whenever the gutter is finished folding, clean up all freezes
				this.afterWidthTransition(() => {
					this.view.contentDOM.style.removeProperty("width");
					this.view.contentDOM.style.removeProperty("min-width");
					this.view.scrollDOM.children[0].removeAttribute("style");
					if (this.shown_collapsed)
						setReservedWidth(this.view, this.width, true);
				});
			});
		}
	}

	/**
	 * Runs `callback` once the gutter's own width transition ends.
	 *
	 * EXPL: Not `{ once: true }` on any transitionend: the event bubbles, so a card's background fade or a gutter
	 *       element's margin transition ending inside the gutter would run the callback early, releasing the frozen
	 *       margins halfway through the fold animation.
	 */
	private afterWidthTransition(callback: () => void) {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			this.dom.removeEventListener("transitionend", listener);
			this.dom.removeEventListener("transitioncancel", listener);
			window.clearTimeout(fallback);
			callback();
		};
		const listener = (event: TransitionEvent) => {
			if (event.target === this.dom && event.propertyName === "width")
				finish();
		};
		this.dom.addEventListener("transitionend", listener);
		// EXPL: A transition that is cancelled (another fold, or the width set with transitions off) never ends, and one
		//       that never starts (the width didn't change, or the window isn't being painted) never sends either event.
		//       Either way the callback still has to run, or the frozen text width and margins stay frozen for good.
		this.dom.addEventListener("transitioncancel", listener);
		const fallback = window.setTimeout(finish, 600);
	}

	update(update: ViewUpdate) {
		const result = super.update(update);
		const has_content = has_gutter_content(update.state);

		for (const transaction of update.transactions) {
			const fold_status = transaction.annotation(annotationGutterFoldAnnotation);
			const width = transaction.annotation(annotationGutterWidthAnnotation);
			const hide_empty = transaction.annotation(annotationGutterHideEmptyAnnotation);
			const fold_button = transaction.annotation(annotationGutterFoldButtonAnnotation);
			const resize_handle = transaction.annotation(annotationGutterResizeHandleAnnotation);
			if (width !== undefined) {
				this.width = width;
				if (!this.hide_on_empty && !this.shown_collapsed) {
					this.setGutterWidth(width);
					this.setFoldButtonState();
				}
				// NOTE: Keeps the button's `right` offset in sync with the latest width even when the
				//       branch above is skipped (hidden-on-empty / folded), so it's never stale once
				//       the button becomes visible/unfolded again
				this.updateFoldButtonPosition();
				this.view.dom.style.setProperty("--cmtr-anno-gutter-width", this.width + "px");
				// EXPL: A new width (from the settings) moves the narrow threshold.
				this.onPaneResize();
			}
			if (fold_status !== undefined) {
				// EXPL: Only animate a real change. Every new comment draft sends "unfold"
				//       (addCommentToView), and re-running foldGutter on an open gutter starts the
				//       note's margins from their FOLDED value: with readable line length on and a
				//       window wide enough to have side margins, the note text jumped sideways by half
				//       the gutter width and slid back over 0.4 s, and the transitionend that releases
				//       the frozen margins never came (the gutter's width did not change), leaving the
				//       note pinned to stale margins until something else ended a transition.
				// EXPL: Saved whatever asked for the change, the draft's unfold included. Saving only the
				//       toggle left the layout recording "folded" under a gutter the user last saw open: the
				//       note reopened with its cards hidden, and the first draft slid the text over again.
				//       In a narrow pane the request is a peek instead, and isn't saved (requestFold).
				this.requestFold(fold_status);
			}
			if (hide_empty !== undefined) {
				this.hide_on_empty = hide_empty;
				this.setGutterWidth(this.hide_on_empty && !has_content ? 0 : this.width);
				this.view.dom.style.setProperty("--cmtr-anno-gutter-width", this.width + "px");
			}
			if (fold_button !== undefined) {
				this.add_fold_button = fold_button;
				if (this.add_fold_button && !this.fold_button_el)
					this.createFoldButton();
				else if (!this.add_fold_button && this.fold_button_el) {
					this.fold_button_el.remove();
					this.fold_button_el = undefined;
				}
				this.setFoldButtonState();
			}
			if (resize_handle !== undefined) {
				this.add_resize_handle = resize_handle;
				if (this.add_resize_handle && !this.resize_handle_el)
					this.createResizeHandle();
				else if (!this.add_resize_handle && this.resize_handle_el) {
					this.resize_handle_el.remove();
					this.resize_handle_el = undefined;
				}
			}
		}

		// EXPL: Compares "has anything to show" rather than the raw marker COUNT, because an open
		//       draft moves the gutter between empty and non-empty without changing any count (it
		//       adds no AnnotationMarker — it isn't in the document). The old count comparison also
		//       re-ran this block on every 1->2 marker change, where both branches are no-ops.
		if (has_content !== has_gutter_content(update.startState)) {
			if (!has_content) {
				this.fold_button_el?.hide();
				this.resize_handle_el?.hide();
				if (this.hide_on_empty)
					this.setGutterWidth(0);
			} else {
				this.fold_button_el?.show();
				// EXPL: Not while folded: the handle is the divider line of an open column (setFoldButtonState hides it
				//       on fold), and shown here it drew a stray line at the pane's edge.
				if (!this.shown_collapsed) {
					this.resize_handle_el?.show();
					this.setGutterWidth(this.width);
				}
			}
		}

		// NOTE: Boolean returns true only if markers have changed within the viewport (so outside markers don't count)
		return result;
	}

	destroy() {
		window.clearTimeout(this.folding_timer);
		this.resize_observer?.disconnect();
		this.view.dom.removeEventListener("mousemove", this.onPointerMove);
		this.view.dom.removeEventListener("mouseleave", this.onPointerLeave);
		this.view.dom.removeAttribute("data-cmtr-near-divider");
		this.line_width_probe?.remove();
		this.fold_button_el?.remove();
		this.resize_handle_el?.remove();

		// EXPL: `preventUnload` is latched on markers that are merely MOVING between GutterElements, and
		//       GutterElement.setMarkers honours it by SKIPPING destroy() (base.ts:181-183). On teardown
		//       there is no move to survive: this is the end of the gutter. A marker still latched here
		//       would never get destroy()'d, so its Component never unloads — and for the pending card
		//       that Component owns a ReplyBox holding a live EmbeddableMarkdownEditor (a real CM6
		//       EditorView), which would outlive the closed note/pane. Unlatch first so the elements
		//       below are genuinely destroyed.
		for (const element of this.elements) {
			for (const marker of element.markers)
				(marker as GutterMarker & { preventUnload?: boolean }).preventUnload = false;
		}

		super.destroy();
	}
}

class AnnotationGutterElement extends GutterElement {
	constructor(
		view: EditorView,
		height: number,
		above: number,
		markers: readonly GutterMarker[],
		// IMPORTANT: The `block` variable represents the _starting_ line this GutterElement may belong to
		// 		the annotations _may_ cover multiple lines, but the block will ONLY account for the first line
		// 		In practice, this means that block.to IS NOT the end of the marker
		public block: BlockInfo | null = null,
	) {
		super(view, height, above, markers);
	}

	/**
	 * Comment update function that does not forcibly set the height of the gutter element
	 */
	update(
		view: EditorView,
		height: number,
		above: number,
		markers: readonly GutterMarker[],
		block: BlockInfo | null = null,
	) {
		this.block = block;
		if (this.above != above) {
			this.above = above;
			this.dom.style.marginTop = above ? above + "px" : "";
		}
		if (!sameMarkers(this.markers, markers))
			this.setMarkers(view, markers);
	}
}
