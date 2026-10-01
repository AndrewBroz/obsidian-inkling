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
