import { EditorState } from "@codemirror/state";
import { rangeParser } from "../src/editor/base";
import { DEFAULT_SETTINGS } from "../src/constants";
import { providePluginSettingsExtension } from "../src/editor/uix/extensions";
import type { CommentRange } from "../src/editor/base/ranges";

// EXPL: range-state.ts asked `tree.search([head.from, head.from])[0]` for a thread's anchor. A
//       closed-interval point search returns BOTH the head comment (which begins there) and the
//       anchor before it (which ends there -- touching counts). `[0]` then trusted whichever came
//       back first, in interval-tree TRAVERSAL order. That order reflects the tree's cached
//       structure, while range-state.ts otherwise keeps ranges "live" by mutating each surviving
//       node's key directly in place (`apply_offset` + `node.item.key.low/high` writes) whenever an
//       edit shifts it, without re-inserting or rebalancing. A large edit well before a thread,
//       later followed by an edit that lands inside one of the thread's own comments, is enough to
//       desync the tree's cached structure from the keys it's now holding: the search can come back
//       empty, or return the wrong range as `[0]`. Since only the picked range's `.replies` was
//       cleared, the other kept its stale ones -- or, as reproduced below, the code dereferenced
//       `undefined` outright because no match came back at all.
function stateWith(doc: string) {
	const settings = { ...DEFAULT_SETTINGS, enable_metadata: false };
	return EditorState.create({
		doc,
		extensions: [rangeParser, providePluginSettingsExtension(<any> { settings })],
	});
}

/** A structural fingerprint of every thread in the document: base position -> reply positions. */
function threadShape(state: EditorState) {
	const ranges = state.field(rangeParser).ranges;
	return ranges.ranges
		.filter(r => r.base_range === r)
		.map(base => `${base.from}:[${base.replies.map(r => r.from).join(",")}]`)
		.sort()
		.join(" ");
}

// "{==anchor==}" is 12 chars (indices 0-11), "{>>one<<}" is 9 chars (12-20), "{>>two<<}" is 9
// chars (21-29), then " tail" starts at index 30. Verified by direct count.
const TARGET = "{==anchor==}{>>one<<}{>>two<<} tail";

describe("thread reconstruction is deterministic", () => {
	test("a thread parsed from scratch has the anchor as its base and both comments as replies", () => {
		const shape = threadShape(stateWith(TARGET));
		// anchor at 0; the two comments are its replies at 12 and 21. The comments' own base_range
		// resolves to the anchor (not themselves), so no other base ranges show up here.
		expect(shape).toBe("0:[12,21]");
	});

	test("the same document reached by INCREMENTAL EDITS has the identical thread shape", () => {
		// Build it up one insertion at a time — this is what rebalances the interval tree.
		let state = stateWith("{==anchor==} tail");
		state = state.update({ changes: { from: 12, to: 12, insert: "{>>one<<}" } }).state;
		state = state.update({ changes: { from: 21, to: 21, insert: "{>>two<<}" } }).state;

		expect(state.doc.toString()).toBe(TARGET);
		expect(threadShape(state)).toBe(threadShape(stateWith(TARGET)));
	});

	// EXPL: This is the test that actually catches the bug, and it took real trial and error to pin
	//       down. What did NOT reproduce it, even after dozens of iterations: editing only the
	//       trailing text after a thread; touching a single thread's own anchor/head boundary
	//       in isolation; or building the same final document via two different incremental
	//       histories (both of those stay identical, because the interval tree's in-order
	//       traversal happens to already be sorted by position in those cases).
	//
	//       What DID reproduce it, reliably, on the FIRST attempt: a bare 3-comment chain
	//       (A is its own base/head, B and C are replies), a SINGLE large edit well before the
	//       chain (shifting every downstream range's key via the direct-mutation offset path,
	//       without any tree rebalancing), followed by an edit landing INSIDE the last comment
	//       (C) only -- which makes just [B, C] "dangling" and re-triggers reconstruction with
	//       head=B, requiring a fresh `search([B.from, B.from])` to relocate A as B's anchor.
	//       On the unfixed code this throws `TypeError: Cannot read properties of undefined
	//       (reading 'replies')` on the very next edit inside C: the search came back with NO
	//       matches at all (neither A nor B), so `adjacent_range` was `undefined` and the
	//       unconditional `adjacent_range!.replies.length = 0` dereferenced it. That is the same
	//       defect the brief describes (an unverified pick from `search(...)[0]`), just caught at
	//       its most severe: not silent duplication, but a crash, because there was nothing at
	//       index 0 to silently misattribute replies to. It reproduced at every padding length
	//       from 8 characters up; smaller paddings didn't shift the tree far enough to desync it.
	test("editing inside a thread's comment, after an earlier edit far before it, does not corrupt or crash", () => {
		// "text " (5) + "{>>A<<}" (7, 5-12) + "{>>B<<}" (7, 12-19) + "{>>Ctext<<}" (11, 19-30) + " tail".
		let state = stateWith("text {>>A<<}{>>B<<}{>>Ctext<<} tail");

		// One large edit far before the thread. This is what desyncs the interval tree: every
		// range from here on has its key updated by direct mutation, never by a rebalancing
		// insert, so the tree's cached structure stops matching the keys it holds.
		state = state.update({ changes: { from: 0, to: 0, insert: "PADDING_TEXT_HERE_" } }).state;

		for (let iter = 0; iter < 20; iter++) {
			const ranges = state.field(rangeParser).ranges.ranges;
			const c = ranges.find(r => r.text.includes("Ctext"));
			expect(c).toBeDefined();

			// Edit strictly INSIDE C's text, never touching its brackets/boundary.
			const editPos = c!.to - 3;
			expect(() => {
				state = state.update({ changes: { from: editPos, to: editPos, insert: "x" } }).state;
			}).not.toThrow();
		}

		const ranges = state.field(rangeParser).ranges;
		const bases = ranges.ranges.filter(r => r.base_range === r);

		// Exactly one base (A) for this one bare thread -- no spurious duplicate base objects.
		expect(bases).toHaveLength(1);
		const base = bases[0];

		// A must not appear as a reply of itself, and must have exactly its original two replies
		// (B and C), with no duplicates.
		expect(base.replies.map(r => r.from)).not.toContain(base.from);
		expect(base.replies).toHaveLength(2);
		expect(new Set(base.replies.map(r => r.from)).size).toBe(2);
	});

	test("a BARE comment thread (no anchor) has the head comment as its own base", () => {
		const state = stateWith("text {>>one<<}{>>two<<}");
		const ranges = state.field(rangeParser).ranges;
		const head = ranges.ranges[0] as CommentRange;
		expect(head.attached_comment).toBeNull();
		expect(head.replies).toHaveLength(1);
	});
});
