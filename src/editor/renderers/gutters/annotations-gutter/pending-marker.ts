import { RangeSet, StateField } from "@codemirror/state";
import { EditorView, GutterMarker } from "@codemirror/view";

import { Component, editorEditorField, editorInfoField } from "obsidian";

import { commitCommentDraft } from "../../../base/edit-logic/add-comment";
import { clearCommentDraft, commentDraftField } from "../../../uix/extensions/comment-draft";
import { ReplyBox } from "./reply-box";

/**
 * The gutter card for a comment that is not in the document yet.
 *
 * EXPL: Duck-types AnnotationMarker's `annotation.from`. AnnotationGutterUpdateContext.addElement
 *       sorts a block's markers with an UNCHECKED cast —
 *       `(markers as unknown as AnnotationMarker[]).sort((a, b) => a.annotation.from - b.annotation.from)`
 *       (annotation-gutter.ts:283-284). A marker without that shape sorts as NaN and scrambles the
 *       order of every card sharing its block, so this field is load-bearing, not decorative.
 *
 * EXPL: It deliberately does NOT duck-type `annotation.full_range_back`, which the same cast reads
 *       in AnnotationGutterView.updateGutters' focus scan (annotation-gutter.ts:162). Leaving it
 *       undefined makes that comparison false, so a focus annotation can never select this marker —
 *       which is what we want: focusAnnotation would then call `focus_annotation()`/
 *       `unfocus_annotation()` on it, and a provisional card has neither.
 */
export class PendingAnnotationMarker extends GutterMarker {
	annotation: { from: number; to: number };
	component: Component = new Component();
	/** @see GutterElement.setMarkers (gutters/base.ts) — set while the draft lives, see below. */
	preventUnload = false;
	thread: HTMLElement | null = null;
	reply_box: ReplyBox | null = null;

	constructor(from: number, to: number, public view: EditorView) {
		super();
		this.annotation = { from, to };
	}

	/**
	 * EXPL: A fallback, not the mechanism. The StateField below reuses ONE marker instance for the
	 *       life of a draft, so `GutterMarker.compare`'s identity check (`this == other`) is what
	 *       actually keeps the card's DOM — and the reply box the user is typing into — from being
	 *       torn down and rebuilt on every transaction. This eq only decides between two DIFFERENT
	 *       instances, which the field never produces for one draft.
	 */
	eq(other: PendingAnnotationMarker) {
		return this.annotation.from === other.annotation.from && this.annotation.to === other.annotation.to;
	}

	toDOM() {
		// EXPL: toDOM can run a SECOND time on this same instance without a destroy() in between:
		//       GutterElement.setMarkers re-homes a marker between GutterElements while
		//       `preventUnload` is set (see that file's FIXME at :172-180). Reset first, or the
		//       previous card's ReplyBox stays parented to this marker's Component — a loaded editor
		//       orphaned on a detached DOM tree. Same defence as AnnotationMarker.toDOM.
		this.hideReplyBox();

		const { app } = this.view.state.field(editorInfoField);

		const thread = createDiv({ cls: ["cmtr-anno-gutter-thread", "cmtr-anno-gutter-thread-pending"] });

		// EXPL: Echo the text being commented on, the way Docs does — the card floats in the gutter
		//       with no markup in the note to point back at it yet.
		thread.createDiv({
			cls: "cmtr-anno-gutter-pending-quote",
			text: this.view.state.sliceDoc(this.annotation.from, this.annotation.to),
		});

		const container = thread.createDiv({ cls: "cmtr-anno-gutter-reply" });
		this.reply_box = this.component.addChild(
			new ReplyBox(app, container, {
				placeholder: "Comment…",
				onCommit: (text) => commitCommentDraft(this.view, text),
				onDismiss: () => this.view.dispatch({ effects: clearCommentDraft.of(null) }),
			}),
		);
		this.component.load();

		this.thread = thread;
		return thread;
	}

