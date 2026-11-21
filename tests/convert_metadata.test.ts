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
const convert = (doc: string) => apply(doc, convert_metadata(parse(doc)).changes);
const effective = (doc: string) => parse(doc).map(r => r.fields);

// EXPL: What Inkling itself wrote in legacy: anchor and first comment carry identical fields; done only on the base.
//       Legacy is deprecated: read, and converted on request, never written back.
const INKLING_SHAPED = [
	`This is {=={"author":"Andrew","time":1791819807}@@some==}{>>{"author":"Andrew","time":1791819807}@@note<<} text`,
	`{=={"author":"A","time":1,"done":true}@@x==}{>>{"author":"A","time":1}@@c<<}{>>{"author":"B","time":2}@@r<<}`,
	`a {++{"author":"Bea","time":5}@@new++}{>>{"author":"A","time":6}@@why?<<} b`,
	`{~~{"author":"A"}@@o~>n~~} {--{"author":"A"}@@d--} {>>{"author":"A"}@@lone<<}{>>{"author":"B"}@@reply<<}`,
];

describe("legacy → attributes", () => {
	test("applies the thread rules", () => {
		expect(convert(INKLING_SHAPED[0])).toBe(`This is {==some==}{>>note<<}{author=Andrew time=1791819807} text`);
		expect(convert(INKLING_SHAPED[1])).toBe(`{==x==}{done=true}{>>c<<}{author=A time=1}{>>r<<}{author=B time=2}`);
	});

	test("drops done on replies", () => {
		expect(convert(`{=={"done":true}@@x==}{>>{"author":"A","done":true}@@c<<}`))
			.toBe(`{==x==}{done=true}{>>c<<}{author=A}`);
	});

	test("suggestion anchors keep their own fields", () => {
		expect(convert(INKLING_SHAPED[2])).toBe(`a {++new++}{author=Bea time=5}{>>why?<<}{author=A time=6} b`);
	});

	test("unconvertible ranges stay legacy, with a reason", () => {
		const doc = `{++{"author":"A","note":{"x":1}}@@a++} {++{"author":"B"}@@b++}`;
		const result = convert_metadata(parse(doc));
		expect(result.converted).toBe(1);
		expect(result.skipped.map(s => s.reason)).toEqual([expect.stringContaining("note")]);
		expect(apply(doc, result.changes)).toBe(`{++{"author":"A","note":{"x":1}}@@a++} {++b++}{author=B}`);
	});

	test("a range whose text contains @@ converts and reads back", () => {
		const doc = `{++{"author":"A"}@@a@@b++}`;
		expect(convert(doc)).toBe("{++a@@b++}{author=A}");
		expect(effective(convert(doc))).toEqual(effective(doc));
	});

	test("a range whose text starts with a JSON object then @@ stays legacy, since a block would not read back", () => {
		const doc = `{++{"author":"A"}@@{"x":1}@@b++} {++{"author":"B"}@@c++}`;
		const result = convert_metadata(parse(doc));
		expect(result.converted).toBe(1);
		expect(result.skipped.map(s => s.reason)).toEqual([expect.stringContaining("@@")]);
		expect(apply(doc, result.changes)).toBe(`{++{"author":"A"}@@{"x":1}@@b++} {++c++}{author=B}`);
		const converted = parse(apply(doc, result.changes));
		expect(converted.map(r => r.fields)).toEqual(parse(doc).map(r => r.fields));
	});

	test("an anchor keeps fields that differ from its first comment", () => {
		expect(convert(`{=={"author":"Z","time":1}@@x==}{>>{"author":"A","time":1}@@c<<}`))
			.toBe(`{==x==}{author=Z}{>>c<<}{author=A time=1}`);
	});
});

describe("lossless conversion (spec)", () => {
	test.each([
		...INKLING_SHAPED,
		`{=={"author":"A","time":1}@@x==}{>>{"author":"A","time":1,"note":{"x":1}}@@c<<}`, // reply stays legacy
		`{==x==}{>>{"author":"A","time":1}@@c<<}`, // anchor states nothing
		`{=={"done":true}@@x==}{>>{"author":"A","done":true}@@c<<}`, // done on a reply
		`{=={"author":"Z"}@@x==}{>>{"author":"A","time":1}@@c<<}`, // anchor differs
	])("preserves every range's effective fields: %s", (doc) => {
		// EXPL: Replies' `fields` already drop `done` (Task 4), so effective fields compare directly.
		expect(effective(convert(doc))).toEqual(effective(doc));
	});

	test("converting a note already in attribute blocks is a no-op", () => {
		for (const doc of INKLING_SHAPED) expect(convert_metadata(parse(convert(doc))).changes).toEqual([]);
	});
});

test("leaves the parsed ranges untouched", () => {
	const ranges = parse(INKLING_SHAPED[1]);
	const before = ranges.map(r => ({ ...r.own_fields }));
	expect(convert_metadata(ranges).converted).toBeGreaterThan(0);
	expect(ranges.map(r => r.own_fields)).toEqual(before);
});

describe("mixed threads", () => {
	// EXPL: The anchor's reply stays legacy (unconvertible), so the anchor must keep its own fields: it cannot inherit
	//       from a legacy comment it cannot be sure of.
	test("an anchor keeps its fields while its first comment stays legacy", () => {
		const stuck = `{=={"author":"A","time":1}@@x==}{>>{"author":"A","time":1,"note":{"x":1}}@@c<<}`;
		expect(convert(stuck)).toBe(`{==x==}{author=A time=1}{>>{"author":"A","time":1,"note":{"x":1}}@@c<<}`);
	});
});

describe("mixed notes", () => {
	test("only legacy ranges are converted", () => {
		expect(convert(`{++{"author":"A"}@@a++} {++b++}{author=B}`)).toBe(`{++a++}{author=A} {++b++}{author=B}`);
	});
});
