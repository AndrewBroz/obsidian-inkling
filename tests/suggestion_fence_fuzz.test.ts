import { ChangeSet, EditorSelection, EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorEditorField } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { findCodeRegions, inCodeRegion, regionsPreserved } from "../src/editor/base/edit-util/code-regions";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import { suggestionMode } from "../src/editor/uix/extensions";
import { createRangeState } from "./helpers";

// EXPL: Property test for the suggest-mode fence guard (.superpowers/sdd/2026-11-20-0.13.0-stable/fence-guard-findings.md).
//       Random documents mixing prose, ranges and fenced blocks of every kind, and random single- and multi-cursor
//       suggest-mode edits concentrated on and around fence lines. After every edit:
//       (a) no CriticMarkup opener the edit wrote lies inside a code region (beyond openers the user typed);
//       (b) the code-region structure changed only if the user's edit deliberately changed it: a deletion covering
//           fence characters, or a plain edit that itself changes the structure by typing fence characters or
//           CriticMarkup braces, by editing a CriticMarkup delimiter, by editing a fence line after its first fence
//           character (inside the marker or the info string), or by a plain edit of code content;
//       (c) unless (b)'s exception applies, the edit changes a delimiter or the markup has a stray opener, every range
//           the edit did not touch still parses;
//       (d) the incremental rangeParser state equals a full parse.
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
];

const TYPED = ["a", " ", "`", ">", "~", "}", "x"];
const PASTES = ["x\ny", "\n```\n", "a\n", "\n", "p\n\nq"];

const SEQUENCES = 2000;
const EDITS_PER_SEQUENCE = 6;

