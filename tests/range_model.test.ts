import { DEFAULT_SETTINGS } from "../src/constants";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import type { SubstitutionRange } from "../src/editor/base/ranges";

const parse = (doc: string) => getRangesInText(doc, { ...DEFAULT_SETTINGS, enable_metadata: true });

describe("range model (legacy metadata)", () => {
	test("meta covers the JSON and its @@", () => {
		const doc = `x{++{"author":"A"}@@ab++}y`;
		const [range] = parse(doc);
		expect(range.meta).toEqual({ syntax: "legacy", from: 4, to: doc.indexOf("ab") });
		expect(range.own_fields).toEqual({ author: "A" });
		expect(range.fields).toEqual({ author: "A" });
		expect(range.closer_to).toBe(range.to);
	});

	test("length and empty() ignore metadata", () => {
		const [filled] = parse(`{++{"author":"A"}@@ab++}`);
		expect(filled.length).toBe(2);
		expect(filled.empty()).toBe(false);
		const [empty] = parse(`{>>{"author":"A"}@@<<}`);
		expect(empty.length).toBe(0);
		expect(empty.empty()).toBe(true);
	});

	test("an empty substitution with metadata is empty", () => {
		const [range] = parse(`{~~{"author":"A"}@@~>~~}`) as SubstitutionRange[];
		expect(range.empty()).toBe(true);
		expect(range.part_is_empty(true)).toBe(true);
		expect(range.part_is_empty(false)).toBe(true);
	});

	test("apply_offset moves meta without touching a copy", () => {
		const [range] = parse(`{++{"author":"A"}@@ab++}`);
		const copy = range.copy();
		range.apply_offset(5);
		expect(range.meta!.from).toBe(copy.meta!.from + 5);
		expect(copy.meta!.from).toBe(3);
	});
});
