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

// EXPL: The underlying document text: every suggestion rejected, and highlight markup (an
//       annotation, not text) removed. base_text(output) === base_text(input) is a COMPLEMENTARY
//       REJECT-SIDE CHECK: no character of the user's text was invented or lost on the reject path.
//       It is not the whole data-safety story, and must not be mistaken for it —
//
//         - it is blind to the ACCEPT-side truncation bug this very task fixed:
//           base_text("{--ab--}{==cd==}{--ef--}") === "abcdef" === base_text("ab{==cd==}ef"),
//           yet accepting the left output keeps "cd" — the deletion never covered it. `accept_all`
//           is what catches truncation, and every test below asserts it too;
//         - it is blind to comment prose, which reject_all removes entirely.
//
//       Why the highlight is not preserved through a deletion: rejecting a deletion that swallowed
//       highlighted text cannot restore the highlight's brackets. That is a TRADE-OFF, not an
//       impossibility. A flat encoding does exist —
//
//           {--ab{==--}{--cd--}{--==}ef--}     // three flat deletion ranges, no nesting;
//                                              // reject-all restores "ab{==cd==}ef" exactly
//
//       — and we deliberately do NOT use it, because it inverts the model: it encodes the
//       highlight's brackets as document TEXT rather than syntax. The user would see a literal
//       "{==" struck through in their note, and accepting or rejecting any ONE of the three
//       deletions independently (which the UI allows) leaves an orphan "{==" in the document
//       forever. That is worse corruption than losing the annotation. If a future maintainer finds
//       an encoding without those two costs, this decision is open to revisiting.
//       (The split in Task 3 pays the same price: reject_all of "{==h==}{++x++}{==ere==}" is
//       "{==h==}{==ere==}", not "{==here==}".) Every test below still asserts the exact reject_all
//       string, so any change to that is deliberate.
function base_text(doc: string): string {
	return reject_all(doc).replaceAll("{==", "").replaceAll("==}", "");
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

	test("substitution covering only a pending addition wraps the replacement as an addition", () => {
		const output = mark("ab{++cd++}ef", 5, 7, "q", SuggestionType.SUBSTITUTION);
		expect(output).toBe("ab{++q++}ef");
		expect(reject_all(output)).toBe(reject_all("ab{++cd++}ef"));
		expect(accept_all(output)).toBe("abqef");
	});

	// BUG: Partial coverage of a pending addition still folds the covered slice —
	//      reject-all resurrects it ("abcef" instead of "abef"). Full-coverage retraction
	//      only, by design of the Phase 3A fix; scheduled for a later phase.
	//      Do NOT "fix" this expectation without implementing partial-coverage retraction.
	test("KNOWN RESIDUAL: partial coverage of an addition still folds the covered slice", () => {
		const output = mark("ab{++cd++}ef", 0, 6, "", SuggestionType.DELETION);
		expect(output).toBe("{~~abc~>d~~}ef");
		expect(reject_all(output)).toBe("abcef"); // ideal would be "abef"
	});
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

describe("edges: a keystroke beside a range is not a keystroke inside it", () => {
	// EXPL: THE TELEPORTING KEYSTROKE. Typing at position 0, immediately before a highlight that
	//       begins at position 0, used to relocate the character to the FAR SIDE of the highlight:
	//       "{==h==}rest" + "x" gave "{==h==}{++x++}rest".
	//
	//       Cause: mark_ranges asked ranges_in_interval(0, 0), whose closed-interval search returns
	//       the highlight (it TOUCHES 0). The ignore-loop then treated the highlight as an atomic
	//       island: its guard `if (last_range_start < range.from)` was `0 < 0` — false — so it
	//       emitted no edit for "before the range", then set last_range_start = range.to, jumping
	//       the insertion point clean past the highlight.
	test("typing immediately BEFORE a highlight inserts before it, not after it", () => {
		expect(mark("{==h==}rest", 0, 0, "x", SuggestionType.ADDITION)).toBe("{++x++}{==h==}rest");
	});

	test("typing immediately AFTER a highlight inserts after it", () => {
		expect(mark("rest{==h==}", 11, 11, "x", SuggestionType.ADDITION)).toBe("rest{==h==}{++x++}");
	});

	test("typing immediately BEFORE a comment inserts before it", () => {
		expect(mark("{>>c<<}rest", 0, 0, "x", SuggestionType.ADDITION)).toBe("{++x++}{>>c<<}rest");
	});
});

describe("interior: an edit inside a highlight splits it", () => {
	//  {  =  =  h  e  r  e  =  =  }
	//  0  1  2  3  4  5  6  7  8  9   <- `to` is 10; content "here" is 3..7
	//
	// EXPL: CriticMarkup cannot nest, so a tracked change inside a highlight has nowhere to live.
	//       The old code teleported it out of the highlight's far side. Splitting keeps BOTH the
	//       highlight and the tracked change, losslessly, in valid CriticMarkup.
	//       A later phase's overlap dialect expresses this properly as {==#a1 h{++x++}ere==#a1}.
	test("typing inside a highlight splits it around the addition", () => {
		expect(mark("{==here==}", 4, 4, "x", SuggestionType.ADDITION)).toBe("{==h==}{++x++}{==ere==}");
	});

	// EXPL: A collapsed cursor with nothing to insert is a DEGENERATE operation — there is nothing to
	//       split the highlight around. Splitting anyway damaged the user's existing markup to make room
	//       for an empty range. (The junk {++++} empty range itself is a separate, pre-existing bug.)
	test("a collapsed cursor with nothing inserted does NOT split the highlight", () => {
		expect(mark("{==here==}", 4, 4, "", SuggestionType.ADDITION)).toBe("{==here==}{++++}");
	});

	test("the cursor lands after the typed character, not somewhere in the split's syntax", () => {
		// {  =  =  h  =  =  }  {  +  +  x
		// 0  1  2  3  4  5  6  7  8  9  10   <- "x" occupies 10; cursor ends at 11
		const state = createRangeState("{==here==}", { enable_metadata: true, enable_author_metadata: true });
		const edits = mark_ranges(state.field(rangeParser).ranges, state.doc, 4, 4, "x", SuggestionType.ADDITION);
		expect(edits).toHaveLength(1);
		expect(edits[0].start).toBe(10);
		expect(edits[0].end).toBe(11);
	});

	test("typing at the very start of a highlight's CONTENT does not split — nothing is left of it", () => {
		// position 3 is the first content char; the left half would be empty, so emit no empty range
		expect(mark("{==here==}", 3, 3, "x", SuggestionType.ADDITION)).toBe("{++x++}{==here==}");
	});

	test("typing at the very end of a highlight's CONTENT does not split — nothing is right of it", () => {
		expect(mark("{==here==}", 7, 7, "x", SuggestionType.ADDITION)).toBe("{==here==}{++x++}");
	});

	test("deleting inside a highlight splits it around the deletion", () => {
		// delete "er" (content offsets 4..6)
		expect(mark("{==here==}", 4, 6, "", SuggestionType.DELETION)).toBe("{==h==}{--er--}{==e==}");
	});

	test("a highlight's metadata is re-emitted on both halves of the split", () => {
		// `{==` is 0..3, the 13-char metadata block `{"done":true}` is 3..16, `@@` is 16..18,
		// content "here" is 18..22, `==}` is 22..25. The cursor sits after the "h", at 19.
		const doc = `{=={"done":true}@@here==}`;
		expect(mark(doc, 19, 19, "x", SuggestionType.ADDITION))
			.toBe(`{=={"done":true}@@h==}{++x++}{=={"done":true}@@ere==}`);
	});

	test("a comment is NOT split — typing inside one edits the comment's prose", () => {
		// A comment's body is prose, not document text. Editing it is editing the comment.
		//  {  >  >  n  o  t  e  <  <  }
		//  0  1  2  3  4  5  6  7  8  9
		expect(mark("{>>note<<}", 4, 4, "x", SuggestionType.ADDITION)).toBe("{>>nxote<<}");
	});
});

describe("overlap: an operation covering part of a highlight splits it, and never drops the edit", () => {
	// EXPL: THE SILENTLY TRUNCATED EDIT. mark_ranges' ignore-loop emitted an edit for the region
	//       BEFORE an incompatible range and then jumped `last_range_start = range.to`. The region
	//       INSIDE the range was marked by nobody: it just vanished. Selecting highlighted text and
	//       pressing Delete did nothing at all ("x{==here==}y" -> unchanged); a selection running
	//       from inside a highlight into the text after it deleted only the part outside it.
	//
	//       A highlight the operation actually covers is now SPLIT at the coverage boundary: the
	//       covered content is marked, the uncovered content stays highlighted. A COMMENT is never
	//       split — its body is prose, not document text (see the comment cases below).

	test("selecting exactly a highlight and deleting deletes it (it used to do nothing at all)", () => {
		//  x  {  =  =  h  e  r  e  =  =  }  y
		//  0  1  2  3  4  5  6  7  8  9 10 11   <- the highlight is [1, 11)
		const output = mark("x{==here==}y", 1, 11, "", SuggestionType.DELETION);
		expect(output).toBe("x{--here--}y");
		expect(accept_all(output)).toBe("xy");
		expect(reject_all(output)).toBe("xherey");
		expect(base_text(output)).toBe(base_text("x{==here==}y"));
	});

	test("deleting from inside a highlight through the text after it deletes BOTH parts", () => {
		//  {  =  =  h  e  r  e  =  =  }  r  e  s  t
		//  0  1  2  3  4  5  6  7  8  9 10 11 12 13   <- [5, 12) covers "re" of "here" and "re" of "rest"
		const output = mark("{==here==}rest", 5, 12, "", SuggestionType.DELETION);
		expect(output).toBe("{==he==}{--rere--}st");
		expect(accept_all(output)).toBe("{==he==}st");
		expect(reject_all(output)).toBe("{==he==}rerest");
		expect(base_text(output)).toBe(base_text("{==here==}rest"));
	});

	test("selecting all of a document with a highlight in it and deleting deletes all of it", () => {
		//  a  b  {  =  =  c  d  =  =  }  e  f
		//  0  1  2  3  4  5  6  7  8  9 10 11   <- [0, 12) is the whole document
		const output = mark("ab{==cd==}ef", 0, 12, "", SuggestionType.DELETION);
		expect(output).toBe("{--abcdef--}");
		expect(accept_all(output)).toBe("");
		expect(reject_all(output)).toBe("abcdef");
		expect(base_text(output)).toBe(base_text("ab{==cd==}ef"));
	});

	test("a deletion ending inside a highlight consumes only the covered part of its content", () => {
		// [0, 6) covers "ab" and the "c" of the highlighted "cd"; "d" stays highlighted
		const output = mark("ab{==cd==}ef", 0, 6, "", SuggestionType.DELETION);
		expect(output).toBe("{--abc--}{==d==}ef");
		expect(accept_all(output)).toBe("{==d==}ef");
		expect(reject_all(output)).toBe("abc{==d==}ef");
		expect(base_text(output)).toBe(base_text("ab{==cd==}ef"));
	});

	test("a substitution across a highlight replaces the highlighted text too", () => {
		const output = mark("ab{==cd==}ef", 0, 12, "q", SuggestionType.SUBSTITUTION);
		expect(output).toBe("{~~abcdef~>q~~}");
		expect(accept_all(output)).toBe("q");
		expect(reject_all(output)).toBe("abcdef");
		expect(base_text(output)).toBe(base_text("ab{==cd==}ef"));
	});

	test("a comment is NOT split: a deletion across one leaves the comment's prose alone", () => {
		//  a  b  {  >  >  n  o  t  e  <  <  }  e  f
		//  0  1  2  3  4  5  6  7  8  9 10 11 12 13
		const output = mark("ab{>>note<<}ef", 0, 14, "", SuggestionType.DELETION);
		expect(output).toBe("{--ab--}{>>note<<}{--ef--}");
		expect(accept_all(output)).toBe("");
		expect(reject_all(output)).toBe("abef");
		expect(base_text(output)).toBe(base_text("ab{>>note<<}ef"));
	});

	test("a comment is NOT split: a deletion starting inside one deletes only the text after it", () => {
		const output = mark("{>>note<<}rest", 5, 12, "", SuggestionType.DELETION);
		expect(output).toBe("{>>note<<}{--re--}st");
		expect(accept_all(output)).toBe("st");
		expect(reject_all(output)).toBe("rest");
		expect(base_text(output)).toBe(base_text("{>>note<<}rest"));
	});

	// EXPL: MARKING A HIGHLIGHT'S CONTENT AS AN ADDITION DESTROYS THE HIGHLIGHT — deliberately.
	//       "Mark as Addition" (src/editor/uix/commands.ts) over a span covering a highlight used to
	//       emit "{++ab++}{==cd==}{++ef++}": "cd" was left UNMARKED, so accepting the suggestion
	//       silently left it as plain text — the truncation bug wearing a different hat.
	//
	//       The highlight cannot survive the correct output. Marking its content as an addition means
	//       the content is now pending: rejecting the suggestion DELETES "cd" outright, so there is
	//       nothing left to highlight. Preserving the annotation over content that reject removes is
	//       incoherent, so the annotation goes and every character of text is accounted for.
	test("marking a span covering a highlight as an addition destroys the highlight", () => {
		const output = mark("ab{==cd==}ef", 0, 12, "", SuggestionType.ADDITION);
		expect(output).toBe("{++abcdef++}");
		expect(accept_all(output)).toBe("abcdef");
		// EXPL: reject removes the whole addition — including the once-highlighted "cd". That is what
		//       "this text is a pending addition" MEANS; the highlight has nowhere to survive.
		expect(reject_all(output)).toBe("");
	});
});

// EXPL: THE INJECTED DELIMITER (document corruption). mark_ranges snapped only two of the four ways an
//       operation's boundary can land inside a neighbouring range's bracket. An unsnapped boundary left
//       half a delimiter inside the operation, where it was read back as document TEXT and re-emitted —
//       INVENTING a character in the user's note. Only "{~~" corrupts: it is the one delimiter with an
//       interior character that survives unwrapping.
//
//       The invariant every case below pins: base_text(output) === base_text(input) — not one character
//       of the user's text invented, not one lost — plus an explicit check that no "~" leaked into it.
describe("boundary snapping: an operation never half-swallows a range's delimiter", () => {
	test("CONTROL (no highlight): a deletion ending inside a following substitution's opening bracket", () => {
		//  c  c  {  ~  ~  r  ~  >  s  ~  ~  }
		//  0  1  2  3  4  5  6  7  8  9 10 11   <- [1, 4) ends one character INTO the "{~~"
		//  Pre-fix: "c{~~c~r~>s~~}" — a stray "~" written into the document ("ccr" became "cc~r").
		//  This case predates the highlight work entirely: it is the bug in its purest form.
		const output = mark("cc{~~r~>s~~}", 1, 4, "", SuggestionType.DELETION);
		expect(output).toBe("c{~~cr~>s~~}");
		expect(base_text(output)).toBe(base_text("cc{~~r~>s~~}"));
		expect(base_text(output)).not.toContain("~");
		expect(accept_all(output)).toBe("cs");
		expect(reject_all(output)).toBe("ccr");
	});

	test("a deletion spanning a highlight into a following substitution", () => {
		//  c  {  =  =  h  =  =  }  {  ~  ~  r  ~  >  s  ~  ~  }
		//  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17   <- [2, 10) ends inside the "{~~"
		//  Pre-fix: "c{~~h~r~>s~~}" — "chr" became "ch~r". Reachable only since the highlight is no
		//  longer ignored (the ignore-loop used to shield this by jumping past the highlight).
		const output = mark("c{==h==}{~~r~>s~~}", 2, 10, "", SuggestionType.DELETION);
		expect(output).toBe("c{~~hr~>s~~}");
		expect(base_text(output)).toBe(base_text("c{==h==}{~~r~>s~~}"));
		expect(base_text(output)).not.toContain("~");
		expect(accept_all(output)).toBe("cs");
		expect(reject_all(output)).toBe("chr");
	});

	test("SYMMETRIC: a deletion STARTING inside a preceding substitution's closing bracket", () => {
		//  {  ~  ~  a  ~  >  b  ~  ~  }  c  c
		//  0  1  2  3  4  5  6  7  8  9 10 11   <- [8, 11) starts inside the "~~}"
		//  The substitution's content is untouched, so `from` snaps OUT to its end: only "c" is deleted.
		const output = mark("{~~a~>b~~}cc", 8, 11, "", SuggestionType.DELETION);
		expect(output).toBe("{~~a~>b~~}{--c--}c");
		expect(base_text(output)).toBe(base_text("{~~a~>b~~}cc"));
		expect(base_text(output)).not.toContain("~");
		expect(accept_all(output)).toBe("bc");
		expect(reject_all(output)).toBe("acc");
	});

	test("snapping OUT of a bracket does not defeat merging into an abutting compatible range", () => {
		// [1, 4) ends inside the "{--": the operation abuts the deletion, and mark_range still merges
		// with it (at_cursor sees an abutting range), so this stays one range rather than two.
		const output = mark("cc{--r--}", 1, 4, "", SuggestionType.DELETION);
		expect(output).toBe("c{--cr--}");
		expect(base_text(output)).toBe(base_text("cc{--r--}"));
	});
});