	// EXPL: Clear the field BEFORE removing the child (never after): removeChild unloads the box,
	//       which pulls its editor out of the DOM, which makes Chrome fire a native blur that can
	//       re-enter here through onDismiss. Nulling first makes the re-entrant call a no-op —
	//       the same ordering as AnnotationMarker.hideReplyBox.
	hideReplyBox() {
		if (!this.reply_box)
			return;
		const reply_box = this.reply_box;
		this.reply_box = null;
		this.component.removeChild(reply_box);
	}

	destroy(dom: HTMLElement) {
		this.hideReplyBox();
		this.component.unload();
		this.thread?.remove();
		this.thread = null;
		super.destroy(dom);
	}
}

/**
 * EXPL: A second RangeSet rather than a branch inside annotationGutterMarkers: that field only
 *       recomputes on docChanged (marker.ts:685-686), and a draft's whole point is that it changes
 *       nothing in the document. The gutter's `markers` accessor already takes an array of
 *       RangeSets (base.ts:60), so joining one in costs nothing.
 *
 * EXPL: ONE marker instance is reused for the whole life of a draft, its anchor updated in place.
 *       This is the load-bearing decision in this file. CodeMirror decides whether to tear a
 *       marker's DOM down and rebuild it via `GutterMarker.compare` (identity first, then `eq`), and
 *       rebuilding the provisional card would destroy the ReplyBox the user is mid-sentence in.
 *       Constructing a fresh marker per transaction and leaning on `eq(from, to)` is NOT enough:
 *       any edit *before* the anchor maps the draft's from/to, so eq reports "changed" and the card
 *       is rebuilt — exactly the "type `abc`, fix a typo in the paragraph above, lose `abc`" bug.
 *       Instance identity has no such hole. (tests/pending_card.test.ts pins it.)
 *
 * EXPL: Reusing the instance means `update` MUTATES `annotation.from/to` in place, which is a
 *       StateField purity violation (the value held by `startState` changes under it) — tolerated
 *       because no consumer can observe the old value: nothing anywhere reads
 *       `startState.field(pendingAnnotationMarkers)`, and the one place CodeMirror compares old
 *       against new (`RangeSet.eq`, from SingleGutterView.update) compares the positions STORED in
 *       the range set's chunks plus point IDENTITY — never the marker's own fields.
 *       `annotationGutterMarkers` mutates its markers the same way, for the same reason.
 */
export const pendingAnnotationMarkers = StateField.define<RangeSet<PendingAnnotationMarker>>({
	create: () => RangeSet.empty,

	update(set, tr) {
		const draft = tr.state.field(commentDraftField);

		let marker: PendingAnnotationMarker | null = null;
		set.between(0, tr.startState.doc.length, (_from, _to, value) => {
			marker = value;
			return false;
		});
		// EXPL: `between`'s callback assigns through a closure, which TS's control-flow analysis
		//       cannot see, so it still believes `marker` is null here.
		const existing = marker as PendingAnnotationMarker | null;

		if (!draft) {
			// EXPL: Hand the outgoing marker back to CodeMirror unlatched, so GutterElement.setMarkers
			//       actually calls destroy() on it (and its Component unloads) instead of skipping the
			//       teardown the way it does for a marker that is merely moving between elements.
			if (existing)
				existing.preventUnload = false;
			return RangeSet.empty;
		}

		if (existing) {
			existing.annotation.from = draft.from;
			existing.annotation.to = draft.to;
			// EXPL: Latched while the draft lives. Without it, a marker re-homed to a different
			//       GutterElement gets toDOM()'d for the new element and THEN destroy()'d for the old
			//       one (AnnotationUpdateContext builds new elements before finish() destroys stale
			//       ones) — unloading the Component that the fresh card's ReplyBox was just added to,
			//       leaving a dead input on screen. Same reason AnnotationMarker latches it.
			existing.preventUnload = true;
			return RangeSet.of([existing.range(draft.from, draft.to)]);
		}

		// EXPL: `editorEditorField` is Obsidian's own StateField holding the EditorView — the same
		//       way marker.ts:599 gets a view inside annotationGutterMarkers' StateField, which
		//       otherwise has no access to one.
		const created = new PendingAnnotationMarker(draft.from, draft.to, tr.state.field(editorEditorField));
		created.preventUnload = true;
		return RangeSet.of([created.range(draft.from, draft.to)]);
	},
});
