import { EditorState } from "@codemirror/state";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser, SuggestionType } from "../src/editor/base";
import type { EditorSuggestion } from "../src/editor/base/edit-handler";
import { mark_ranges, MarkAction, type MarkType } from "../src/editor/base/edit-logic/mark";
import type { MetadataFields } from "../src/editor/base/ranges";
import { providePluginSettingsExtension } from "../src/editor/uix/extensions";

// EXPL: Bare `extensions: [rangeParser]` crashes ("Field is not present in this state") per
// Tasks 5/7/8 test-infrastructure findings (see tests/range_correcter.test.ts,
// tests/range_metadata.test.ts). A settings extension must always be provided. enable_metadata
// is turned on so the last (metadata) case can parse; the plain-text cases carry no metadata
// in their source docs, so mark_ranges only ADDS metadata when metadata_fields is explicitly
// passed -- enabling parsing of metadata does not change their expected output.
const pluginSettingsField = providePluginSettingsExtension(
	<any> { settings: { ...DEFAULT_SETTINGS, enable_metadata: true, enable_author_metadata: true } },
);

function mark(
	doc: string,
	from: number,
	to: number,
	inserted: string,
	type: MarkType,
	metadata_fields?: MetadataFields,
): string {
	const state = EditorState.create({ doc, extensions: [rangeParser, pluginSettingsField] });
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

// EXPL: Characterization tests — they pin down CURRENT behavior of the branches
//       mark.ts itself flags as uncertain (its TODO/FIXME comments), so any later
//       change to this logic trips a snapshot diff and gets reviewed deliberately.
//       Four cases below are annotated // BUG: — they pin reject-all-corrupting behavior deliberately.
describe("mark_ranges characterization (snapshot-pinned)", () => {
	const cases: [string, string, number, number, string, MarkType][] = [
		["insert inside existing addition", "he{++llo++}", 7, 7, "y", SuggestionType.ADDITION],
		["insert at right edge of addition", "he{++llo++}x", 11, 11, "y", SuggestionType.ADDITION],
		// BUG: reject-all discrepancy — pre-edit reject-all gives "abef", post-edit gives "abcdef" (resurrects "cd").
		// Fix tracked for a later phase; do NOT update this snapshot to hide the discrepancy.
		["delete spanning plain text and addition", "ab{++cd++}ef", 0, 12, "", SuggestionType.DELETION],
		["delete inside existing deletion", "ab{--cd--}ef", 5, 6, "", SuggestionType.DELETION],
		// BUG: reject-all discrepancy — pre-edit reject-all gives "xyu", post-edit gives "xyzu" (resurrects "z").
		// Fix tracked for a later phase; do NOT update this snapshot to hide the discrepancy.
		["substitution across existing substitution", "x{~~y~>z~~}u", 0, 12, "new", SuggestionType.SUBSTITUTION],
		// BUG: reject-all discrepancy — pre-edit reject-all gives "uvz", post-edit gives "uvwyz" (resurrects "w" and "y").
		// Fix tracked for a later phase; do NOT update this snapshot to hide the discrepancy.
		["substitution spanning two adjacent ranges", "uv{++w++}{++y++}z", 0, 17, "q", SuggestionType.SUBSTITUTION],
		["deletion across highlight range", "ab{==cd==}ef", 0, 12, "", SuggestionType.DELETION],
		["clear action on marked text", "hello{++ big++} world", 0, 21, "", MarkAction.CLEAR],
		["insert between two additions", "uv{++w++}{++y++}z", 9, 9, "x", SuggestionType.ADDITION],
		// BUG: reject-all discrepancy — pre-edit reject-all gives "abef", post-edit gives "abcdef" (resurrects "cd").
		// Fix tracked for a later phase; do NOT update this snapshot to hide the discrepancy.
		["delete exactly an addition's contents", "ab{++cd++}ef", 5, 7, "", SuggestionType.DELETION],
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
