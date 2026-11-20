import { ChangeSet, EditorSelection, EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import * as obsidian from "obsidian";
import { editorEditorField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { type CodeRegion, findCodeRegions, regionsPreserved } from "../src/editor/base/edit-util/code-regions";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import { SuggestionType } from "../src/editor/base/ranges";
import { suggestionMode } from "../src/editor/uix/extensions";
import * as fence_guard from "../src/editor/uix/extensions/editing-modes/fence-guard";
import { editorKeypressCatcher } from "../src/editor/uix/extensions/keypress-catcher";
import { createRangeState } from "./helpers";

// EXPL: Property test for Suggest mode around fenced code (0.13.0 spec, addendum: simplified fence handling). Random
//       documents mixing prose, ranges and fenced blocks of every kind; random single- and multi-cursor edits, mostly
//       on and around fence lines. After every edit:
//       (a) no CriticMarkup delimiter lies on a fence line or in code, unless it was there before, untouched, or the
//           user's own change put it there plainly (typing literal characters in code);
//       (b) the block structure changes only if the plain edit changes it; then the result holds exactly the old
//           blocks (minus those deleted from one's own addition) plus the complete blocks in the inserted text, and
//           every block the edit did not touch is unchanged;
//       (c) no range the edit did not touch vanishes;
//       (d) the incremental rangeParser state equals a full parse;
//       (e) a non-whitespace edit in prose that is not refused stays tracked;
//       (f) no keystroke is dropped unless the edit was refused with a notice, and no notice without a refusal.
//       Seeded (mulberry32), so a failure is reproducible from the printed example.

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

const PARTS = [
	"plain prose",
	"some {++added++} text",
	"a {==mark==} here",
	"{--gone--} and {~~old~>new~~}",
	"",
	"```\ncode\n```",
	"~~~\nx\n~~~",
	"```js\nlet a;\n```",
	"```\n```",
	"````\nfour\n````",
	"- item\n  ```\n  code\n  ```",
	"> ```\n> quoted\n> ```",
	">  ~~~\n>  q\n>  ~~~",
	"```\n\n```",
	"```py\n\nx\n\n```",
	"a {++abcdef++} b",
	"x {~~old~>new~~} y",
	"{==hi==}{>>c<<} z",
	"intro{++\n```js\nc\n```\n++}",
];

const TYPED = ["a", " ", "`", ">", "~", "}", "x"];
const PASTES = [
	"x\ny",
	"\n```\n",
	"a\n",
	"\n",
	"p\n\nq",
	"Intro\n\n```js\ncode\n```\n\nMore\n",
	"see\n~~~\n",
	"```\nz\n```\n",
];

const SEQUENCES = 2000;
const EDITS_PER_SEQUENCE = 6;
const NOTICE = "Inkling: this edit would break a code fence in Suggest mode.";

const FENCE_LINE = /^( {0,3}(?:> {0,4})*)(`{3,}|~{3,})/;
const DELIMITER = /\{(?:\+\+|--|~~|==|>>)|(?:\+\+|--|~~|==|<<)\}|~>/g;
const FENCE_TEXT = /(^|\n)[ >]*(```|~~~)/;

function suggestView(doc: string): EditorView {
	return new EditorView({
		state: createRangeState(doc, { add_metadata: false }, [
			editorEditorField,
			editorKeypressCatcher,
			EditorState.allowMultipleSelections.of(true),
			suggestionMode({ ...DEFAULT_SETTINGS, add_metadata: false }),
		]),
	});
}

type Change = { from: number; to: number; insert: string };

function staleState(state: EditorState): boolean {
	const text = state.doc.toString();
	const field = state.field(rangeParser);
	const spans = (ranges: { type: unknown; from: number; to: number }[]) =>
		JSON.stringify(ranges.map(r => [r.type, r.from, r.to]));
	return spans(field.ranges.ranges) !== spans(getRangesInText(text, { ...DEFAULT_SETTINGS, add_metadata: false })) ||
		JSON.stringify(field.code_regions) !== JSON.stringify(findCodeRegions(text));
}

/** Whether `pos` is on a fence line or in code (a region with its line bounds, both ends included). */
const inCode = (regions: CodeRegion[], pos: number) => regions.some(r => r.from <= pos && pos <= r.to);
const delimiters = (text: string) => [...text.matchAll(DELIMITER)].map(m => ({ at: m.index!, text: m[0] }));
const count = (text: string, part: string) => text.split(part).length - 1;

describe("fuzz: suggest-mode edits never put markup on a fence line or in code", () => {
	test(`${SEQUENCES} random documents x ${EDITS_PER_SEQUENCE} edits`, () => {
		const notice = jest.spyOn(obsidian, "Notice").mockImplementation(() => ({}) as obsidian.Notice);
		// The guard's decision per change (null: refused), to tell which change a notice is for.
		const guard = jest.spyOn(fence_guard, "guardSuggestions");
		const rng = mulberry32(Number(process.env.FUZZ_SEED ?? 0xFE11CE));
		const pick = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
		const failures: Record<string, number> = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, throws: 0 };
		const examples: string[] = [];
		let edits_run = 0, multi_cursor = 0, near_fence = 0, structure_changes = 0, refused = 0, plain_in_code = 0;

		for (let seq = 0; seq < SEQUENCES; seq++) {
			const n = 3 + Math.floor(rng() * 5);
			let doc = Array.from({ length: n }, () => pick(PARTS)).join("\n") + "\ntail {++t++}";
			if (rng() < 0.15) doc = doc.replace(/\n/g, "\r\n");
			const view = suggestView(doc);
			const log: [number, Change[]][] = [];

			for (let e = 0; e < EDITS_PER_SEQUENCE; e++) {
				const before = view.state.doc.toString();
				const before_regions = view.state.field(rangeParser).code_regions;
				// Copied: range objects are shifted in place by the next update.
				const before_ranges = view.state.field(rangeParser).ranges.ranges.map(r => ({
					from: r.from,
					to: r.to,
					type: r.type,
				}));
				const len = before.length;

				// Positions on and around fence lines: line start, after the prefix, line end, the previous line's end
				// and the next line's start; and inside ranges' content, where cursors type into existing suggestions.
				const hot: number[] = [];
				let pos = 0;
				for (const line of before.split("\n")) {
					const m = FENCE_LINE.exec(line);
					if (m) hot.push(pos - 1, pos, pos + m[1].length, pos + line.length, pos + line.length + 1);
					pos += line.length + 1;
				}
				const inside = before_ranges.filter(r => r.to - r.from > 6);
				const position = () => {
					if (inside.length && rng() < 0.2) {
						const r = pick(inside);
						return r.from + 3 + Math.floor(rng() * (r.to - r.from - 5));
					}
					const p = hot.length && rng() < 0.7 ? pick(hot) : Math.floor(rng() * (len + 1));
					return Math.max(0, Math.min(len, p));
				};

				const cursor_count = rng() < 0.25 ? 2 : 1;
				const kind = Math.floor(rng() * 8);
				const changes: Change[] = [];
				for (let c = 0; c < cursor_count; c++) {
					let p = position();
					switch (kind) {
						case 0:
							changes.push({ from: p, to: p, insert: pick(TYPED) });
							break;
						case 1:
							changes.push({ from: p, to: p, insert: "\n" });
							break;
						case 2:
							if (p > 0) changes.push({ from: p - 1, to: p, insert: "" });
							break;
						case 3:
							if (p < len) changes.push({ from: p, to: p + 1, insert: "" });
							break;
						case 4:
							changes.push({ from: p, to: p, insert: pick(PASTES) });
							break;
						case 5:
						case 6: {
							const a = Math.max(0, p - Math.floor(rng() * 6)), b = Math.min(len, p + Math.floor(rng() * 6));
							if (a < b) changes.push({ from: a, to: b, insert: kind === 5 ? "Z" : "" });
							break;
						}
						case 7:
							p = before.lastIndexOf("\n", p - 1) + 1;
							changes.push({ from: p, to: p, insert: "h" });
							break;
					}
				}
				changes.sort((x, y) => x.from - y.from);
				const disjoint = changes.filter((c, i) => i === 0 || changes[i - 1].to < c.from);
				// A change splitting a CRLF line break is not something an editor produces.
				if (
					!disjoint.length ||
					disjoint.some(c => /\r$/.test(before.slice(0, c.from)) || /\r$/.test(before.slice(0, c.to)))
				) {
					continue;
				}
				log.push([kind, disjoint]);
				edits_run++;
				if (disjoint.length > 1) multi_cursor++;
				if (disjoint.some(c => hot.some(h => Math.abs(h - c.from) <= 1 || Math.abs(h - c.to) <= 1))) near_fence++;

				let failed = false;
				const fail = (kind: string, detail = "") => {
					if (failed) return;
					failed = true;
					failures[kind]++;
					if (
						examples.length < (process.env.FUZZ_KIND ? 30 : 8) &&
						(!process.env.FUZZ_KIND || process.env.FUZZ_KIND === kind)
					) {
						examples.push(
							`(${kind}) ${detail}\n    doc=${JSON.stringify(doc)} edits=${JSON.stringify(log)}` +
								`\n    before=${JSON.stringify(before)}\n    after=${JSON.stringify(view.state.doc.toString())}`,
						);
					}
				};

				const notices_before = notice.mock.calls.filter(call => call[0] === NOTICE).length;
				guard.mockClear();
				let tr;
				try {
					// The key behind the edit, as the editor sees it (Backspace and Delete delete in different directions).
					const key = kind === 2 ? "Backspace" : kind === 3 ? "Delete" : kind === 1 ? "Enter" : "a";
					view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
					view.dispatch({
						selection: EditorSelection.create(
							disjoint.map(c =>
								kind === 2 ?
									EditorSelection.cursor(c.to) :
									EditorSelection.range(c.from, c.insert || kind === 6 ? c.to : c.from)
							),
						),
					});
					tr = view.state.update({
						changes: disjoint,
						selection: EditorSelection.create(disjoint.map((c, i) =>
							EditorSelection.cursor(
								c.from + c.insert.length +
									disjoint.slice(0, i).reduce((n, d) => n + d.insert.length - (d.to - d.from), 0),
							)
						)),
						userEvent: kind === 2 ?
							"delete.backward" :
							kind === 3 ?
							"delete.forward" :
							kind === 6 ?
							"delete.selection" :
							"input.type",
					});
					view.dispatch(tr);
				} catch (error) {
					fail("throws", String(error));
					break;
				}
				const was_refused = notice.mock.calls.filter(call => call[0] === NOTICE).length > notices_before;
				if (was_refused) refused++;
				const decisions = (guard.mock.results.at(-1)?.value ?? []) as unknown[];
				const refused_changes = disjoint.filter((_, i) => decisions[i] === null);
				const accepted = disjoint.filter(c => !refused_changes.includes(c));
				if (process.env.FUZZ_REFUSALS && disjoint.length === 1 && refused_changes.length) {
					console.log(
						"REFUSED " + kind + " " +
							JSON.stringify(
								before.slice(Math.max(0, disjoint[0].from - 12), disjoint[0].from) + "|" +
									before.slice(disjoint[0].from, disjoint[0].to) + "|" +
									before.slice(disjoint[0].to, disjoint[0].to + 12),
							) + " ins=" + JSON.stringify(disjoint[0].insert),
					);
				}

				const after = view.state.doc.toString();
				const after_regions = view.state.field(rangeParser).code_regions;
				const after_ranges = view.state.field(rangeParser).ranges.ranges;
				const plain_changes = ChangeSet.of(accepted, len);
				const plain = plain_changes.apply(Text.of(before.split("\n"))).toString();
				const plain_regions = findCodeRegions(plain);
				const applied: { fromA: number; toA: number; fromB: number; toB: number; text: string }[] = [];
				tr.changes.iterChanges((fromA, toA, fromB, toB, text) =>
					applied.push({ fromA, toA, fromB, toB, text: text.toString() })
				);
				// A user change applied exactly as typed.
				const as_typed = (c: Change) => applied.some(x => x.fromA === c.from && x.toA === c.to && x.text === c.insert);
				const block_line = (c: Change) => before_regions.some(r => r.from <= c.to && c.from <= r.to);

				// (d)
				if (staleState(view.state)) fail("d");

				// (a)
				for (const { at, text } of delimiters(after)) {
					if (!inCode(after_regions, at)) continue;
					const back = tr.changes.invertedDesc.mapPos(at);
					const untouched = !tr.changes.touchesRange(back, back + text.length);
					const was_in_code = before.startsWith(text, back) && inCode(before_regions, back);
					// Typed plainly: inside (or right next to) a change applied exactly as the user made it.
					const typed = applied.some(x =>
						x.fromB <= at + text.length && at <= x.toB && disjoint.some(c => c.insert === x.text && as_typed(c))
					);
					// In a block that is unchanged (an edit around it, such as a tracked deletion, may have moved it).
					const block = after_regions.find(r => r.from <= at && at <= r.to)!;
					const kept_block = before_regions.some(r => before.slice(r.from, r.to) === after.slice(block.from, block.to));
					if (!(untouched && was_in_code) && !typed && !kept_block) {
						fail("a", `${JSON.stringify(text)} at ${at}`);
						break;
					}
				}

				// Changes whose windows (W around each) overlap are checked together: text may move a little (next to a
				// fence), so a typed character is looked for in the whole cluster's window.
				const W = 60;
				const clusters: Change[][] = [];
				for (const c of disjoint) {
					const last = clusters.at(-1);
					if (last && last.at(-1)!.to + 2 * W >= c.from) last.push(c);
					else clusters.push([c]);
				}
				// Whether a cluster's deletions left text visible (counted per character in the cluster's window, so an
				// equivalent deletion shifted by a character, or one widened to whole blocks, counts as applied). Visible
				// text is what accepting would keep: not delimiters, deleted text or comments. A deleted character that is
				// already deleted (deleting it again does nothing), a delimiter or inside a comment (the cursor steps over
				// markup and comments), or a line break next to a fence line or a fence line's prefix (kept so markers stay
				// on prose lines) is not expected to go.
				const fence_breaks = new Set(before_regions.flatMap(r => [r.from - 1, r.open_to, r.close_from - 1, r.to]));
				for (const r of before_regions) {
					for (const at of r.close_from < r.to ? [r.from, r.close_from] : [r.from]) {
						const prefix = /^[ >]*/.exec(before.slice(at, before.indexOf("\n", at) + 1 || len))![0].length;
						for (let k = 0; k < prefix; k++) fence_breaks.add(at + k);
					}
				}
				const hidden = (text: string, ranges: { from: number; to: number; type: SuggestionType }[]) => {
					const at = new Set<number>(delimiters(text).flatMap(d => [...d.text].map((_, k) => d.at + k)));
					for (const r of ranges) {
						const middle = text.indexOf("~>", r.from + 3);
						const end = r.type === SuggestionType.SUBSTITUTION ?
							middle :
							r.type === SuggestionType.DELETION || r.type === SuggestionType.COMMENT ?
							r.to :
							r.from;
						for (let k = r.from; k < end; k++) at.add(k);
					}
					return at;
				};
				const hidden_before = hidden(before, before_ranges), hidden_after = hidden(after, after_ranges);
				const visible = (text: string, from: number, to: number, skip: Set<number>) =>
					[...text.slice(from, to)].filter((_, k) => !skip.has(from + k)).join("");
				const left_visible = (cluster: Change[]) => {
					const lo = Math.max(0, cluster[0].from - W), hi = Math.min(len, cluster.at(-1)!.to + W);
					const window_before = visible(before, lo, hi, hidden_before);
					const window_after = visible(after, tr.changes.mapPos(lo, -1), tr.changes.mapPos(hi, 1), hidden_after);
					const typed = cluster.map(c => c.insert).join("");
					const deleted = cluster.filter(c => !c.insert && !refused_changes.includes(c))
						.flatMap(c =>
							[...before.slice(c.from, c.to)].filter((_, i) =>
								!hidden_before.has(c.from + i) && !fence_breaks.has(c.from + i)
							)
						)
						.join("");
					return [...new Set(deleted)].some(ch =>
						count(window_before, ch) + count(typed, ch) - count(window_after, ch) < count(deleted, ch)
					);
				};
				// Whether a cluster lost a typed character. Counted in the text without the ranges' delimiters: an edit only
				// adds or rewrites those. A change into a block inside an addition may remove that whole block (one's own
				// suggested text), so it is not counted.
				const delimiter_positions = (text: string, ranges: { from: number; to: number; type: SuggestionType }[]) => {
					const at = new Set<number>();
					for (const r of ranges) {
						for (const k of [0, 1, 2]) at.add(r.from + k).add(r.to - 1 - k);
						const middle = text.indexOf("~>", r.from + 3);
						if (r.type === SuggestionType.SUBSTITUTION && middle !== -1 && middle < r.to - 3)
							at.add(middle).add(middle + 1);
					}
					return at;
				};
				const before_delimiters = delimiter_positions(before, before_ranges);
				const after_delimiters = delimiter_positions(after, after_ranges);
				const text_of = (text: string, from: number, to: number, skip: Set<number>) =>
					[...text.slice(from, to)].filter((_, k) => !skip.has(from + k)).join("");
				const own_blocks = before_regions.filter(r =>
					before_ranges.some(range => range.type === SuggestionType.ADDITION && range.from < r.from && r.to < range.to)
				);
				const lost = (cluster: Change[]) => {
					if (cluster.some(c => own_blocks.some(r => c.from <= r.to && r.from <= c.to))) return false;
					const lo = Math.max(0, cluster[0].from - W), hi = Math.min(len, cluster.at(-1)!.to + W);
					const window_before = text_of(before, lo, hi, before_delimiters);
					const window_after = text_of(after, tr.changes.mapPos(lo, -1), tr.changes.mapPos(hi, 1), after_delimiters);
					const typed = cluster.map(c => c.insert).join("");
					return [...new Set(typed)].some(ch => {
						const expected = count(window_before, ch) + count(typed, ch) -
							cluster.reduce((n, c) => n + count(text_of(before, c.from, c.to, before_delimiters), ch), 0);
						return count(window_after, ch) < expected;
					});
				};
				// (f)
				for (const cluster of clusters) {
					const applied_only = cluster.every(c => !refused_changes.includes(c));
					if ((applied_only && lost(cluster)) || left_visible(cluster))
						fail("f", "dropped a change that was not refused");
				}
				if (was_refused !== refused_changes.length > 0)
					fail("f", `notice ${was_refused}, refused ${refused_changes.length}`);

				// (b)
				const changed = !regionsPreserved(before_regions, tr.changes, after_regions);
				const plain_changed = !regionsPreserved(before_regions, plain_changes, plain_regions);
				if (changed) structure_changes++;
				if (changed && !plain_changed) fail("b", "structure changed, though the plain edit keeps it");
				const block_text = (text: string) => (r: CodeRegion) => text.slice(r.from, r.to);
				const after_blocks = after_regions.map(block_text(after));
				if (plain_changed) {
					// The complete blocks in the text the changes insert.
					// Text inserted in code (a block's content, or above its closing fence) is code, not blocks; text typed in
					// an opening fence line's prefix or fence characters goes above it, and text after a closing one below.
					const in_code = (c: Change) =>
						before_regions.some(r =>
							r.from + /^[ >]*[`~]+/.exec(before.slice(r.from, r.to))![0].length <= c.from && c.to <= r.to &&
							!(c.from === r.to && r.close_from < r.to)
						);
					const inserted_blocks = accepted.filter(c => !in_code(c)).flatMap(c =>
						findCodeRegions(c.insert).filter(r => r.close_from < r.to).map(block_text(c.insert))
					);
					// Blocks deleted from one's own addition go outright.
					const own = before_regions.filter(r =>
						before_ranges.some(range =>
							range.type === SuggestionType.ADDITION && range.from < r.from && r.to < range.to
						) &&
						accepted.some(c => c.from < r.to && r.from < c.to)
					);
					const most = before_regions.length + inserted_blocks.length, least = most - own.length;
					if (after_regions.length < least || after_regions.length > most)
						fail("b", `${after_regions.length} blocks, expected ${least}-${most}`);
				}
				// Every block no change touched is unchanged.
				for (const r of before_regions) {
					if (tr.changes.touchesRange(r.from, r.to)) continue;
					if (!after_blocks.includes(before.slice(r.from, r.to))) fail("b", "untouched block changed");
				}

				// (c)
				const touched: [number, number][] = disjoint.map(c => [c.from, c.to]);
				tr.changes.iterChangedRanges((fromA, toA) => touched.push([fromA, toA]));
				const after_texts = after_ranges.map(r => after.slice(r.from, r.to));
				for (const range of before_ranges) {
					if (touched.some(([from, to]) => range.from <= to + 1 && from - 1 <= range.to)) continue;
					const text = before.slice(range.from, range.to);
					const i = after_texts.indexOf(text);
					if (i === -1) {
						fail("c", `${JSON.stringify(text)} vanished`);
						break;
					}
					after_texts.splice(i, 1);
				}

				const in_range = (c: Change, types: SuggestionType[]) =>
					before_ranges.some(r => types.includes(r.type) && r.from < c.from && c.to < r.to);
				// (e)
				for (const c of disjoint) {
					const deleted = before.slice(c.from, c.to);
					if (!/\S/.test(c.insert + deleted) || block_line(c) || FENCE_TEXT.test(c.insert) || was_refused) continue;
					// mark_ranges' own rules: a comment is edited verbatim, own text is removed outright, deleting deleted
					// text does nothing, and a change at or across a delimiter snaps to the range.
					if (
						before_ranges.some(r => r.type === SuggestionType.COMMENT && r.from <= c.to && c.from <= r.to) ||
						(!c.insert &&
							in_range(c, [SuggestionType.ADDITION, SuggestionType.DELETION, SuggestionType.SUBSTITUTION])) ||
						delimiters(before).some(d => c.from <= d.at + d.text.length && d.at <= c.to)
					) {
						continue;
					}
					// mark_ranges may place text typed inside a range beside it, or into a range next to that one.
					const inside = before_ranges.find(r => r.from < c.from && c.to < r.to);
					const next_to = before_ranges.filter(r => inside && (r.to === inside.from || r.from === inside.to));
					const around = inside ?
						{
							from: Math.min(inside.from, ...next_to.map(r => r.from)),
							to: Math.max(inside.to, ...next_to.map(r => r.to)),
						} :
						{ from: c.from, to: c.to };
					const lo = Math.max(0, tr.changes.mapPos(around.from, -1) - 3), hi = tr.changes.mapPos(around.to, 1) + 3;
					const types = c.insert ?
						[SuggestionType.ADDITION, SuggestionType.SUBSTITUTION] :
						[SuggestionType.DELETION, SuggestionType.SUBSTITUTION];
					const part = c.insert || deleted;
					let tracked = false;
					for (let k = after.indexOf(part, lo); k !== -1 && k <= hi; k = after.indexOf(part, k + 1))
						if (after_ranges.some(r => types.includes(r.type) && r.from < k && k + part.length <= r.to)) tracked = true;
					if (!tracked) fail("e", "untracked " + JSON.stringify(c));
				}
				if (disjoint.some(c => as_typed(c) && block_line(c))) plain_in_code++;

				// Later edits would start from a broken document; each sequence counts its first failure only.
				if (failed) break;
			}
		}
		notice.mockRestore();
		guard.mockRestore();

		console.log(
			`fence fuzz: ${SEQUENCES} docs, ${edits_run} edits (${multi_cursor} multi-cursor, ${near_fence} at a fence line, ` +
				`${plain_in_code} plain in code, ${structure_changes} structure changes, ${refused} refused with a notice); ` +
				`failures ${JSON.stringify(failures)}`,
		);
		for (const example of examples) console.log("  example: " + example);
		expect(failures).toEqual({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, throws: 0 });
	});
});
