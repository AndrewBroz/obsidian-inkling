import { DEFAULT_SETTINGS } from "../src/constants";
import { write_syntax } from "../src/editor/base/edit-util/metadata";
import { construct_range, create_anchored_comment, create_range } from "../src/editor/base/edit-util/range-create";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import { SuggestionType } from "../src/editor/base/ranges";

const parse = (doc: string) => getRangesInText(doc, { ...DEFAULT_SETTINGS, enable_metadata: true });

describe("construct_range by syntax", () => {
	test("legacy puts the JSON after the opener and counts it in start_offset", () => {
		const { insert, start_offset } = construct_range("new", "", SuggestionType.ADDITION, { author: "A" });
		expect(insert).toBe(`{++{"author":"A"}@@new++}`);
		expect(start_offset).toBe(3 + `{"author":"A"}@@`.length);
	});

	test("attributes put the block after the closer and leave start_offset at the opener", () => {
		const { insert, start_offset, end_offset } = construct_range(
			"new",
			"old",
			SuggestionType.SUBSTITUTION,
			{ author: "A" },
			0,
			0,
			"attributes",
		);
		expect(insert).toBe(`{~~old~>new~~}{author=A}`);
		expect(start_offset).toBe(3);
		expect(end_offset).toBe(2);
	});

	test("no fields writes no block in either syntax", () => {
		expect(construct_range("x", "", SuggestionType.ADDITION, {}, 0, 0, "attributes").insert).toBe("{++x++}");
		expect(construct_range("x", "", SuggestionType.ADDITION, undefined, 0, 0, "attributes").insert).toBe("{++x++}");
	});

	test("attributes fall back to legacy when the fields cannot round-trip", () => {
		const fields = { author: "A", tags: ["x"] } as any;
		const { insert, start_offset } = construct_range("x", "", SuggestionType.ADDITION, fields, 0, 0, "attributes");
		expect(insert).toBe(`{++{"author":"A","tags":["x"]}@@x++}`);
		expect(start_offset).toBe(insert.indexOf("@@x") + 2);
	});

	test("create_range follows the setting and its output parses back", () => {
		const settings = { ...DEFAULT_SETTINGS, author: "Bea", metadata_syntax: "attributes" as const };
		const insert = create_range(settings, SuggestionType.COMMENT, "hi");
		expect(insert).toMatch(/^\{>>hi<<\}\{author=Bea time=\d+\}$/);
		const [range] = parse(insert);
		expect(range.to).toBe(insert.length);
		expect(range.fields.author).toBe("Bea");
	});
});

describe("write_syntax", () => {
	test("attributes if the setting or any range is attributes", () => {
		const [legacy] = parse(`{++{"author":"A"}@@a++}`);
		const [attrs] = parse(`{++a++}{author=A}`);
		expect(write_syntax("legacy")).toBe("legacy");
		expect(write_syntax("legacy", legacy)).toBe("legacy");
		expect(write_syntax("legacy", legacy, attrs)).toBe("attributes");
		expect(write_syntax("attributes", legacy)).toBe("attributes");
		expect(write_syntax("legacy", undefined)).toBe("legacy");
	});
});

describe("create_anchored_comment", () => {
	const at = (metadata_syntax: "legacy" | "attributes") => ({ ...DEFAULT_SETTINGS, author: "A", metadata_syntax });

	test("attributes: the anchor states nothing and inherits from the comment", () => {
		const insert = create_anchored_comment(at("attributes"), "sel", "hi");
		expect(insert).toMatch(/^\{==sel==\}\{>>hi<<\}\{author=A time=\d+\}$/);
		const [anchor, comment] = parse(insert);
		expect(anchor.own_fields).toEqual({});
		expect(anchor.fields).toEqual(comment.fields);
	});

	test("legacy: both carry the same fields (rule 2 is attributes-only)", () => {
		const insert = create_anchored_comment(at("legacy"), "sel", "");
		const [anchor, comment] = parse(insert);
		expect(anchor.own_fields).toEqual(comment.own_fields);
		expect(anchor.own_fields.author).toBe("A");
	});
});

// EXPL: Task 11b. Content with an @@ round-trips in attribute form; only content whose text before its first @@ is a
//       JSON object would read back as legacy metadata, so it is written legacy.
describe("@@ in the content", () => {
	test("attributes keep content with an @@ and read back", () => {
		const { insert } = construct_range("a@@b", "", SuggestionType.ADDITION, { author: "A" }, 0, 0, "attributes");
		expect(insert).toBe("{++a@@b++}{author=A}");
		const [range] = parse(insert);
		expect(range.fields).toEqual({ author: "A" });
		expect(range.unwrap()).toBe("a@@b");
	});

	test("content that starts with a JSON object then @@ falls back to legacy", () => {
		const content = `{"x":1}@@b`;
		const { insert, start_offset } = construct_range(
			content,
			"",
			SuggestionType.ADDITION,
			{ author: "A" },
			0,
			0,
			"attributes",
		);
		expect(insert).toBe(`{++{"author":"A"}@@${content}++}`);
		expect(start_offset).toBe(insert.indexOf(content));
		const [range] = parse(insert);
		expect(range.fields).toEqual({ author: "A" });
		expect(range.unwrap()).toBe(content);
	});

	test("set_metadata writes a block on a range whose content has an @@", () => {
		const doc = "{++a@@b++}";
		const [range] = parse(doc);
		const changes = range.set_metadata({ author: "A" }, "attributes");
		const out = changes.reduceRight((text, c) => text.slice(0, c.from) + c.insert + text.slice(c.to), doc);
		expect(out).toBe("{++a@@b++}{author=A}");
	});
});
