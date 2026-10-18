import { DocInput } from "@codemirror/language";
import { EditorState, StateField } from "@codemirror/state";
import { type Interval, Node } from "@flatten-js/interval-tree";
import { type ChangedRange, type Tree, TreeFragment } from "@lezer/common";

import { CommentRange, CriticMarkupRange, CriticMarkupRanges, SuggestionType } from "../ranges";

import { criticmarkupLanguage } from "@fevol/lang-criticmarkup";
import { fullReloadEffect } from "../../settings";
import { pluginSettingsField } from "../../uix";
import { parseAttrBlock } from "./attributes";
import { cursorGenerateRanges } from "./range-parser";

interface ParserData {
	tree: Tree;
	fragments: readonly TreeFragment[];
	ranges: CriticMarkupRanges;
	inserted_ranges: CriticMarkupRange[];
	deleted_ranges: CriticMarkupRange[];
}

export const rangeParser: StateField<ParserData> = StateField.define({
	create(state) {
		const text = state.doc.toString();
		const tree = criticmarkupLanguage.parser.parse(text);
		const settings = state.field(pluginSettingsField);
		const ranges = new CriticMarkupRanges(cursorGenerateRanges(tree, text, settings));
		return {
			tree,
			fragments: TreeFragment.addTree(tree),
			ranges: ranges,
			inserted_ranges: ranges.ranges,
			deleted_ranges: [],
		};
	},

	update(value: ParserData, tr) {
		const settings = tr.state.field(pluginSettingsField);
		if (tr.effects.some(effect => effect.is(fullReloadEffect)))
			return this.create(tr.state) as ParserData;

		if (!tr.docChanged) {
			value.inserted_ranges = [];
			value.deleted_ranges = [];
			return value;
		}

		// The below times are based on stress-test (250.000 words, 56.167 ranges)
		// get-changes: 0.01 - 0.05 ms
		const changed_ranges: ChangedRange[] = [];
		tr.changes.iterChangedRanges((from, to, fromB, toB) =>
			changed_ranges.push({ fromA: from, toA: to, fromB: fromB, toB: toB })
		);

		// fragment-update: 0.01 - 0.08 ms
		let fragments = TreeFragment.applyChanges(value.fragments, changed_ranges);
		// stringify-doc: 0.98 - 8.99 ms
		const text = tr.state.doc.toString();
		// parse-doc: 0.68 - 1.24 ms
		const tree = criticmarkupLanguage.parser.parse(new DocInput(tr.state.doc), fragments);
		// apply-fragments: <0.01 ms
		fragments = TreeFragment.addTree(tree, fragments);

		// regenerate-ranges: 0.20 - 0.55 ms
		const inserted_set = new Map<number, CriticMarkupRange>();
		const offsets: [number, number][] = [];
		const dangling_comments = new Map<number, CommentRange>();
		const deleted_ranges: Set<CriticMarkupRange> = new Set();
		const to_old = tr.changes.invertedDesc;
		// EXPL: A trailing attribute block is text after a range's closer, so an edit can turn the text after a
		//       range into a valid block without touching the range: deleting ` x` from `{++a++}{k=1 x}` grows it.
		//       Such a block covers the edit and starts right at the owner's closer. Blocks never span lines, so
		//       only ranges on the edit's line can own one; ranges quoted inside the new block lie between the
		//       owner and the edit, so the whole line is walked. A range that already has a block is skipped
		//       without parsing: it did not touch the edit, so its block ends before it.
		const old_ranges = value.ranges.ranges;
		function newBlockOwnerStart(fromA: number, fromB: number): number | undefined {
			let low = 0, high = old_ranges.length;
			while (low < high) {
				const mid = (low + high) >> 1;
				if (old_ranges[mid].from < fromA) low = mid + 1;
				else high = mid;
			}
			const line_start = tr.startState.doc.lineAt(fromA).from;
			let start: number | undefined = undefined;
			for (let i = low - 1; i >= 0 && old_ranges[i].to >= line_start; i--) {
				const range = old_ranges[i];
				if (range.meta) continue;
				const at = tr.changes.mapPos(range.closer_to);
				if (text[at] !== "{") continue;
				const block = parseAttrBlock(text, at);
				if (block && block.to >= fromB) start = range.from;
			}
			return start;
		}

		for (const changed_range of changed_ranges) {
			// EXPL: Regenerate from the earliest of: the edit, every range it invalidated, and a possible block owner
			//       (all mapped into the new document), up to the end of the edit or of every range it invalidated: a
			//       block that stops being valid exposes the ranges quoted inside it, which may lie past the edit.
			//       Starting earlier re-collects ranges the edit did not touch: the parser is left-inclusive, so it
			//       yields the left neighbour that ends at an invalidated range's `from`, and ranges left stale
			//       inside a malformed node are yielded again too. Those are still in the tree, so inserting them
			//       would put two range objects at one position; a regenerated range identical to one still in the
			//       tree (at its position before this transaction) is skipped. A regenerated range that differs
			//       replaces every untouched range it overlaps (a block owner that grew, a range now quoted inside
			//       its block).
			let regenerate_from = changed_range.fromB, regenerate_to = changed_range.toB;
			const invalidate = (range: CriticMarkupRange, key: Interval | [number, number]) => {
				value.ranges.tree.remove(key, range);
				deleted_ranges.add(range);
				for (const reply of range.base_range.thread)
					dangling_comments.set(reply.from, reply);
				regenerate_from = Math.min(regenerate_from, tr.changes.mapPos(range.from, -1));
				regenerate_to = Math.max(regenerate_to, tr.changes.mapPos(range.to, 1));
			};
			value.ranges.tree
				.search([changed_range.fromA, changed_range.toA], (range: CriticMarkupRange, key: Interval) => {
					invalidate(range, key);
					return true;
				});
			const owner_start = settings.enable_metadata ?
				newBlockOwnerStart(changed_range.fromA, changed_range.fromB) :
				undefined;
			if (owner_start !== undefined)
				regenerate_from = Math.min(regenerate_from, tr.changes.mapPos(owner_start, -1));

			// EXPL: A replaced range can lie outside the span just regenerated, so regenerate again until the span
			//       stops growing. The grammar does not know blocks and can misread a quoted `{++x"` inside one as
			//       an opener, possibly closed lines later. Only the block's owner, met first, makes the parser skip
			//       that node, but when regeneration starts after the owner the node becomes a range. That range
			//       overlaps the owner and replaces it, so the next pass starts at the owner and skips the node; each
			//       pass discards what earlier passes yielded inside its span, or the misread range would survive.
			let generated: [number, number] | undefined = undefined;
			while (!generated || regenerate_from < generated[0] || regenerate_to > generated[1]) {
				generated = [regenerate_from, regenerate_to];
				for (const from of inserted_set.keys()) {
					if (generated[0] <= from && from <= generated[1])
						inserted_set.delete(from);
				}
				for (const range of cursorGenerateRanges(tree, text, settings, ...generated)) {
					const from = to_old.mapPos(range.from, -1), to = to_old.mapPos(range.to, 1);
					const overlapped = value.ranges.tree.search([from, to]) as CriticMarkupRange[];
					if (overlapped.some(old => old.from === from && old.to === to && old.type === range.type))
						continue;
					for (const old of overlapped) {
						if (old.from < to && from < old.to)
							invalidate(old, [old.from, old.to]);
					}
					inserted_set.set(range.from, range);
				}
			}
			offsets.push([
				changed_range.toA,
				changed_range.toB - changed_range.fromB - (changed_range.toA - changed_range.fromA),
			]);
		}
		for (const deleted_range of deleted_ranges) {
			if (deleted_range.type === SuggestionType.COMMENT)
				dangling_comments.delete(deleted_range.from);
		}

		let cumulative_offset = 0;

		// apply-offsets: 2.72-3.70 ms
		const nil_node = value.ranges.tree.nil_node;
		// EXPL: Keys are shifted IN PLACE rather than rebuilding the tree -- a deliberate optimisation, and
		//       the reason this traversal exists at all. But the tree is an AUGMENTED red-black tree: every
		//       node caches `max`, the widest interval in its subtree, and `search()` prunes a subtree
		//       outright when `left.max.high < search.low` (Node.not_intersect_left_subtree). Shifting a key
		//       without refreshing `max` leaves that cache stale, and a stale `max` makes the tree prune
		//       subtrees that DO contain matches: `search()` then silently returns INCOMPLETE results, the
		//       ranges an edit invalidated are never removed (only regenerated), and the document ends up
		//       with two range objects at one position -- which Accept All composes into overlapping changes
		//       and corrupts the text with.
		//
		//       Two traversal orders are in play here, and they are NOT the same one:
		//
		//       - The key shift must run IN-ORDER. `offsets` is a queue consumed in ascending key order, so
		//         the node's OLD `key.low` has to be read while the queue is still positioned at it.
		//       - `max` must be recomputed BOTTOM-UP (post-order). A node's max is defined over its own key
		//         AND both children's maxes, so every child must already be final when the parent is
		//         computed. Hence `update_max()` sits after BOTH subtree visits -- by which point this
		//         node's key has been shifted (above) and both children have been recomputed.
		//
		//       `Node.update_max()` is the library's own routine and REASSIGNS `node.max`. The hand-rolled
		//       fixup this replaces wrote to `node.max.low` / `node.max.high` instead -- and `Interval`'s
		//       `get max()` returns a CLONE, so those writes landed in a throwaway object and were discarded.
		//       It was a no-op, on top of computing the wrong invariant.
		function visitNode(node: Node<CriticMarkupRange>) {
			if (node != null && node != nil_node) {
				visitNode(node.left);
				while (offsets.length && node.item.key.low >= offsets[0][0])
					cumulative_offset += offsets.shift()![1];
				node.item.value.apply_offset(cumulative_offset);
				node.item.key.low = node.item.value.from;
				node.item.key.high = node.item.value.to;
				visitNode(node.right);
				node.update_max();
			}
		}
		visitNode(value.ranges.tree.root!);
		const inserted_ranges = Array.from(inserted_set.values());

		// insert-new-ranges: <0.01 - 0.05 ms
		for (const range of inserted_ranges)
			value.ranges.tree.insert([range.from, range.to], range);

		// comments-thread-reconstruction: <0.01 - 0.05 ms
		for (const range of inserted_ranges) {
			if (range.type === SuggestionType.COMMENT)
				dangling_comments.set(range.from, range as CommentRange);
		}

		if (dangling_comments.size) {
			const comment_threads: CommentRange[][] = [];
			let last_range: CommentRange | undefined = undefined;
			let current_thread: CommentRange[] = [];
			for (const range of Array.from(dangling_comments.values()).sort((a, b) => a.from - b.from)) {
				range.clear_references();
				range.replies.length = 0;

				if (!last_range || last_range?.right_adjacent(range))
					current_thread.push(range);
				else {
					comment_threads.push(current_thread);
					current_thread = [range];
				}
				last_range = range;
			}
			comment_threads.push(current_thread);

			for (const thread of comment_threads) {
				const head = thread[0];

				// EXPL: The anchor is the range immediately to the LEFT of the head -- the one whose `to`
				//       is the head's `from`. It is never the head itself.
				//
				//       This used to be `search([head.from, head.from])[0]`. A closed-interval point
				//       search returns BOTH the head (it begins there) and the anchor (it ends there --
				//       touching counts), and `[0]` picked one in interval-tree TRAVERSAL order, which is
				//       not document order and which shifts as the tree rebalances during editing. So the
				//       same document rebuilt its threads differently on different keystrokes, and since
				//       only the picked range's `replies` was cleared, the other kept its stale ones.
				//       That was the duplication.
				const anchor = (value.ranges.tree.search([head.from, head.from]) as CriticMarkupRange[])
					.find(range => range !== head && range.to === head.from);

				// No anchor => this is a bare thread and the head is its own base.
				const base = anchor ?? head;

				base.replies.length = 0;
				for (const comment of thread.slice(base === head ? 1 : 0))
					comment.add_reply(base);
			}
		}

		// finalize: 1.80 - 1.85 ms
		value.ranges.ranges = value.ranges.tree.values;

		return { tree, ranges: value.ranges, fragments, inserted_ranges, deleted_ranges: [...deleted_ranges] };
	},
});

export function selectionContainsRanges(state: EditorState) {
	const ranges = state.field(rangeParser).ranges;
	return ranges.ranges.length ?
		state.selection.ranges.some(range => ranges.contains_range(range.from, range.to)) :
		false;
}