const FENCE_LINE = /^( {0,3}(?:> {0,4})*)(\{(?:\+\+|--|==|~~))?(`{3,}|~{3,})/;
const OPENER = /\{(?:\+\+|--|~~|==|>>)/g;
const DELIMITER = /\{(?:\+\+|--|~~|==|>>)|(?:\+\+|--|~~|==|<<)\}|~>/g;

function suggestView(doc: string): EditorView {
	return new EditorView({
		state: createRangeState(doc, { add_metadata: false }, [
			editorEditorField,
			EditorState.allowMultipleSelections.of(true),
			suggestionMode({ ...DEFAULT_SETTINGS, add_metadata: false }),
		]),
	});
}

/** Fence markers (the run of backticks or tildes) of every fence-shaped line, as [from, to, line end). */
function fenceMarkers(text: string): [number, number, number][] {
	const markers: [number, number, number][] = [];
	let pos = 0;
	for (const line of text.split("\n")) {
		const m = FENCE_LINE.exec(line);
		if (m) {
			const start = pos + m[1].length + (m[2]?.length ?? 0);
			markers.push([start, start + m[3].length, pos + line.length]);
		}
		pos += line.length + 1;
	}
	return markers;
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

describe("fuzz: suggest-mode edits never break fenced code", () => {
	test(`${SEQUENCES} random documents x ${EDITS_PER_SEQUENCE} edits`, () => {
		const rng = mulberry32(0xFE11CE);
		const pick = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
		const failures: Record<string, number> = { a: 0, b: 0, c: 0, d: 0, throws: 0 };
		const examples: string[] = [];
		let edits_run = 0, multi_cursor = 0, near_fence = 0, structure_changes = 0, refused = 0;

		for (let seq = 0; seq < SEQUENCES; seq++) {
			const n = 3 + Math.floor(rng() * 5);
			let doc = Array.from({ length: n }, () => pick(PARTS)).join("\n") + "\ntail {++t++}";
			if (rng() < 0.15) doc = doc.replace(/\n/g, "\r\n");
			const view = suggestView(doc);
			const log: Change[][] = [];

			for (let e = 0; e < EDITS_PER_SEQUENCE; e++) {
				const before = view.state.doc.toString();
				const before_regions = view.state.field(rangeParser).code_regions;
				// Copied: range objects are shifted in place by the next update.
				const before_ranges = view.state.field(rangeParser).ranges.ranges.map(r => ({ from: r.from, to: r.to }));
				const len = before.length;

				// Positions on and around fence lines: line start, after the prefix, line end, the previous line's end
				// and the next line's start.
				const hot: number[] = [];
				let pos = 0;
				for (const line of before.split("\n")) {
					const m = FENCE_LINE.exec(line);
					if (m) hot.push(pos - 1, pos, pos + m[1].length, pos + line.length, pos + line.length + 1);
					pos += line.length + 1;
				}
				const position = () => {
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
				log.push(disjoint);
				edits_run++;
				if (disjoint.length > 1) multi_cursor++;
				if (disjoint.some(c => hot.some(h => Math.abs(h - c.from) <= 1 || Math.abs(h - c.to) <= 1))) near_fence++;

				const fail = (kind: string, detail = "") => {
					failures[kind]++;
					if (examples.length < 8)
						examples.push(`(${kind}) ${detail} doc=${JSON.stringify(doc)} edits=${JSON.stringify(log)}`);
				};

				let tr;
				try {
					// The cursors (or selections) the edit starts from, as an editor would have them.
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
				if (!tr.docChanged) refused++;

				const after = view.state.doc.toString();
				const after_regions = view.state.field(rangeParser).code_regions;
				const plain_changes = ChangeSet.of(disjoint, len);
				const plain = plain_changes.apply(Text.of(before.split("\n"))).toString();
				const plain_regions = findCodeRegions(plain);

				// (d)
				if (staleState(view.state)) fail("d");

				// (a): openers the edit wrote, beyond those the user typed, that lie in code.
				let written_in_code = 0;
				tr.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
					for (const m of inserted.toString().matchAll(OPENER))
						if (inCodeRegion(after_regions, fromB + m.index!)) written_in_code++;
				});
				const typed_openers = disjoint.reduce((n, c) => n + (c.insert.match(OPENER)?.length ?? 0), 0);
				if (written_in_code > typed_openers) fail("a", JSON.stringify(after));

				// (b)
				const changed = !regionsPreserved(before_regions, tr.changes, after_regions);
				const plain_changed = !regionsPreserved(before_regions, plain_changes, plain_regions);
				const markers = fenceMarkers(before);
				const covers_fence = disjoint.some(c => markers.some(([s, t]) => c.from < t && s < c.to));
				// Editing a CriticMarkup delimiter itself (inside it, or deleting part of it) changes what the markup
				// means, which can change which line closes a block.
				const delimiters = [...before.matchAll(DELIMITER)].map(m => [m.index!, m.index! + m[0].length]);
				const edits_markup = disjoint.some(c =>
					delimiters.some(([s, t]) => c.from === c.to ? s < c.from && c.from < t : c.from < t && s < c.to)
				);
				// Editing code content (between a block's fence lines) can turn a code line into a fence line; nothing
				// but the plain edit is right there ((a) checks no markup is written there).
				const in_content = disjoint.some(c => before_regions.some(r => r.inner_from <= c.from && c.to < r.inner_to));
				const deliberate = covers_fence || (plain_changed && (edits_markup || in_content)) ||
					(plain_changed && disjoint.some(c =>
						/[`~{}]/.test(c.insert + before.slice(c.from, c.to)) ||
						markers.some(([s, , end]) => s < c.from && c.to <= end)
					));
				if (changed) structure_changes++;
				if (changed && !deliberate) fail("b", JSON.stringify(after));

				// (c): the spans the user's edit and the applied edit touched (a tracked deletion may merge a neighbour).
				const touched: [number, number][] = disjoint.map(c => [c.from, c.to]);
				tr.changes.iterChangedRanges((fromA, toA) => touched.push([fromA, toA]));
				// A stray opener (left by an earlier edit that broke a delimiter) pairs with whatever closer comes next,
				// fences or not, so (c) only holds for well-formed markup.
				const stray = [...before.matchAll(OPENER)].filter(m => !inCodeRegion(before_regions, m.index!)).length !==
					before_ranges.length;
				if (!deliberate && !edits_markup && !stray) {
					const after_texts = view.state.field(rangeParser).ranges.ranges.map(r => after.slice(r.from, r.to));
					for (const range of before_ranges) {
						if (touched.some(([from, to]) => range.from <= to + 1 && from - 1 <= range.to)) continue;
						const text = before.slice(range.from, range.to);
						const i = after_texts.indexOf(text);
						if (i === -1) {
							fail("c", `${JSON.stringify(text)} in ${JSON.stringify(after)}`);
							break;
						}
						after_texts.splice(i, 1);
					}
				}
			}
		}

		console.log(
			`fence fuzz: ${SEQUENCES} docs, ${edits_run} edits (${multi_cursor} multi-cursor, ${near_fence} at a fence line, ` +
				`${structure_changes} deliberate structure changes, ${refused} refused); failures ${JSON.stringify(failures)}`,
		);
		for (const example of examples) console.log("  example: " + example);
		expect(failures).toEqual({ a: 0, b: 0, c: 0, d: 0, throws: 0 });
	});
});
