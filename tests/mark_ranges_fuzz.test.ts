import { applyToText, rangeParser, SuggestionType } from "../src/editor/base";
import type { EditorSuggestion } from "../src/editor/base/edit-handler";
import { mark_ranges, type MarkType } from "../src/editor/base/edit-logic/mark";
import { createRangeState } from "./helpers";

// EXPL: Fuzz guard for the DATA-INTEGRITY invariant this phase protects: a DELETION or SUBSTITUTION
//       mark operation must never change what rejecting every suggestion yields. Text inside {++...++}
//       (and a substitution's inserted half) was never in the base document; deleting across only PART
//       of it used to FOLD the covered slice into the new range's old-text, so reject-all RESURRECTED a
//       character the user never committed. See .superpowers/sdd/task-6-report.md.
//
//       The oracle: base_text(output) === base_text(input), where base_text = reject-all then strip
//       highlight brackets (the true underlying document text). We tally two classes separately:
//         (a) base_text differs           -> GENUINE resurrection/corruption. This task drives it to 0.
//         (b) reject_all differs but base_text does NOT -> a highlight's brackets could not survive a
//             deletion swallowing its content (CriticMarkup cannot nest). Task 3b's unrepresentable
//             case; expected to remain, NOT corruption (no character of the user's text is invented).
//
//       Deterministic (seeded PRNG) so any failure is reproducible.

