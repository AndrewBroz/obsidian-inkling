import { rangeParser } from "../src/editor/base";
import { createRangeState } from "./helpers";

// EXPL: DEFAULT_SETTINGS.enable_metadata is false; enabling it is required for the parser
// to recognize and construct metadata fields in ranges. Without it, metadata blocks are ignored.
function parseFirstRange(doc: string) {
	const state = createRangeState(doc, { enable_metadata: true });
	return state.field(rangeParser).ranges.ranges[0];
}

describe("delete_metadata", () => {
	test("deleting the only key removes the whole metadata block", () => {
		const range = parseFirstRange(`x{~~{"author":"A"}@@a~>b~~}y`);
		expect(range.fields.author).toBe("A");

		const changes = range.delete_metadata("author");
		// EXPL: metadata block spans from after "{~~" to after "@@"
		expect(changes).toEqual([{ from: range.meta!.from, to: range.meta!.to, insert: "" }]);
	});

	test("deleting one of several keys rewrites the remaining metadata", () => {
		const range = parseFirstRange(`x{~~{"author":"A","time":1}@@a~>b~~}y`);

		const changes = range.delete_metadata("time");
		expect(changes).toEqual([{ from: range.meta!.from, to: range.meta!.to, insert: `{"author":"A"}@@` }]);
	});

	test("deleting an absent key is a no-op", () => {
		const range = parseFirstRange(`x{~~{"author":"A"}@@a~>b~~}y`);
		expect(range.delete_metadata("color")).toEqual([]);
	});
});

describe("set_metadata by syntax", () => {
	const apply = (doc: string, changes: { from: number; to: number; insert: string }[]) =>
		[...changes].sort((a, b) => b.from - a.from)
			.reduce((out, c) => out.slice(0, c.from) + c.insert + out.slice(c.to), doc);

	test("attributes range rewrites its block in place", () => {
		const doc = `x{++a++}{author=A}y`;
		const range = parseFirstRange(doc);
		expect(apply(doc, range.add_metadata("done", true))).toBe(`x{++a++}{author=A done=true}y`);
	});

	test("a range without metadata gets a block after its closer when asked", () => {
		const doc = `x{~~a~>b~~}y`;
		const range = parseFirstRange(doc);
		expect(apply(doc, range.set_metadata({ author: "A" }, "attributes"))).toBe(`x{~~a~>b~~}{author=A}y`);
	});

	test("touch-to-migrate: a legacy range rewritten as attributes loses its JSON", () => {
		const doc = `x{++{"author":"A"}@@a++}y`;
		const range = parseFirstRange(doc);
		expect(apply(doc, range.add_metadata("done", true, "attributes"))).toBe(`x{++a++}{author=A done=true}y`);
	});

	test("an attributes range never silently reverts to legacy", () => {
		const doc = `x{++a++}{author=A}y`;
		const range = parseFirstRange(doc);
		expect(apply(doc, range.add_metadata("done", true))).toBe(`x{++a++}{author=A done=true}y`);
	});

	test("deleting the last attribute removes the block", () => {
		const doc = `x{++a++}{author=A}y`;
		const range = parseFirstRange(doc);
		expect(apply(doc, range.delete_metadata("author"))).toBe(`x{++a++}y`);
	});

	test("migrates a legacy substitution to attributes", () => {
		const doc = `x{~~{"author":"A"}@@a~>b~~}y`;
		const range = parseFirstRange(doc);
		expect(apply(doc, range.add_metadata("done", true, "attributes"))).toBe(`x{~~a~>b~~}{author=A done=true}y`);
	});

	test("explicit legacy converts an attributes range back", () => {
		const doc = `x{++a++}{author=A}y`;
		const range = parseFirstRange(doc);
		expect(apply(doc, range.set_metadata({ author: "A" }, "legacy"))).toBe(`x{++{"author":"A"}@@a++}y`);
	});

	test("fields that cannot round-trip keep a legacy range legacy", () => {
		const doc = `{++{"note":{"x":1}}@@a++}`;
		const range = parseFirstRange(doc);
		expect(apply(doc, range.add_metadata("done", true, "attributes"))).toBe(
			`{++{"note":{"x":1},"done":true}@@a++}`,
		);
	});

	test("split_range puts the block after each half", () => {
		const range = parseFirstRange(`{++ab++}{author=A}`);
		expect(range.split_range(4)).toEqual([`++}{author=A}`, `{++`]);
	});
});
