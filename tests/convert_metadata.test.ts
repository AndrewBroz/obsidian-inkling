import { DEFAULT_SETTINGS } from "../src/constants";
import type { EditorChange } from "../src/editor/base/edit-handler";
import { convert_metadata } from "../src/editor/base/edit-logic/convert-metadata";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";

const parse = (doc: string) => getRangesInText(doc, { ...DEFAULT_SETTINGS, enable_metadata: true });

function apply(doc: string, changes: EditorChange[]) {
	const ordered = [...changes].sort((a, b) => a.from - b.from);
	for (let i = 1; i < ordered.length; i++) expect(ordered[i].from).toBeGreaterThanOrEqual(ordered[i - 1].to);
	return [...ordered].reverse().reduce((out, c) => out.slice(0, c.from) + c.insert + out.slice(c.to), doc);
}
const convert = (doc: string, target: "legacy" | "attributes") =>
	apply(doc, convert_metadata(parse(doc), target).changes);
const effective = (doc: string) => parse(doc).map(r => r.fields);

// EXPL: What Inkling itself writes in legacy: anchor and first comment carry identical fields; done only on the base.
const INKLING_SHAPED = [
	`This is {=={"author":"Andrew","time":1791819807}@@some==}{>>{"author":"Andrew","time":1791819807}@@note<<} text`,
	`{=={"author":"A","time":1,"done":true}@@x==}{>>{"author":"A","time":1}@@c<<}{>>{"author":"B","time":2}@@r<<}`,
	`a {++{"author":"Bea","time":5}@@new++}{>>{"author":"A","time":6}@@why?<<} b`,
	`{~~{"author":"A"}@@o~>n~~} {--{"author":"A"}@@d--} {>>{"author":"A"}@@lone<<}{>>{"author":"B"}@@reply<<}`,
];

describe("legacy → attributes", () => {
	test("applies the thread rules", () => {
		expect(convert(INKLING_SHAPED[0], "attributes"))
			.toBe(`This is {==some==}{>>note<<}{author=Andrew time=1791819807} text`);
		expect(convert(INKLING_SHAPED[1], "attributes"))
			.toBe(`{==x==}{done=true}{>>c<<}{author=A time=1}{>>r<<}{author=B time=2}`);
	});

	test("drops done on replies", () => {
		expect(convert(`{=={"done":true}@@x==}{>>{"author":"A","done":true}@@c<<}`, "attributes"))
			.toBe(`{==x==}{done=true}{>>c<<}{author=A}`);
	});

	test("suggestion anchors keep their own fields", () => {
		expect(convert(INKLING_SHAPED[2], "attributes")).toBe(
			`a {++new++}{author=Bea time=5}{>>why?<<}{author=A time=6} b`,
		);
	});

	test("unconvertible ranges stay legacy, with a reason", () => {
		const doc = `{++{"author":"A","note":{"x":1}}@@a++} {++{"author":"B"}@@b++}`;
		const result = convert_metadata(parse(doc), "attributes");
		expect(result.converted).toBe(1);
		expect(result.skipped.map(s => s.reason)).toEqual([expect.stringContaining("note")]);
		expect(apply(doc, result.changes)).toBe(`{++{"author":"A","note":{"x":1}}@@a++} {++b++}{author=B}`);
	});

	test("an anchor keeps fields that differ from its first comment", () => {
		expect(convert(`{=={"author":"Z","time":1}@@x==}{>>{"author":"A","time":1}@@c<<}`, "attributes"))
			.toBe(`{==x==}{author=Z}{>>c<<}{author=A time=1}`);
	});
});

describe("round trip (spec: lossless conversion)", () => {
	test.each(INKLING_SHAPED)("is byte-identical for Inkling-shaped input: %s", (doc) => {
		expect(convert(convert(doc, "attributes"), "legacy")).toBe(doc);
	});

	test.each([
		...INKLING_SHAPED,
		`{=={"author":"A","time":1}@@x==}{>>{"author":"A","time":1,"note":{"x":1}}@@c<<}`, // reply stays legacy
		`{==x==}{>>{"author":"A","time":1}@@c<<}`, // anchor states nothing
		`{=={"done":true}@@x==}{>>{"author":"A","done":true}@@c<<}`, // done on a reply
		`{=={"author":"Z"}@@x==}{>>{"author":"A","time":1}@@c<<}`, // anchor differs
	])("preserves every range's effective fields: %s", (doc) => {
		// EXPL: Replies' `fields` already drop `done` (Task 4), so effective fields compare directly.
		expect(effective(convert(convert(doc, "attributes"), "legacy"))).toEqual(effective(doc));
	});

	test("a legacy anchor that stated nothing gains its inherited fields on the way back (spec)", () => {
		const doc = `{==x==}{>>{"author":"A","time":1}@@c<<}`;
		expect(convert(convert(doc, "attributes"), "legacy"))
			.toBe(`{=={"author":"A","time":1}@@x==}{>>{"author":"A","time":1}@@c<<}`);
	});

	test("converting an all-legacy note back is a no-op", () => {
		for (const doc of INKLING_SHAPED) expect(convert_metadata(parse(doc), "legacy").changes).toEqual([]);
	});
});

test.each(["attributes", "legacy"] as const)("leaves the parsed ranges untouched (to %s)", (target) => {
	const doc = target === "attributes" ?
		INKLING_SHAPED[1] :
		`{==x==}{done=true}{>>c<<}{author=A time=1}{>>r<<}{author=B}`;
	const ranges = parse(doc);
	const before = ranges.map(r => ({ ...r.own_fields }));
	expect(convert_metadata(ranges, target).converted).toBeGreaterThan(0);
	expect(ranges.map(r => r.own_fields)).toEqual(before);
});

describe("mixed threads", () => {
	// EXPL: The anchor's reply stays legacy (unconvertible), so the anchor must keep its own fields to stay reversible.
	const stuck = `{=={"author":"A","time":1}@@x==}{>>{"author":"A","time":1,"note":{"x":1}}@@c<<}`;

	test("an anchor keeps its fields while its first comment stays legacy", () => {
		expect(convert(stuck, "attributes"))
			.toBe(`{==x==}{author=A time=1}{>>{"author":"A","time":1,"note":{"x":1}}@@c<<}`);
		expect(convert(convert(stuck, "attributes"), "legacy")).toBe(stuck);
	});

	test("an attributes anchor with a legacy reply gets its inherited fields written out", () => {
		expect(convert(`{==x==}{done=true}{>>{"author":"A","time":1}@@c<<}`, "legacy"))
			.toBe(`{=={"author":"A","time":1,"done":true}@@x==}{>>{"author":"A","time":1}@@c<<}`);
	});
});

describe("mixed notes", () => {
	test("only ranges in the other syntax are converted", () => {
		const doc = `{++{"author":"A"}@@a++} {++b++}{author=B}`;
		expect(convert(doc, "attributes")).toBe(`{++a++}{author=A} {++b++}{author=B}`);
		expect(convert(doc, "legacy")).toBe(`{++{"author":"A"}@@a++} {++{"author":"B"}@@b++}`);
	});
});