// Obsidian global, absent under jest -- test-env artifact only.
(Math as any).clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function mulberry32(seed: number) {
	return function() {
		seed |= 0;
		seed = (seed + 0x6D2B79F5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// EXPL: every kind of range the engine can encounter, incl. empty + metadata variants, plus plain text.
const SEGMENTS = [
	"{==highlight==}",
	"{====}", // empty highlight
	"{=={\"color\":\"red\"}@@meta==}", // metadata highlight
	"{>>comment<<}",
	"{>><<}", // empty comment
	"{++added++}",
	"{++{\"author\":\"A\"}@@meta++}", // metadata addition
	"{--removed--}",
	"{~~old~>new~~}",
	"{~~~>ins~~}", // empty-deletion substitution
	" plain ",
	"ab",
	"xy",
	"{==b==}{color=red}", // attribute-block highlight
	"{++added++}{author=A}", // attribute-block addition
	"{>>c<<}{author=A}", // attribute-block comment
];

const INSERTS = ["", "q", "xy"];
const OPS: MarkType[] = [SuggestionType.DELETION, SuggestionType.SUBSTITUTION, SuggestionType.ADDITION];

const ITERATIONS = 2000;

function reject_all(doc: string): string {
	const state = createRangeState(doc);
	return applyToText(doc, (range) => range.reject(), state.field(rangeParser).ranges.ranges);
}

function accept_all(doc: string): string {
	const state = createRangeState(doc);
	return applyToText(doc, (range) => range.accept(), state.field(rangeParser).ranges.ranges);
}

// EXPL: Accepting or rejecting every range drops all metadata (a highlight keeps its brackets but not its block),
//       so an attribute block or a legacy `@@` left in the result is metadata the mark orphaned as plain text.
function has_stray_metadata(doc: string): boolean {
	return /\{[A-Za-z_][A-Za-z0-9_-]*=|@@/.test(doc);
}

// The underlying document text: every suggestion rejected, highlight brackets (annotation, not text)
// stripped. base_text(output) === base_text(input) is the no-invented/no-lost-character invariant.
function base_text(doc: string): string {
	return reject_all(doc).replaceAll("{==", "").replaceAll("==}", "");
}

function apply(doc: string, edits: EditorSuggestion[]): { output: string; overlap: boolean } {
	const ordered = [...edits].sort((a, b) => a.from - b.from);
	let overlap = false;
	for (let i = 1; i < ordered.length; i++)
		if (ordered[i].from < ordered[i - 1].to) overlap = true;
	let output = doc;
	for (const edit of [...ordered].reverse())
		output = output.slice(0, edit.from) + edit.insert + output.slice(edit.to);
	return { output, overlap };
}

// EXPL: Metadata on every mark, the way the app calls `mark_ranges` (it writes attribute blocks; legacy is deprecated
//       and only read, as in some of the documents).
const METADATA_FIELDS = { author: "B", time: 1 };

describe(
	"fuzz: a deletion/substitution mark never resurrects a pending addition on reject-all",
	() => {
		test(`${ITERATIONS} random documents x random spans x {DELETION, SUBSTITUTION, ADDITION}`, () => {
			const rng = mulberry32(0xBADF00D);
			const pick = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)];

			// EXPL: A base_text mismatch on a DELETION/SUBSTITUTION is text resurrected on reject. We split it
			//       into two classes:
			//         addition_class  -- the op does NOT partially cover a SUBSTITUTION range. This is the
			//                            pending-ADDITION resurrection this task fixes (grouped_range.ts's
			//                            unwrap_in_range). MUST be 0 after the fix.
			//         substitution_class -- the op partially covers a SUBSTITUTION range. Handled by a DIFFERENT
			//                            code path (mark.ts's SubstitutionRange CASE branches / the
			//                            substitution merge branches). Task 6b took it 78 -> 9; the residual
			//                            old-half bug ("old" -> "oldld", .superpowers/sdd/task-6b-report.md)
			//                            was fixed by 28f35d3 and bcdf4c6 (unit test: "a mark reaching into a
			//                            substitution's old half from a neighbouring range keeps the old text
			//                            once"). MUST be 0.
			//       Overlapping edits and throws MUST be 0 too. highlight_bracket_loss is not a failure: a
			//       deletion or substitution covering a whole highlight turns it into the suggestion (ranges
			//       cannot nest), so rejecting restores the text without the highlight around it. No character
			//       changes (base_text is equal, checked above); only the annotation goes.
			let addition_class = 0;
			let substitution_class = 0;
			let highlight_bracket_loss = 0; // reject differs but base_text does not (Task 3b unrepresentable)
			let overlaps = 0;
			let throws = 0;
			let stray_metadata = 0;
			const corruption_examples: string[] = [];

			for (let i = 0; i < ITERATIONS; i++) {
				const n = 2 + Math.floor(rng() * 5);
				let doc = "";
				for (let s = 0; s < n; s++) doc += pick(SEGMENTS);

				const len = doc.length;
				const from = Math.floor(rng() * (len + 1));
				const to = Math.min(len, from + Math.floor(rng() * 6));
				const type = pick(OPS);
				// EXPL: Pair `inserted` to the op the way the app does. A DELETION never carries inserted
				//       text (it only marks a span deleted); SUBSTITUTION/ADDITION carry the replacement.
				//       Feeding a DELETION a non-empty insert is not a real path and would measure an
				//       unrelated class (the inserted text folded into the deletion's old-text).
				const inserted = type === SuggestionType.DELETION ? "" : pick(INSERTS);

				try {
					const state = createRangeState(doc, { enable_metadata: true, enable_author_metadata: true });
					const ranges = state.field(rangeParser).ranges;
					const edits: EditorSuggestion[] = mark_ranges(
						ranges,
						state.doc,
						from,
						to,
						inserted,
						type,
						METADATA_FIELDS,
						false,
					);
					const { output, overlap } = apply(doc, edits);
					if (overlap) {
						overlaps++;
						continue;
					}
					if (has_stray_metadata(accept_all(output)) || has_stray_metadata(reject_all(output)))
						stray_metadata++;
					// Reject-all preservation is only required of DELETION/SUBSTITUTION. Marking base text
					// as an ADDITION makes it pending, so reject legitimately removes it -- not corruption.
					if (type === SuggestionType.ADDITION) continue;

					if (base_text(output) !== base_text(doc)) {
						// A SUBSTITUTION range the op OVERLAPS but does not FULLY cover: the substitution code path.
						const partial_sub = ranges.ranges_overlapping_interval(from, to)
							.some((r) => r.type === SuggestionType.SUBSTITUTION && !(from <= r.from && r.to <= to));
						if (partial_sub) {
							substitution_class++;
							if (corruption_examples.length < 12) {
								corruption_examples.push(
									`SUBSTITUTION-CLASS type=${type} doc=${JSON.stringify(doc)} [${from},${to})` +
										` ins=${JSON.stringify(inserted)} -> ${JSON.stringify(output)}`,
								);
							}
						} else {
							// NOTE: 0 after Task 6 — asserted below.
							addition_class++;
							if (corruption_examples.length < 12) {
								corruption_examples.push(
									`ADDITION-CLASS type=${type} doc=${JSON.stringify(doc)} [${from},${to})` +
										` ins=${JSON.stringify(inserted)} -> ${JSON.stringify(output)}` +
										` base ${JSON.stringify(base_text(doc))} -> ${JSON.stringify(base_text(output))}`,
								);
							}
						}
					} else if (reject_all(output) !== reject_all(doc)) {
						highlight_bracket_loss++;
					}
				} catch (error) {
					throws++;
				}
			}

			console.log(
				`[mark fuzz] stray_metadata=${stray_metadata} addition_class=${addition_class} substitution_class=${substitution_class}` +
					` highlight_bracket_loss=${highlight_bracket_loss} overlaps=${overlaps} throws=${throws} / ${ITERATIONS}`,
			);
			for (const example of corruption_examples) console.log("  " + example);

			// THE CONTRACT: a mark never resurrects or loses a character on reject-all, never orphans metadata,
			// and never produces overlapping edits or throws.
			expect(addition_class).toBe(0);
			expect(substitution_class).toBe(0);
			expect(stray_metadata).toBe(0);
			expect(overlaps).toBe(0);
			expect(throws).toBe(0);
		});
	},
);
