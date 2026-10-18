import { DEFAULT_SETTINGS } from "../src/constants";
import { write_syntax } from "../src/editor/base/edit-util/metadata";
import { construct_range, create_range } from "../src/editor/base/edit-util/range-create";
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
