import { embedSlice } from "../src/editor/renderers/embed/embed-slice";

const h = (level: number, offset: number) => ({ level, position: { start: { line: 0, offset } } });
const li = (line: number, parent: number, end: number) => ({
	parent,
	position: { start: { line, offset: 0 }, end: { line, offset: end } },
});

describe("embedSlice", () => {
	test("whole note without frontmatter", () => {
		expect(embedSlice("Body", { kind: "note", frontmatter_end: null })).toBe("Body");
	});

	test("whole note skips frontmatter and the newline after it", () => {
		const text = "---\na: 1\n---\nBody";
		expect(embedSlice(text, { kind: "note", frontmatter_end: 12 })).toBe("Body");
	});

	test("heading section ends at the next heading of equal or higher level", () => {
		const text = "# A\nx\n## B\ny\n### C\nz\n## D\nw";
		const headings = [h(1, 0), h(2, 6), h(3, 13), h(2, 21)];
		expect(embedSlice(text, { kind: "heading", headings, index: 1 })).toBe("## B\ny\n### C\nz\n");
	});

	test("last heading section runs to the end", () => {
		const text = "# A\nx\n## D\nw";
		expect(embedSlice(text, { kind: "heading", headings: [h(1, 0), h(2, 6)], index: 1 })).toBe("## D\nw");
	});

	test("block slice", () => {
		expect(embedSlice("aa\nPara ^p\nbb", { kind: "block", start: 3, end: 10 })).toBe("Para ^p");
	});

	test("list-item block includes its children", () => {
		const text = "- Alpha\n- Main ^m\n  - Child\n- Omega";
		const items = [li(0, -1, 7), li(1, -1, 17), li(2, 1, 27), li(3, -1, 35)];
		expect(embedSlice(text, { kind: "block", start: 8, end: 17, list_items: items, list_line: 1 }))
			.toBe("- Main ^m\n  - Child");
	});
});
