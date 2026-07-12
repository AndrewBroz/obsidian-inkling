import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser, SuggestionType } from "../src/editor/base";
import type { CriticMarkupRange } from "../src/editor/base/ranges";
import {
	AuthorFilter,
	ContentFilter,
	filterRanges,
	LocationFilter,
	ResolvedFilter,
	SuggestionTypeFilter,
} from "../src/ui/pages/annotations-view/filter-ranges";
import { createRangeState } from "./helpers";

// EXPL: filterRanges only reads `plugin.settings` — a bare settings object is enough to drive
// the pure filtering pipeline under test.
function fakePlugin(settings: Partial<typeof DEFAULT_SETTINGS> = {}) {
	return <any> { settings: { ...DEFAULT_SETTINGS, ...settings } };
}

function rangesFor(doc: string): CriticMarkupRange[] {
	const state = createRangeState(doc, { enable_metadata: true });
	return state.field(rangeParser).ranges.ranges;
}

// EXPL: All non-resolved-filter args pinned to their ALL/VAULT values, matching how
// AnnotationsView.svelte always calls filterRanges with concrete filter state (never
// `undefined`) — content_filter in particular has no `undefined` guard in the pipeline, unlike
// range_type_filter, so passing `undefined` there silently narrows to empty-only ranges.
function filterByResolved(plugin: ReturnType<typeof fakePlugin>, items: any, resolved_filter: ResolvedFilter) {
	return filterRanges(
		plugin,
		items,
		"",
		LocationFilter.VAULT,
		SuggestionTypeFilter.ALL,
		ContentFilter.ALL,
		AuthorFilter.ALL,
		undefined,
		null,
		resolved_filter,
	);
}

describe("filterRanges / ResolvedFilter", () => {
	// EXPL: One vault with two files:
	//  - a.md: an unresolved plain comment thread, and a resolved plain comment thread.
	//  - b.md: an unresolved anchored (HIGHLIGHT) thread, a resolved anchored thread, and a
	//    standalone highlight with no replies (counts as unresolved — thread_resolved reads its
	//    own `done` field, and it has none).
	const doc_a = `x{>>open<<}y{>>{"done":true}@@closed<<}z`;
	const doc_b = `x{==sel1==}{>>reply1<<}y{=={"done":true}@@sel2==}{>>{"done":true}@@reply2<<}z{==standalone==}w`;

	const items = [
		["a.md", { data: rangesFor(doc_a), mtime: 0 }],
		["b.md", { data: rangesFor(doc_b), mtime: 0 }],
	] as any;

	test("ALL returns every top-level thread regardless of resolved state", () => {
		const result = filterByResolved(fakePlugin(), items, ResolvedFilter.ALL);
		// a.md: 2 top-level threads (open comment, closed comment)
		// b.md: 3 top-level threads (sel1 highlight, sel2 highlight, standalone highlight)
		expect(result).toHaveLength(5);
	});

	test("UNRESOLVED (default) excludes threads whose base carries done:true", () => {
		// EXPL: resolved_filter omitted entirely, exercising the function's own default
		// (ResolvedFilter.UNRESOLVED) rather than passing it explicitly.
		const result = filterRanges(
			fakePlugin(),
			items,
			"",
			LocationFilter.VAULT,
			SuggestionTypeFilter.ALL,
			ContentFilter.ALL,
			AuthorFilter.ALL,
			undefined,
			null,
		);
		expect(result).toHaveLength(3);
		expect(result.every((item) => item.range.fields.done !== true)).toBe(true);
	});

	test("RESOLVED keeps only threads whose base carries done:true", () => {
		const result = filterByResolved(fakePlugin(), items, ResolvedFilter.RESOLVED);
		expect(result).toHaveLength(2);
		expect(result.every((item) => item.range.fields.done === true)).toBe(true);
	});

	test("resolved filter applies even when metadata parsing is disabled (everything is unresolved)", () => {
		// EXPL: With enable_metadata off, `{"done":true}@@` never gets parsed as metadata, so no
		// range ever carries `done: true` — RESOLVED should therefore find nothing, and
		// UNRESOLVED should find everything.
		const doc = `x{>>a<<}y{>>b<<}z`;
		const state = createRangeState(doc, { enable_metadata: false });
		const ranges = state.field(rangeParser).ranges.ranges;
		const plain_items = [["c.md", { data: ranges, mtime: 0 }]] as any;
		const plugin = fakePlugin({ enable_metadata: false });

		expect(filterByResolved(plugin, plain_items, ResolvedFilter.RESOLVED)).toHaveLength(0);
		expect(filterByResolved(plugin, plain_items, ResolvedFilter.UNRESOLVED)).toHaveLength(2);
	});

	test("done-flagged standalone comment appears in resolved filter (resolvable)", () => {
		// EXPL: Regression test for the thread_resolvable fix. This test verifies that
		// done-flagged COMMENT ranges (which are resolvable) still appear correctly in the
		// RESOLVED filter. The fix adds thread_resolvable gating to prevent legacy
		// done-flagged SUGGESTION ranges from appearing in RESOLVED, while preserving
		// correct behavior for resolvable threads.
		const doc = `x{>>{"done":true}@@comment<<}y`;
		const state = createRangeState(doc, { enable_metadata: true });
		const ranges = state.field(rangeParser).ranges.ranges;
		const items = [["d.md", { data: ranges, mtime: 0 }]] as any;
		const plugin = fakePlugin();

		// A done-flagged COMMENT should appear in RESOLVED (correct behavior preserved)
		const resolved = filterByResolved(plugin, items, ResolvedFilter.RESOLVED);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].range.type).toBe(SuggestionType.COMMENT);

		// And not appear in UNRESOLVED
		const unresolved = filterByResolved(plugin, items, ResolvedFilter.UNRESOLVED);
		expect(unresolved).toHaveLength(0);
	});
});
