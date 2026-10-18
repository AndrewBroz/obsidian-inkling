import { deserialize, serialize } from "node:v8";
import { DATABASE_VERSION, DEFAULT_SETTINGS } from "../src/constants";
import { resolve_source } from "../src/editor/base/edit-logic/resolve";
import { getRangesInText, RANGE_PROTOTYPE_MAPPER, reviveCachedRanges } from "../src/editor/base/edit-util/range-parser";
import { type CriticMarkupRange, SuggestionType } from "../src/editor/base/ranges";

const DOC = `{=={"author":"A","time":1}@@some==}`;

// EXPL: A HIGHLIGHT exactly as a version-4 cache (the last one before attribute blocks) stored it: an own `fields`
//       and a numeric `metadata` offset, with no `own_fields` and no `meta`. Reattaching the prototype, which is
//       all the old loader did, leaves the stale own properties in charge.
function pre_attributes_highlight(): CriticMarkupRange {
	return {
		from: 0,
		to: DOC.length,
		type: SuggestionType.HIGHLIGHT,
		repr: "Highlight",
		text: "{==some==}",
		metadata: 26,
		fields: { author: "A", time: 1 },
		replies: [],
	} as unknown as CriticMarkupRange;
}

describe("vault cache entries from before attribute blocks", () => {
	test("reattaching the prototype alone would lose authorship on resolve", () => {
		// EXPL: Documents the hazard the version bump and the reviver guard against. Not a behaviour to keep.
		const stale = Object.setPrototypeOf(
			pre_attributes_highlight(),
			RANGE_PROTOTYPE_MAPPER[SuggestionType.HIGHLIGHT].prototype,
		) as CriticMarkupRange;
		const source = resolve_source(stale, DOC, { ...DEFAULT_SETTINGS, remove_on_resolve: false });
		expect(source).toBe(`{=={"done":true}@@some==}`);
	});

	test("the database version is past the last pre-attributes cache, so old caches are cleared and rebuilt", () => {
		expect(DATABASE_VERSION).toBeGreaterThan(4);
	});

	test("the reviver rejects an entry holding a pre-attributes range", () => {
		expect(reviveCachedRanges([pre_attributes_highlight()])).toBeUndefined();
	});

	test("the reviver restores prototypes on a current-shape entry", () => {
		const doc = `{++a++}{author=A}{=={"author":"B"}@@x==}{>>c<<}`;
		// EXPL: v8 (de)serialisation is the structured clone IndexedDB and worker messages apply: own properties only.
		const cloned = deserialize(serialize(getRangesInText(doc, DEFAULT_SETTINGS))) as CriticMarkupRange[];
		const revived = reviveCachedRanges(cloned)!;
		expect(revived).toBeDefined();
		expect(revived.map(range => range.constructor)).toEqual([
			RANGE_PROTOTYPE_MAPPER[SuggestionType.ADDITION],
			RANGE_PROTOTYPE_MAPPER[SuggestionType.HIGHLIGHT],
			RANGE_PROTOTYPE_MAPPER[SuggestionType.COMMENT],
		]);
		expect(revived.map(range => range.fields.author)).toEqual(["A", "B", undefined]);
	});
});
