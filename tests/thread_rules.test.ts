import { DEFAULT_SETTINGS } from "../src/constants";
import { rangeParser } from "../src/editor/base";
import { thread_resolved } from "../src/editor/base/edit-logic/resolve";
import { getRangesInText } from "../src/editor/base/edit-util/range-parser";
import { createRangeState } from "./helpers";

const parse = (doc: string) => getRangesInText(doc, { ...DEFAULT_SETTINGS, enable_metadata: true });

describe("a highlight anchor inherits authorship from its first comment", () => {
	test("attributes: an anchor with no block takes author and time", () => {
		const [anchor, comment] = parse(`{==some==}{>>note<<}{author=Andrew time=1}`);
		expect(anchor.own_fields).toEqual({});
		expect(anchor.fields).toEqual({ author: "Andrew", time: 1 });
		expect(comment.fields).toEqual({ author: "Andrew", time: 1 });
	});

	test("stated fields win, and only author/time inherit", () => {
		const [anchor] = parse(`{==x==}{author=Bea done=true}{>>c<<}{author=A time=1 style=s}`);
		expect(anchor.fields).toEqual({ time: 1, author: "Bea", done: true });
	});

	test("legacy: an anchor that states nothing now shows its first comment's author (spec compatibility note)", () => {
		const [anchor] = parse(`{==x==}{>>{"author":"A","time":1}@@c<<}`);
		expect(anchor.fields).toEqual({ author: "A", time: 1 });
	});

	test("mixed: a legacy anchor inherits from an attributes comment", () => {
		const [anchor] = parse(`{=={"done":true}@@x==}{>>c<<}{author=A}`);
		expect(anchor.fields).toEqual({ author: "A", done: true });
	});

	test("only the first comment counts, and replies never inherit", () => {
		const [anchor, first, reply] = parse(`{==x==}{>>c<<}{author=A}{>>r<<}`);
		expect(anchor.fields.author).toBe("A");
		expect(reply.fields).toEqual({});
		expect(first.fields).toEqual({ author: "A" });
	});

	test("suggestion anchors and lone highlights do not inherit", () => {
		expect(parse(`{++x++}{>>c<<}{author=A}`)[0].fields).toEqual({});
		expect(parse(`{==x==}`)[0].fields).toEqual({});
	});

	test("inheritance follows incremental thread reconstruction", () => {
		let state = createRangeState(`{==x==}{>>c<<}{author=A}`);
		// EXPL: Position 10 is just before `c`, inside the comment's content.
		state = state.update({ changes: { from: 10, insert: "z" } }).state;
		const [anchor] = state.field(rangeParser).ranges.ranges;
		expect(anchor.fields.author).toBe("A");
	});
});

describe("thread state lives on the base", () => {
	test("done on a reply is ignored", () => {
		const [anchor, , reply] = parse(`{==x==}{>>c<<}{author=A}{>>r<<}{author=B done=true}`);
		expect(reply.own_fields.done).toBe(true);
		expect(reply.fields.done).toBeUndefined();
		expect(thread_resolved(anchor)).toBe(false);
	});

	test("done on an unanchored thread's first comment is kept", () => {
		const [base] = parse(`{>>c<<}{done=true}{>>r<<}`);
		expect(base.fields.done).toBe(true);
		expect(thread_resolved(base)).toBe(true);
	});
});
