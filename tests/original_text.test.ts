import { hasCriticMarkup, toOriginalText } from "../src/api/original-text";

describe("toOriginalText", () => {
	test("removes additions", () => {
		expect(toOriginalText("The {++very ++}cat")).toBe("The cat");
	});

	test("keeps deleted text", () => {
		expect(toOriginalText("Hello {--old --}world")).toBe("Hello old world");
	});

	test("keeps the original side of a substitution", () => {
		expect(toOriginalText("The {~~cat~>dog~~} sat.")).toBe("The cat sat.");
	});

	test("unwraps highlights and removes their comments", () => {
		expect(toOriginalText("The {==cat==}{>>check<<} sat.")).toBe("The cat sat.");
	});

	test("removes whole reply threads", () => {
		expect(toOriginalText("Text {==here==}{>>one<<}{>>two<<} end")).toBe("Text here end");
		expect(toOriginalText("Text{>>one<<}{>>two<<} end")).toBe("Text end");
	});

	test("never leaks metadata", () => {
		expect(toOriginalText(`x {++{"author":"A","time":1}@@added ++}y`)).toBe("x y");
		expect(toOriginalText(`{--{"a":"B"}@@gone--} here`)).toBe("gone here");
		expect(toOriginalText(`{~~{"author":"A"}@@old~>new~~}`)).toBe("old");
	});

	test("drops a comment at the end of a line without a trailing space", () => {
		expect(toOriginalText("Done. {>>c<<}")).toBe("Done.");
	});

	test("drops a comment at the start of a line without a leading space", () => {
		expect(toOriginalText("{>>c<<} Start here")).toBe("Start here");
	});

	test("keeps indentation and list markers", () => {
		expect(toOriginalText("- {>>c<<} item")).toBe("- item");
		expect(toOriginalText("  {>>c<<} indented")).toBe("  indented");
	});

	test("drops a line emptied by a removal and collapses the blank lines around it", () => {
		expect(toOriginalText("Para one.\n\n{>>note<<}\n\nPara two.")).toBe("Para one.\n\nPara two.");
		expect(toOriginalText("Para one.\n\n{++New paragraph.++}\n\nPara two.")).toBe("Para one.\n\nPara two.");
	});

	test("drops a line left with only a block prefix", () => {
		expect(toOriginalText("- {++Buy milk++}")).toBe("");
		expect(toOriginalText("## {++New heading++}")).toBe("");
		expect(toOriginalText("- [ ] {++task++}")).toBe("");
		expect(toOriginalText("> {>>c<<}")).toBe("");
		expect(toOriginalText("a\n- {++x++}\n- keep")).toBe("a\n- keep");
		expect(toOriginalText("- keep {++x++}")).toBe("- keep");
	});

	test("drops a trailing space before CRLF line endings", () => {
		expect(toOriginalText("Done. {>>c<<}\r\nNext")).toBe("Done.\r\nNext");
	});

	test("drops the blank lines after emptied lines at the very start", () => {
		expect(toOriginalText("{>>c<<}\n\nPara")).toBe("Para");
		expect(toOriginalText("{++A\n\nB++}\n\nC")).toBe("C");
	});

	test("keeps blank lines that no removal touched", () => {
		expect(toOriginalText("A\n\n\nB {++x++}")).toBe("A\n\n\nB");
	});

	test("returns text without markup unchanged", () => {
		const text = "# Title\n\nPlain paragraph with {braces} and ~tildes~.\n";
		expect(toOriginalText(text)).toBe(text);
	});

	test("handles markup that spans lines", () => {
		// EXPL: if the grammar does not parse a multi-line comment as one range, the text is returned unchanged;
		//       the snapshot pins whichever behaviour the parser has.
		expect(toOriginalText("A\n\n{>>line one\nline two<<}\n\nB")).toMatchInlineSnapshot(`
"A

B"
`);
	});

	test("leaves an opener without a closer as written", () => {
		expect(toOriginalText("{--open never closed\n\nmore")).toBe("{--open never closed\n\nmore");
		expect(toOriginalText("{==open")).toBe("{==open");
		expect(toOriginalText("{~~open~>never")).toBe("{~~open~>never");
		expect(toOriginalText("{>>open")).toBe("{>>open");
		expect(toOriginalText("{++open never closed")).toBe("{++open never closed");
		expect(toOriginalText("{++x--}")).toBe("{++x--}");
		expect(toOriginalText("{++")).toBe("{++");
		expect(toOriginalText("{++}")).toBe("{++}");
	});

	test("still processes closed markup after an unclosed opener", () => {
		expect(toOriginalText("Keep {++this\n\nand the rest {--gone--}")).toBe("Keep {++this\n\nand the rest gone");
		expect(toOriginalText("{++a {~~b~>c~~} d")).toBe("{++a b d");
		expect(toOriginalText("Text {==here==}{>>one<<}{>>open")).toBe("Text here{>>open");
		expect(toOriginalText("{++a++} {--b")).toBe("{--b");
	});

	test("ends a substitution with a repeated `~>` at its closer", () => {
		expect(toOriginalText("a {~~x~>y~>z~~} b")).toBe("a x b");
		expect(toOriginalText("a {~~x~>y~>z~~} b {++c++} d")).toBe("a x b d");
		expect(toOriginalText("a {~~x~>y~>z~~}{>>why<<} b")).toBe("a x b");
		expect(toOriginalText(`{~~{"author":"A"}@@x~>y~>z~~}`)).toBe("x");
		// EXPL: without a closer it is an unclosed opener, and the markup after it still counts.
		expect(toOriginalText("x {~~a~>b~>c {--d--}")).toBe("x {~~a~>b~>c d");
	});

	test("never leaks metadata when the content repeats `@@`", () => {
		expect(toOriginalText(`x {++{"author":"A"}@@a@@b++} y`)).toBe("x y");
		expect(toOriginalText(`{--{"author":"A"}@@a@@b--} here`)).toBe("a@@b here");
	});

	test("pins behaviour for markup inside inline code", () => {
		expect(toOriginalText("Use `{++x++}` literally")).toMatchInlineSnapshot(`"Use \`\` literally"`);
	});
});

describe("hasCriticMarkup", () => {
	test("detects markup", () => {
		expect(hasCriticMarkup("a {++b++}")).toBe(true);
		expect(hasCriticMarkup("plain {text}")).toBe(false);
	});
});
