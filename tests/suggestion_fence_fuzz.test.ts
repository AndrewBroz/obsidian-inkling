import { ChangeSet, EditorSelection, EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import * as obsidian from "obsidian";
import { editorEditorField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { type CodeRegion, findCodeRegions, regionsPreserved } from "../src/editor/base/edit-util/code-regions";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import { type CriticMarkupRange, type SubstitutionRange, SuggestionType } from "../src/editor/base/ranges";
import { suggestionMode } from "../src/editor/uix/extensions";
import * as fence_guard from "../src/editor/uix/extensions/editing-modes/fence-guard";
import { editorKeypressCatcher } from "../src/editor/uix/extensions/keypress-catcher";
import type { PluginSettings } from "../src/types";
import { createRangeState } from "./helpers";

// EXPL: Property test for Suggest mode around fenced code (0.13.0 spec, addendum: simplified fence handling), with
//       metadata off and with the default settings (metadata on: author and timestamp). Random documents are built
//       from parts whose code blocks are known by hand, separated by blank lines so they don't interact; the scanner
//       must find exactly those blocks (r). Then random single- and multi-cursor edits, mostly on and around fence
//       lines and inside ranges, with real keydowns. After every edit:
//       (a) no CriticMarkup delimiter lies on a fence line or in code, unless it was there, untouched, or the user's
//           change put it there plainly (typing literal characters in code), or it is in an unchanged block;
//       (b) the block structure changes only if the plain edit (of the changes not refused) changes it; every block
//           after the edit is an old block, a complete block of pasted text (outside code), or one a plain edit in
//           code changed; the count is the old count plus the pasted blocks (minus blocks deleted from one's own
//           addition); untouched blocks are unchanged;
//       (c) no range the edit did not touch vanishes;
//       (d) the incremental rangeParser state equals a full parse;
//       (e) every edit not applied plainly in code is tracked: rejecting every suggestion gives the same text as
//           before (ignoring lines holding only a quote or indent prefix). This includes pasted text with blocks;
//       (f) no change is dropped unless refused; a notice shows exactly when a change is refused.
//       Seeded (mulberry32; FUZZ_SEED overrides), so a failure is reproducible from the printed example.

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

// Each part and its code blocks (opening line start to closing line end), checked by hand against CommonMark.
const PARTS: [string, string[]][] = [
	["plain prose", []],
	["some {++added++} text", []],
	["a {==mark==} here", []],
	["{--gone--} and {~~old~>new~~}", []],
	["{++{\"author\":\"bob\",\"time\":5}@@bob text++} and {--{\"author\":\"me\",\"time\":5}@@mine--}", []],
	["```\ncode\n```", ["```\ncode\n```"]],
	["~~~\nx\n~~~", ["~~~\nx\n~~~"]],
	["```js\nlet a;\n```", ["```js\nlet a;\n```"]],
	["```\n```", ["```\n```"]],
	["````\nfour\n````", ["````\nfour\n````"]],
	["- item\n  ```\n  code\n  ```", ["  ```\n  code\n  ```"]],
	["> ```\n> quoted\n> ```", ["> ```\n> quoted\n> ```"]],
	[">  ~~~\n>  q\n>  ~~~", [">  ~~~\n>  q\n>  ~~~"]],
	["```py\n\nx\n\n```", ["```py\n\nx\n\n```"]],
	["a {++abcdef++} b", []],
	["x {~~old~>new~~} y", []],
	["{==hi==}{>>c<<} z", []],
	["intro{++\n```js\nc\n```\n++}", ["```js\nc\n```"]],
	["- a\n\t- b\n\t  ```js\n\t  t\n\t  ```", ["\t  ```js\n\t  t\n\t  ```"]],
	["- a\n  - b\n    ```\n    n\n    ```", ["    ```\n    n\n    ```"]],
	["- ```js\n  m\n  ```", ["- ```js\n  m\n  ```"]],
	["> ```\n> open", ["> ```\n> open"]],
	["10. a\n\n    ```\n    o\n    ```", ["    ```\n    o\n    ```"]],
	["<!--\n```\n-->", []],
	["<pre>\n```\n</pre>", []],
	["-\n\n```\nx\n```", ["```\nx\n```"]],
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

const SEQUENCES = 1000;
const EDITS_PER_SEQUENCE = 6;
const NOTICE = "Inkling: this edit would break a code fence in Suggest mode.";
const DELIMITER = /\{(?:\+\+|--|~~|==|>>)|(?:\+\+|--|~~|==|<<)\}|~>/g;
const HAS_DELIMITER = new RegExp(DELIMITER.source);

const CONFIGS: [string, Partial<PluginSettings>][] = [
	["metadata off", { add_metadata: false }],
	["default settings", { author: "me" }],
];

type Change = { from: number; to: number; insert: string };
/** A range's positions, copied (range objects are shifted in place by the next update). */
type Range = { from: number; to: number; type: SuggestionType; start: number; closer: number; middle: number };
const copy = (r: CriticMarkupRange): Range => ({
	from: r.from,
	to: r.to,
	type: r.type,
	start: r.range_start,
	closer: r.closer_to,
	middle: r.type === SuggestionType.SUBSTITUTION ? (r as SubstitutionRange).middle : -1,
});

/** Positions of markup: delimiters and metadata. */
function markup(ranges: Range[]): Set<number> {
	const at = new Set<number>();
	const span = (from: number, to: number) => {
		for (let k = from; k < to; k++) at.add(k);
	};
	for (const r of ranges) {
		span(r.from, r.start);
		span(r.closer - 3, r.to);
		if (r.middle >= 0) span(r.middle, r.middle + 2);
	}
	return at;
}
/** Positions not in the accepted text: markup, deleted text and comments. */
function hidden(ranges: Range[]): Set<number> {
	const at = markup(ranges);
	for (const r of ranges) {
		const end = r.type === SuggestionType.SUBSTITUTION ?
			r.middle :
			r.type === SuggestionType.DELETION || r.type === SuggestionType.COMMENT ?
			r.to :
			r.from;
		for (let k = r.from; k < end; k++) at.add(k);
	}
	return at;
}
/** The text with every suggestion rejected and highlights removed. */
function rejected(text: string, ranges: Range[]): string {
	let out = "", last = 0;
	for (const r of ranges) {
		const keep = r.type === SuggestionType.DELETION || r.type === SuggestionType.HIGHLIGHT ?
			text.slice(r.start, r.closer - 3) :
			r.type === SuggestionType.SUBSTITUTION ?
			text.slice(r.start, r.middle) :
			"";
		out += text.slice(last, r.from) + keep;
		last = r.to;
	}
	return out + text.slice(last);
}

/**
 * Dispatches the user's edit of `kind` at `changes` (one per cursor) to `view`, as an editor would: the key, the
 * cursors (or selections) it starts from, then the change.
 */
function dispatchEdit(view: EditorView, kind: number, changes: Change[]) {
	const key = kind === 2 ? "Backspace" : kind === 3 ? "Delete" : kind === 1 ? "Enter" : "a";
	view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
	view.dispatch({
		selection: EditorSelection.create(
			changes.map(c =>
				kind === 2 ?
					EditorSelection.cursor(c.to) :
					EditorSelection.range(c.from, c.insert || kind === 6 ? c.to : c.from)
			),
		),
	});
	const tr = view.state.update({
		changes,
		selection: EditorSelection.create(changes.map((c, i) =>
			EditorSelection.cursor(
				c.from + c.insert.length + changes.slice(0, i).reduce((n, d) => n + d.insert.length - (d.to - d.from), 0),
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
	return tr;
}
const inCode = (regions: CodeRegion[], pos: number) => regions.some(r => r.from <= pos && pos <= r.to);
const count = (text: string, part: string) => text.split(part).length - 1;
const visible = (text: string, from: number, to: number, skip: Set<number>) =>
	[...text.slice(from, to)].filter((_, k) => !skip.has(from + k)).join("");

describe.each(CONFIGS)(
	"fuzz (%s): suggest-mode edits never put markup on a fence line or in code",
	(name, overrides) => {
		const settings = { ...DEFAULT_SETTINGS, ...overrides };
		const suggestView = (doc: string) =>
			new EditorView({
				state: createRangeState(doc, overrides, [
					editorEditorField,
					editorKeypressCatcher,
					EditorState.allowMultipleSelections.of(true),
					suggestionMode(settings),
				]),
			});
		const parse = (text: string) => getRangesInText(text, settings);

		test(`${SEQUENCES} random documents x ${EDITS_PER_SEQUENCE} edits`, () => {
			const notice = jest.spyOn(obsidian, "Notice").mockImplementation(() => ({}) as obsidian.Notice);
			// The guard's decision per change (null: refused), to tell which change a notice is for.
			const guard = jest.spyOn(fence_guard, "guardChange");
			const rng = mulberry32(Number(process.env.FUZZ_SEED ?? 0xFE11CE));
			const pick = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
			const failures: Record<string, number> = { r: 0, a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, throws: 0 };
			const examples: string[] = [];
			let edits_run = 0, multi_cursor = 0, near_fence = 0, structure_changes = 0, refused = 0, plain_in_code = 0;

			for (let seq = 0; seq < SEQUENCES; seq++) {
				const parts = Array.from({ length: 3 + Math.floor(rng() * 5) }, () => pick(PARTS));
				const doc = parts.map(([text]) => text).join("\n\n") + "\n\ntail {++t++}";
				let view = suggestView(doc);
				const log: [number, Change[]][] = [];
				const fail_example = (kind: string, detail: string, before: string) => {
					failures[kind]++;
					if (
						examples.length < (process.env.FUZZ_KIND ? 30 : 8) &&
						(!process.env.FUZZ_KIND || process.env.FUZZ_KIND === kind)
					) {
						examples.push(
							`(${name}, ${kind}) ${detail}\n    doc=${JSON.stringify(doc)} edits=${JSON.stringify(log)}` +
								`\n    before=${JSON.stringify(before)}\n    after=${JSON.stringify(view.state.doc.toString())}`,
						);
					}
				};

				// (r)
				const found = findCodeRegions(doc).map(r => doc.slice(r.from, r.to));
				if (JSON.stringify(found) !== JSON.stringify(parts.flatMap(([, blocks]) => blocks))) {
					fail_example("r", JSON.stringify(found), doc);
					continue;
				}

				for (let e = 0; e < EDITS_PER_SEQUENCE; e++) {
					const before = view.state.doc.toString();
					const before_regions = view.state.field(rangeParser).code_regions;
					const before_ranges = view.state.field(rangeParser).ranges.ranges.map(copy);
					const len = before.length;

					// Positions on and around fence lines (line start, after the prefix, line end, the lines around), and
					// inside ranges' content, where cursors type into existing suggestions.
					const hot: number[] = [];
					for (const r of before_regions) {
						for (const at of r.close_from < r.to ? [r.from, r.close_from] : [r.from]) {
							const end = (before.indexOf("\n", at) + 1 || len + 1) - 1;
							const prefix = /^[ \t>]*(?:[-+*] |\d+\. )?[ \t]*/.exec(before.slice(at, end))![0].length;
							hot.push(at - 1, at, at + prefix, end, end + 1);
						}
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
					if (!disjoint.length) continue;
					log.push([kind, disjoint]);
					edits_run++;
					if (disjoint.length > 1) multi_cursor++;
					if (disjoint.some(c => hot.some(h => Math.abs(h - c.from) <= 1 || Math.abs(h - c.to) <= 1))) near_fence++;

					let failed = false;
					const fail = (kind: string, detail = "") => {
						if (failed) return;
						failed = true;
						fail_example(kind, detail, before);
					};

					const notices_before = notice.mock.calls.length;
					guard.mockClear();
					let tr;
					try {
						// The key behind the edit, as the editor sees it (Backspace and Delete delete in different directions).
						tr = dispatchEdit(view, kind, disjoint);
					} catch (error) {
						fail("throws", String((error as Error).stack));
						break;
					}
					const shown = notice.mock.calls.slice(notices_before).map(call => call[0] as string);
					if (shown.length) refused++;
					// The decisions, made from the last cursor to the first; `decisions` in cursor order.
					const calls: (fence_guard.GuardedEdit | null)[] = guard.mock.results.map(r => r.value);
					const decisions = [...calls].reverse();
					const refused_changes = disjoint.filter((_, i) => decisions[i] === null);
					const accepted = disjoint.filter(c => !refused_changes.includes(c));
					const block_line = (c: Change) => before_regions.some(r => r.from <= c.to && c.from <= r.to);
					// Applied plainly on a block's lines (no markup written): a code edit, or one moved into a block.
					const plain_changes_in_code = disjoint.filter((c, i) =>
						decisions[i] && block_line(c) && !decisions[i]!.changes.some(x => HAS_DELIMITER.test(x.insert))
					);
					if (plain_changes_in_code.length) plain_in_code++;

					const after = view.state.doc.toString();
					const after_regions = view.state.field(rangeParser).code_regions;
					const after_ranges = view.state.field(rangeParser).ranges.ranges.map(copy);
					const plain_changes = ChangeSet.of(accepted, len);
					const plain = plain_changes.apply(Text.of(before.split("\n"))).toString();
					const plain_regions = findCodeRegions(plain);
					// The blocks a plain edit in code made: replaying the decisions in order (each is in the document the
					// earlier ones left), the blocks of the document after each plain one.
					const plain_blocks = new Set<string>();
					let replay = Text.of(before.split("\n"));
					calls.forEach((decision, k) => {
						if (!decision) return;
						replay = ChangeSet.of(decision.changes, replay.length).apply(replay);
						if (plain_changes_in_code.includes(disjoint[calls.length - 1 - k])) {
							const text = replay.toString();
							for (const r of findCodeRegions(text)) plain_blocks.add(text.slice(r.from, r.to));
						}
					});
					if (replay.toString() !== after) fail("throws", "the decisions do not replay to the result");

					// (d)
					const field = view.state.field(rangeParser);
					const spans = (ranges: { type: unknown; from: number; to: number }[]) =>
						JSON.stringify(ranges.map(r => [r.type, r.from, r.to]));
					if (
						spans(field.ranges.ranges) !== spans(parse(after)) ||
						JSON.stringify(field.code_regions) !== JSON.stringify(findCodeRegions(after))
					) {
						fail("d");
					}

					// (a)
					const block_text = (text: string) => (r: CodeRegion) => text.slice(r.from, r.to);
					const before_blocks = before_regions.map(block_text(before)),
						after_blocks = after_regions.map(block_text(after));
					for (const m of after.matchAll(DELIMITER)) {
						const at = m.index!;
						if (!inCode(after_regions, at)) continue;
						const back = tr.changes.invertedDesc.mapPos(at);
						const untouched = !tr.changes.touchesRange(back, back + m[0].length) && inCode(before_regions, back);
						const region = after_regions.find(r => r.from <= at && at <= r.to)!;
						const block = after.slice(region.from, region.to);
						if (!untouched && !before_blocks.includes(block) && !plain_blocks.has(block)) {
							fail("a", `${JSON.stringify(m[0])} at ${at}`);
							break;
						}
					}

					// (b)
					const changed = !regionsPreserved(before_regions, tr.changes, after_regions);
					const plain_changed = !regionsPreserved(before_regions, plain_changes, plain_regions);
					if (changed) structure_changes++;
					if (changed && !plain_changed) fail("b", "structure changed, though the plain edit keeps it");
					// Pasted complete blocks, outside code (text typed in an opening fence line's prefix or fence characters
					// goes above it, and after a closing one below).
					const in_code = (c: Change) =>
						before_regions.some(r =>
							r.from + /^[^`~]*[`~]+/.exec(before.slice(r.from, r.to))![0].length <= c.from && c.to <= r.to &&
							!(c.from === r.to && r.close_from < r.to)
						);
					const pasted = accepted.filter(c => !in_code(c)).flatMap(c =>
						findCodeRegions(c.insert).filter(r => r.close_from < r.to).map(block_text(c.insert))
					);
					after_blocks.forEach(text => {
						if (!before_blocks.includes(text) && !pasted.includes(text) && !plain_blocks.has(text))
							fail("b", `new block ${JSON.stringify(text)}`);
					});
					const own = before_regions.filter(r =>
						before_ranges.some(range =>
							range.type === SuggestionType.ADDITION && range.from < r.from && r.to < range.to
						) &&
						accepted.some(c => c.from < r.to && r.from < c.to)
					);
					const most = before_regions.length + pasted.length, least = most - own.length;
					if (after_regions.length < least || after_regions.length > most)
						fail("b", `${after_regions.length} blocks, expected ${least}-${most}`);
					for (const r of before_regions) {
						if (!tr.changes.touchesRange(r.from, r.to) && !after_blocks.includes(before.slice(r.from, r.to)))
							fail("b", "untouched block changed");
					}

					// (c)
					const touched: [number, number][] = disjoint.map(c => [c.from, c.to]);
					tr.changes.iterChangedRanges((fromA, toA) => touched.push([fromA, toA]));
					const after_texts = after_ranges.map(r => after.slice(r.from, r.to));
					for (const range of before_ranges) {
						if (touched.some(([from, to]) => range.from <= to + 1 && from - 1 <= range.to)) continue;
						const i = after_texts.indexOf(before.slice(range.from, range.to));
						if (i === -1) {
							fail("c", `${JSON.stringify(before.slice(range.from, range.to))} vanished`);
							break;
						}
						after_texts.splice(i, 1);
					}

					// (e)
					// Exact, but for the lines holding only a quote or indent prefix that a tracked change around a block adds
					// so its markers are on lines of their own (at most two per change).
					if (!plain_changes_in_code.length) {
						const want = rejected(before, before_ranges).split("\n"), got = rejected(after, after_ranges).split("\n");
						let w = 0, extra = 0;
						for (const line of got) {
							if (w < want.length && line === want[w]) w++;
							else if (/^[ \t>]*$/.test(line)) extra++;
							else extra = Infinity;
						}
						if (w < want.length || extra > 2 * accepted.length)
							fail("e", "rejecting every suggestion does not restore the text");
					}

					// (f)
					// Changes whose windows (W around each) overlap are checked together: text may move a little (next to a
					// fence), so a typed character is looked for in the whole cluster's window.
					const W = 60;
					const clusters: Change[][] = [];
					for (const c of disjoint) {
						const last = clusters.at(-1);
						if (last && last.at(-1)!.to + 2 * W >= c.from) last.push(c);
						else clusters.push([c]);
					}
					// A deleted character is applied once it is gone from the accepted text (counted per character in the
					// window, so an equivalent deletion shifted by a character, or one widened to whole blocks, counts).
					// Markup, already deleted text and comments are not in the accepted text; a line break next to a fence
					// line, and a fence line's quote or indent prefix, may stay so markers stay on prose lines.
					const fence_breaks = new Set(before_regions.flatMap(r => [r.from - 1, r.open_to, r.close_from - 1, r.to]));
					for (const r of before_regions) {
						for (const at of r.close_from < r.to ? [r.from, r.close_from] : [r.from]) {
							const prefix = /^[^`~]*/.exec(before.slice(at, r.to))![0].length;
							for (let k = 0; k < prefix; k++) fence_breaks.add(at + k);
						}
					}
					const hidden_before = hidden(before_ranges), hidden_after = hidden(after_ranges);
					const markup_before = markup(before_ranges), markup_after = markup(after_ranges);
					const dropped = (cluster: Change[]) => {
						// Window ends outside every range and every changed span, so both windows hold the same text.
						let lo = Math.max(0, cluster[0].from - W), hi = Math.min(len, cluster.at(-1)!.to + W);
						for (let moved = true; moved;) {
							moved = false;
							const spans: [number, number][] = before_ranges.map(r => [r.from, r.to]);
							tr.changes.iterChangedRanges((fromA, toA) => spans.push([fromA, toA]));
							for (const [from, to] of spans) {
								if (from < lo && lo < to) (lo = from, moved = true);
								if (from < hi && hi < to) (hi = to, moved = true);
							}
						}
						const window = (
							skip_before: Set<number>,
							skip_after: Set<number>,
						) => [
							visible(before, lo, hi, skip_before),
							visible(after, tr.changes.mapPos(lo, -1), tr.changes.mapPos(hi, 1), skip_after),
						];
						const typed = cluster.map(c => c.insert).join("");
						// Typed characters are all there, in the text without markup.
						const [text_before, text_after] = window(markup_before, markup_after);
						// (With several cursors, one's selection may cover text another typed: checked step by step below.)
						const lost = cluster.length === 1 &&
							[...new Set(typed)].some(ch =>
								count(text_after, ch) < count(text_before, ch) + count(typed, ch) -
										cluster.reduce((n, c) => n + count(visible(before, c.from, c.to, markup_before), ch), 0)
							);
						// Nor is text outside the change removed: tracked deletions keep it, and pending text (not tracked) is
						// removed only where selected (a Backspace or Delete may take the one character its cursor reaches).
						// (The window may reach another cursor's change: what every cursor selected may go.)
						const selected = disjoint.map(c => visible(before, c.from, c.to, markup_before)).join("");
						const removed_more = cluster.length === 1 &&
							[...new Set(text_before)].some(ch =>
								count(text_after, ch) <
									count(text_before, ch) + count(typed, ch) - count(selected, ch) -
										(kind === 2 || kind === 3 ? disjoint.length : 0)
							);
						const [accepted_before, accepted_after] = window(hidden_before, hidden_after);
						const deleted = cluster.filter(c => !c.insert).flatMap(c =>
							[...before.slice(c.from, c.to)].filter((_, i) =>
								!hidden_before.has(c.from + i) && !fence_breaks.has(c.from + i)
							)
						).join("");
						const kept = [...new Set(deleted)].some(ch =>
							count(accepted_before, ch) + count(typed, ch) - count(accepted_after, ch) < count(deleted, ch)
						);
						return lost || kept || removed_more;
					};
					for (const cluster of clusters) {
						if (cluster.every(c => !refused_changes.includes(c)) && dropped(cluster))
							fail("f", "dropped a change that was not refused");
					}
					// A Backspace or Delete deletes the character its cursor reaches past markup, unless that one is
					// already deleted (or is a line break kept next to a fence line).
					for (const c of accepted.filter(() => kind === 2 || kind === 3)) {
						let k = kind === 2 ? c.to - 1 : c.from;
						while (markup_before.has(k)) k += kind === 2 ? -1 : 1;
						if (k < 0 || k >= len || hidden_before.has(k) || fence_breaks.has(k)) continue;
						const lo = Math.max(0, k - W), hi = Math.min(len, k + W);
						const ch = before[k], [after_lo, after_hi] = [tr.changes.mapPos(lo, -1), tr.changes.mapPos(hi, 1)];
						if (
							count(visible(before, lo, hi, hidden_before), ch) <=
								count(visible(after, after_lo, after_hi, hidden_after), ch)
						) {
							fail("f", `${kind === 2 ? "Backspace" : "Delete"} left ${JSON.stringify(ch)} at ${k}`);
						}
					}
					// Away from blocks (no widening), Accept gives the text without the selection (selection deletes), and
					// retyping inside one addition of one's own replaces its text in place (no new range).
					const off_blocks = (c: Change) => !before_regions.some(r => r.from - 1 <= c.to && c.from <= r.to + 1);
					if (disjoint.length === 1 && accepted.length === 1 && off_blocks(accepted[0])) {
						const c = accepted[0];
						if (kind === 6) {
							const want = visible(before, 0, c.from, hidden_before) + visible(before, c.to, len, hidden_before);
							if (visible(after, 0, after.length, hidden_after) !== want)
								fail("f", `Accept does not give the text without the selection: ${JSON.stringify(want)}`);
						}
						const home = before_ranges.find(r =>
							r.type === SuggestionType.ADDITION && r.start <= c.from && c.to <= r.closer - 3 &&
							(!settings.add_metadata || before.slice(r.from, r.start).includes(`"author":"me"`))
						);
						if (kind === 5 && home && after_ranges.length !== before_ranges.length)
							fail("f", "retyping inside one addition split it");
					}
					// At blocks, text typed over a selection is, in Accept, beside only what was beside the selection on its
					// lines, or on a line of its own (with a container prefix): never joined to a neighbouring line's text.
					// (Selection ends inside a range move the text to that range's ends: what is beside it there is checked
					// by the fragmentation and loss checks.)
					const outside = (pos: number) => !before_ranges.some(r => r.from < pos && pos < r.to);
					if (
						kind === 5 && disjoint.length === 1 && accepted.length === 1 && !off_blocks(accepted[0]) &&
						outside(accepted[0].from) && outside(accepted[0].to)
					) {
						const c = accepted[0];
						let typed_at = -1;
						tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
							for (let k = fromB; k < toB && typed_at < 0; k++)
								if (after[k] === "Z" && !hidden_after.has(k)) typed_at = k;
						});
						const line_text = (text: string, at: number, skip: Set<number>, dir: -1 | 1) => {
							let out = "";
							for (let k = at; k >= 0 && k < text.length; k += dir) {
								if (skip.has(k)) continue;
								if (text[k] === "\n") break;
								out = dir < 0 ? text[k] + out : out + text[k];
							}
							return out;
						};
						if (typed_at >= 0) {
							// (A run of "Z"s is one: a character diff may match the typed one to a neighbour.)
							const left = line_text(after, typed_at - 1, hidden_after, -1).replace(/Z+$/, "");
							const right = line_text(after, typed_at + 1, hidden_after, 1).replace(/^Z+/, "");
							const was_left = line_text(before, c.from - 1, hidden_before, -1).replace(/Z+$/, "");
							const was_right = line_text(before, c.to, hidden_before, 1).replace(/^Z+/, "");
							const alone = (t: string) => /^[ \t>]*$/.test(t);
							if (!(alone(left) || left === was_left) || !(alone(right) || right === was_right))
								fail("f", `Accept joins the typed text to a neighbouring line: ${JSON.stringify(left + "Z" + right)}`);
						}
					}
					if (shown.length !== (refused_changes.length ? 1 : 0) || shown.some(text => text !== NOTICE))
						fail("f", `notices ${JSON.stringify(shown)}, refused ${refused_changes.length}`);

					// Several cursors: the same as each cursor's change alone, from the last to the first.
					if (disjoint.length > 1) {
						// Each cursor stays on its text: mapped through the edits already made (a Backspace or Delete by its
						// cursor).
						const alone = suggestView(before);
						let made = ChangeSet.empty(len);
						for (const c of [...disjoint].reverse()) {
							const cursor = made.mapPos(kind === 2 ? c.to : c.from, -1), end = alone.state.doc.length;
							const start = kind === 2 ? cursor - 1 : kind === 3 ? cursor : made.mapPos(c.from, -1);
							const from = Math.min(Math.max(0, start), end);
							const to = Math.min(kind === 2 || kind === 3 ? start + 1 : Math.max(from, made.mapPos(c.to, -1)), end);
							if (from === to && !c.insert) continue;
							// Each step keeps the text it types (outside markup), unless it is refused, and removes no more of
							// it than it selected (widening over another cursor's typed text is refused).
							const text_and_markup = () => {
								const text = alone.state.doc.toString();
								return [text, markup(alone.state.field(rangeParser).ranges.ranges.map(copy))] as const;
							};
							const [text_before, markup_before_step] = text_and_markup();
							const notices_now = notice.mock.calls.length;
							const tr_alone = dispatchEdit(alone, kind, [{ from, to, insert: c.insert }]);
							if (notice.mock.calls.length === notices_now) {
								const [text_after, markup_after_step] = text_and_markup();
								const selected = visible(text_before, from, to, markup_before_step);
								const shown_before = visible(text_before, 0, text_before.length, markup_before_step);
								const shown_after = visible(text_after, 0, text_after.length, markup_after_step);
								for (const ch of new Set(c.insert)) {
									if (count(shown_after, ch) < count(shown_before, ch) + count(c.insert, ch) - count(selected, ch))
										fail("f", `a cursor's typed ${JSON.stringify(ch)} is lost when applied in turn`);
								}
							}
							made = made.compose(
								alone.state.doc === tr_alone.startState.doc ? ChangeSet.empty(made.newLength) : tr_alone.changes,
							);
						}
						const strip = (text: string) => text.replace(/"time":\d+/g, "");
						if (strip(alone.state.doc.toString()) !== strip(after))
							fail("f", `differs from the cursors in turn: ${JSON.stringify(alone.state.doc.toString())}`);
						// A second view replaces the test harness's settings field, so the sequence goes on in a new view.
						view = suggestView(after);
					}

					// Later edits would start from a broken document; each sequence counts its first failure only.
					if (failed) break;
				}
			}
			notice.mockRestore();
			guard.mockRestore();

			console.log(
				`fence fuzz (${name}): ${SEQUENCES} docs, ${edits_run} edits (${multi_cursor} multi-cursor, ${near_fence} at a fence ` +
					`line, ${plain_in_code} plain in code, ${structure_changes} structure changes, ${refused} refused with a ` +
					`notice); failures ${JSON.stringify(failures)}`,
			);
			for (const example of examples) console.log("  example: " + example);
			expect(failures).toEqual({ r: 0, a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, throws: 0 });
		});
	},
);
