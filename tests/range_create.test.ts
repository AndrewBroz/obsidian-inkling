import { DEFAULT_SETTINGS } from "../src/constants";
import { construct_range, create_anchored_comment, create_range } from "../src/editor/base/edit-util/range-create";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import { SuggestionType } from "../src/editor/base/ranges";

const parse = (doc: string) => getRangesInText(doc, { ...DEFAULT_SETTINGS, enable_metadata: true });

// EXPL: Legacy metadata is deprecated: construct_range writes an attribute block, and legacy only where a block would
//       lose something.
describe("construct_range", () => {
	test("an addition gets its block after the closer, start_offset at the opener", () => {
		const { insert, start_offset } = construct_range("new", "", SuggestionType.ADDITION, { author: "A" });
		expect(insert).toBe(`{++new++}{author=A}`);
		expect(start_offset).toBe(3);
	});

	test("a substitution gets its block after the closer, start_offset at the opener", () => {
		const { insert, start_offset, end_offset } = construct_range(
			"new",
			"old",
			SuggestionType.SUBSTITUTION,
			{ author: "A" },
		);
		expect(insert).toBe(`{~~old~>new~~}{author=A}`);
		expect(start_offset).toBe(3);
		expect(end_offset).toBe(2);
	});

	test("no fields writes no block", () => {
		expect(construct_range("x", "", SuggestionType.ADDITION, {}).insert).toBe("{++x++}");
		expect(construct_range("x", "", SuggestionType.ADDITION, undefined).insert).toBe("{++x++}");
	});

	test("falls back to legacy when the fields cannot round-trip, counting the JSON in start_offset", () => {
		const fields = { author: "A", tags: ["x"] } as any;
		const { insert, start_offset } = construct_range("x", "", SuggestionType.ADDITION, fields);
		expect(insert).toBe(`{++{"author":"A","tags":["x"]}@@x++}`);
		expect(start_offset).toBe(insert.indexOf("@@x") + 2);
	});

	test("create_range writes an attribute block that parses back", () => {
		const settings = { ...DEFAULT_SETTINGS, author: "Bea" };
		const insert = create_range(settings, SuggestionType.COMMENT, "hi");
		expect(insert).toMatch(/^\{>>hi<<\}\{author=Bea time=\d+\}$/);
		const [range] = parse(insert);
		expect(range.to).toBe(insert.length);
		expect(range.fields.author).toBe("Bea");
	});
});

describe("create_anchored_comment", () => {
	test("the anchor states nothing and inherits from the comment (thread rule 2)", () => {
		const insert = create_anchored_comment({ ...DEFAULT_SETTINGS, author: "A" }, "sel", "hi");
		expect(insert).toMatch(/^\{==sel==\}\{>>hi<<\}\{author=A time=\d+\}$/);
		const [anchor, comment] = parse(insert);
		expect(anchor.own_fields).toEqual({});
		expect(anchor.fields).toEqual(comment.fields);
	});
});

// EXPL: Task 11b. Content with an @@ round-trips in attribute form; only content whose text before its first @@ is a
//       JSON object would read back as legacy metadata, so it is written legacy.
describe("@@ in the content", () => {
	test("attributes keep content with an @@ and read back", () => {
		const { insert } = construct_range("a@@b", "", SuggestionType.ADDITION, { author: "A" });
		expect(insert).toBe("{++a@@b++}{author=A}");
		const [range] = parse(insert);
		expect(range.fields).toEqual({ author: "A" });
		expect(range.unwrap()).toBe("a@@b");
	});

	test("content that starts with a JSON object then @@ falls back to legacy", () => {
		const content = `{"x":1}@@b`;
		const { insert, start_offset } = construct_range(content, "", SuggestionType.ADDITION, { author: "A" });
		expect(insert).toBe(`{++{"author":"A"}@@${content}++}`);
		expect(start_offset).toBe(insert.indexOf(content));
		const [range] = parse(insert);
		expect(range.fields).toEqual({ author: "A" });
		expect(range.unwrap()).toBe(content);
	});

	test("set_metadata writes a block on a range whose content has an @@", () => {
		const doc = "{++a@@b++}";
		const [range] = parse(doc);
		const changes = range.set_metadata({ author: "A" });
		const out = changes.reduceRight((text, c) => text.slice(0, c.from) + c.insert + text.slice(c.to), doc);
		expect(out).toBe("{++a@@b++}{author=A}");
	});
});
