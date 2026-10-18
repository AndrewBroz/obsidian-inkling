import {
	parseAttrBlock,
	serializeAttrBlock,
	unconvertibleContent,
	unconvertibleReason,
} from "../src/editor/base/edit-util/attributes";

describe("parseAttrBlock", () => {
	test("reads a block at the given position and reports its span", () => {
		const text = `{==x==}{author="Andrew" time=1791819807}tail`;
		expect(parseAttrBlock(text, 7)).toEqual({
			from: 7,
			to: text.indexOf("tail"),
			fields: { author: "Andrew", time: 1791819807 },
		});
	});

	test("types bare values: canonical numbers and true/false", () => {
		expect(parseAttrBlock(`{done=true n=-2.5 z=007 f=false}`, 0)!.fields)
			.toEqual({ done: true, n: -2.5, z: "007", f: false });
	});

	test("quoted values are always strings", () => {
		expect(parseAttrBlock(`{time="12" done="true"}`, 0)!.fields).toEqual({ time: "12", done: "true" });
	});

	test("unescapes \\\" \\\\ \\{ \\}", () => {
		expect(parseAttrBlock(String.raw`{author="a\"b\\c\{d\}"}`, 0)!.fields).toEqual({ author: `a"b\\c{d}` });
	});

	test("normalises shorthand keys", () => {
		expect(parseAttrBlock(`{a=Bea t=5 d=true s=x c=ff0000}`, 0)!.fields)
			.toEqual({ author: "Bea", time: 5, done: true, style: "x", color: "ff0000" });
	});

	test.each([
		["empty braces", "{}"],
		["not at a brace", " {a=1}"],
		["no value", "{a}"],
		["empty bare value", "{a=}"],
		["unterminated", "{a=1"],
		["trailing space", "{a=1 }"],
		["leading space", "{ a=1}"],
		["tab separator", "{a=1\tb=2}"],
		["reserved class", "{.note a=1}"],
		["reserved id", "{#a1 a=1}"],
		["bad escape", String.raw`{a="\n"}`],
		["newline in quotes", "{a=\"x\ny\"}"],
		["unclosed quote", `{a="x}`],
		["criticmarkup opener", "{>>c<<}"],
		["bad key start", "{1a=2}"],
	])("rejects %s", (_name, text) => {
		expect(parseAttrBlock(text, 0)).toBeUndefined();
	});

	test("keys named like Object.prototype members are plain fields, not inherited", () => {
		expect(parseAttrBlock("{constructor=1}", 0)!.fields).toEqual({ constructor: 1 });
		expect(parseAttrBlock("{toString=x}", 0)!.fields).toEqual({ toString: "x" });
		expect(parseAttrBlock("{valueOf=1}", 0)!.fields).toEqual({ valueOf: 1 });
	});

	test("rejects a __proto__ key, which would be silently dropped", () => {
		expect(parseAttrBlock("{__proto__=1}", 0)).toBeUndefined();
	});

	test("accepts several spaces between attributes", () => {
		expect(parseAttrBlock("{x=1   y=2}", 0)!.fields).toEqual({ x: 1, y: 2 });
	});
});

describe("serializeAttrBlock", () => {
	test("writes bare when the value reads back unchanged, otherwise quoted", () => {
		expect(serializeAttrBlock({ author: "Andrew", time: 1791819807 })).toBe("{author=Andrew time=1791819807}");
		expect(serializeAttrBlock({ author: "Andrew Brož" })).toBe(`{author="Andrew Brož"}`);
		expect(serializeAttrBlock({ author: "7" })).toBe(`{author="7"}`);
		expect(serializeAttrBlock({ author: "true" })).toBe(`{author="true"}`);
		expect(serializeAttrBlock({ done: true })).toBe("{done=true}");
	});

	test("skips undefined values and writes nothing for no fields", () => {
		expect(serializeAttrBlock({ author: undefined, time: 3 })).toBe("{time=3}");
		expect(serializeAttrBlock({})).toBe("");
		expect(serializeAttrBlock({ author: undefined })).toBe("");
	});

	// EXPL: Review focus 2: hostile author names must survive a write and a read unchanged.
	test.each([
		"Andrew Brož",
		`Bea "B" O'Neil`,
		"braces {++x++} and }",
		"back\\slash",
		"@andrew",
		"a@b.com",
		"007",
		"-1",
		"1e+21",
		"true",
		"",
	])("round-trips %j", (author) => {
		const block = serializeAttrBlock({ author, time: 1 });
		expect(parseAttrBlock(block, 0)).toEqual({ from: 0, to: block.length, fields: { author, time: 1 } });
	});

	test("preserves field order", () => {
		const block = serializeAttrBlock({ time: 1, author: "x", done: true });
		expect(Object.keys(parseAttrBlock(block, 0)!.fields)).toEqual(["time", "author", "done"]);
	});
});

describe("unconvertibleReason", () => {
	test("accepts strings, finite numbers and booleans", () => {
		expect(unconvertibleReason({ author: "a", time: 1, done: false, author_note: "x" })).toBeUndefined();
	});

	test.each([
		[{ note: "a\nb" }, "line break"],
		[{ n: Infinity }, "finite"],
		[{ o: { x: 1 } }, "string, number or true/false"],
		[{ l: [1] }, "string, number or true/false"],
		[{ z: null }, "string, number or true/false"],
		[{ "bad key": "x" }, "field name"],
		[{ a: "Bea" }, "shorthand"],
		[{ c: "ff0000" }, "shorthand"],
		[JSON.parse("{\"__proto__\":\"x\"}"), "field name"],
	])("rejects %j", (fields, reason) => {
		expect(unconvertibleReason(fields as any)).toContain(reason);
	});
});

describe("unconvertibleContent", () => {
	test.each(["{++a++}", "{++a@@b++}", "{++@@b++}", "{++{bad}@@b++}", "{++[1]@@b++}", "{++null@@b++}"])(
		"accepts %j",
		(text) => expect(unconvertibleContent(text)).toBeUndefined(),
	);

	test.each([`{++{"x":1}@@b++}`, "{++{}@@b++}", `{~~{"x":1}@@a~>b~~}`])("rejects %j", (text) => {
		expect(unconvertibleContent(text)).toContain("@@");
	});
});
