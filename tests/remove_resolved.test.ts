import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import type { EditorChange } from "../src/editor/base/edit-handler";
import {
	remove_resolved_threads,
	remove_thread,
	resolve_action,
	resolve_source,
	resolve_thread,
} from "../src/editor/base/edit-logic/resolve";
import { applyToText } from "../src/editor/base/edit-util/range-operations";
import type { CriticMarkupRange } from "../src/editor/base/ranges";
import { createRangeState, withSyntax } from "./helpers";

function apply(doc: string, changes: EditorChange[]): string {
	const ordered = [...changes].sort((a, b) => a.from - b.from);
	for (let i = 1; i < ordered.length; i++) expect(ordered[i].from).toBeGreaterThanOrEqual(ordered[i - 1].to);
	return [...ordered].reverse().reduce((out, c) => out.slice(0, c.from) + c.insert + out.slice(c.to), doc);
}

function ranges(doc: string): CriticMarkupRange[] {
	return createRangeState(doc, { enable_metadata: true }).field(rangeParser).ranges.ranges;
}

const KEEP = { ...DEFAULT_SETTINGS, remove_on_resolve: false };
const REMOVE = { ...DEFAULT_SETTINGS, remove_on_resolve: true };

describe.each(["legacy", "attributes"] as const)("%s metadata", (syntax) => {
	const doc = (legacy: string) => withSyntax(legacy, syntax);

	describe("remove_thread", () => {
		test.each([
			["standalone comment thread", `x{>>{"author":"A"}@@a<<}{>>b<<}y`, `xy`],
			["highlight thread keeps its text", `a {=={"author":"A"}@@b==}{>>{"author":"A"}@@c<<}{>>d<<} e`, `a b e`],
			["suggestion keeps its markup", `a{++{"author":"A"}@@b++}{>>c<<}d`, `a{++{"author":"A"}@@b++}d`],
		])("%s", (_name, input, expected) => {
			const source = doc(input);
			expect(apply(source, remove_thread(ranges(source)[0]))).toBe(doc(expected));
		});
	});

	describe("remove_resolved_threads", () => {
		const NOTE =
			`p {=={"done":true}@@h==}{>>{"author":"A"}@@c<<} q {>>open<<} r{>>{"done":true}@@gone<<}{>>reply<<} s` +
			` {++{"done":true}@@kept++}{>>why<<} t`;

		test("removes resolved comment threads only, in one non-overlapping set of changes", () => {
			const source = doc(NOTE);
			const { changes, count } = remove_resolved_threads(ranges(source));
			expect(count).toBe(2);
			expect(apply(source, changes))
				.toBe(doc(`p h q {>>open<<} r s {++{"done":true}@@kept++}{>>why<<} t`));
		});

		test("does nothing in a note without resolved threads", () => {
			expect(remove_resolved_threads(ranges(doc(`a {==b==}{>>c<<} {>>d<<}`)))).toEqual({ changes: [], count: 0 });
		});
	});

	describe("resolve_action", () => {
		const THREAD = `a {=={"author":"A"}@@b==}{>>{"author":"A"}@@c<<} e`;

		test("marks the thread done when remove_on_resolve is off", () => {
			const source = doc(THREAD);
			const [base] = ranges(source);
			expect(resolve_action(base, { ...KEEP, metadata_syntax: syntax }))
				.toEqual(resolve_thread(base, syntax));
		});

		test("removes the thread when remove_on_resolve is on", () => {
			const source = doc(THREAD);
			expect(apply(source, resolve_action(ranges(source)[0], REMOVE))).toBe(`a b e`);
		});
	});

	describe("resolve_source (Annotations view, visits base and replies)", () => {
		const run = (source: string, settings: typeof KEEP) => {
			const [base] = ranges(source);
			return applyToText(source, (range, text) => resolve_source(range, text, settings), [base, ...base.replies]);
		};

		test("remove mode unwraps a highlight thread", () => {
			expect(run(doc(`a {=={"author":"A"}@@b==}{>>{"author":"A"}@@c<<}{>>d<<} e`), REMOVE)).toBe(`a b e`);
		});

		test("remove mode drops a standalone comment thread", () => {
			expect(run(doc(`x{>>{"author":"A"}@@a<<}{>>b<<}y`), REMOVE)).toBe(`xy`);
		});

		test("keep mode writes done on the base and leaves replies untouched", () => {
			expect(run(`{=={"author":"A"}@@x==}{>>{"author":"A"}@@c<<}`, KEEP))
				.toBe(`{=={"author":"A","done":true}@@x==}{>>{"author":"A"}@@c<<}`);
		});
	});
});
