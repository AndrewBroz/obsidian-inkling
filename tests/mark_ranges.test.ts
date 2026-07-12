import { applyToText, rangeParser, SuggestionType } from "../src/editor/base";
import type { EditorSuggestion } from "../src/editor/base/edit-handler";
import { mark_ranges, MarkAction, type MarkType } from "../src/editor/base/edit-logic/mark";
import type { MetadataFields } from "../src/editor/base/ranges";
import { createRangeState } from "./helpers";

// EXPL: Bare `extensions: [rangeParser]` crashes ("Field is not present in this state") per
// Tasks 5/7/8 test-infrastructure findings (see tests/range_correcter.test.ts,
// tests/range_metadata.test.ts). A settings extension must always be provided. enable_metadata
// is turned on so the last (metadata) case can parse; the plain-text cases carry no metadata
// in their source docs, so mark_ranges only ADDS metadata when metadata_fields is explicitly
// passed -- enabling parsing of metadata does not change their expected output.
function mark(
	doc: string,
	from: number,
	to: number,
	inserted: string,
	type: MarkType,
	metadata_fields?: MetadataFields,
): string {
	const state = createRangeState(doc, { enable_metadata: true, enable_author_metadata: true });
	const ranges = state.field(rangeParser).ranges;
	const edits: EditorSuggestion[] = mark_ranges(ranges, state.doc, from, to, inserted, type, metadata_fields);

	// EXPL: edits must never overlap — overlapping edits would corrupt the document
	const ordered = [...edits].sort((a, b) => a.from - b.from);
	for (let i = 1; i < ordered.length; i++)
		expect(ordered[i].from).toBeGreaterThanOrEqual(ordered[i - 1].to);

	let output = doc;
	for (const edit of [...ordered].reverse())
		output = output.slice(0, edit.from) + edit.insert + output.slice(edit.to);
	return output;
}

function accept_all(doc: string): string {
	const state = createRangeState(doc);
	return applyToText(doc, (range) => range.accept(), state.field(rangeParser).ranges.ranges);
}

function reject_all(doc: string): string {
	const state = createRangeState(doc);
	return applyToText(doc, (range) => range.reject(), state.field(rangeParser).ranges.ranges);
}

describe("mark_ranges in plain text", () => {
	test("insertion wraps in addition markup", () => {
		expect(mark("hello world", 5, 5, " big", SuggestionType.ADDITION)).toBe("hello{++ big++} world");
	});

	test("deletion wraps in deletion markup", () => {
		expect(mark("hello world", 5, 11, "", SuggestionType.DELETION)).toBe("hello{-- world--}");
	});

	test("replacement wraps in substitution markup", () => {
		expect(mark("hello world", 6, 11, "there", SuggestionType.SUBSTITUTION)).toBe("hello {~~world~>there~~}");
	});

	test("insertion with metadata prepends the metadata block", () => {
		expect(mark("hello world", 5, 5, " big", SuggestionType.ADDITION, { author: "A" }))
			.toBe(`hello{++{"author":"A"}@@ big++} world`);
	});
});

describe("marking over pending additions consumes them (reject-all safety)", () => {
	// [name, doc, from, to, inserted, type, expected output, expected accept-all]
	const cases: [string, string, number, number, string, MarkType, string, string][] = [
		["delete spanning plain text and addition", "ab{++cd++}ef", 0, 12, "", SuggestionType.DELETION, "{--abef--}", ""],
		["delete exactly an addition's contents", "ab{++cd++}ef", 5, 7, "", SuggestionType.DELETION, "abef", "abef"],
		[
			"delete over an addition, ending inside the next range's bracket",
			"ab{++cd++}{--x--}ef",
			2,
			12,
			"",
			SuggestionType.DELETION,
			"ab{--x--}ef",
			"abef",
		],
		[
			"substitution across existing substitution",
			"x{~~y~>z~~}u",
			0,
			12,
			"new",
			SuggestionType.SUBSTITUTION,
			"{~~xyu~>new~~}",
			"new",
		],
		[
			"substitution spanning two adjacent ranges",
			"uv{++w++}{++y++}z",
			0,
			17,
			"q",
			SuggestionType.SUBSTITUTION,
			"{~~uvz~>q~~}",
			"q",
		],
	];

	for (const [name, doc, from, to, inserted, type, expected, accept_expected] of cases) {
		test(name, () => {
			const output = mark(doc, from, to, inserted, type);
			expect(output).toBe(expected);
			// EXPL: The data-safety invariants this fix exists for:
			//       reject-all must restore what reject-all on the input would give,
			//       and accept-all must be unchanged from pre-fix behavior.
			expect(reject_all(output)).toBe(reject_all(doc));
			expect(accept_all(output)).toBe(accept_expected);
		});
	}
});

// EXPL: Characterization tests — they pin down CURRENT behavior of the branches
//       mark.ts itself flags as uncertain (its TODO/FIXME comments), so any later
//       change to this logic trips a snapshot diff and gets reviewed deliberately.
describe("mark_ranges characterization (snapshot-pinned)", () => {
	const cases: [string, string, number, number, string, MarkType][] = [
		["insert inside existing addition", "he{++llo++}", 7, 7, "y", SuggestionType.ADDITION],
		["insert at right edge of addition", "he{++llo++}x", 11, 11, "y", SuggestionType.ADDITION],
		["delete inside existing deletion", "ab{--cd--}ef", 5, 6, "", SuggestionType.DELETION],
		["deletion across highlight range", "ab{==cd==}ef", 0, 12, "", SuggestionType.DELETION],
		["clear action on marked text", "hello{++ big++} world", 0, 21, "", MarkAction.CLEAR],
		["insert between two additions", "uv{++w++}{++y++}z", 9, 9, "x", SuggestionType.ADDITION],
	];

	for (const [name, doc, from, to, inserted, type] of cases) {
		test(name, () => {
			expect(mark(doc, from, to, inserted, type)).toMatchSnapshot();
		});
	}

	test("insert into range with different author is kept outside that range", () => {
		expect(mark(`a{++{"author":"B"}@@bc++}d`, 21, 21, "x", SuggestionType.ADDITION, { author: "A" }))
			.toMatchSnapshot();
	});
});
