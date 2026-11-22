import { App } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { postProcess } from "../src/editor/renderers/post-process/renderer";

// EXPL: Reading view hands the post-processor Obsidian's rendered HTML, which has already turned
//       `==x==` into a highlight and `~~x~~` into a strikethrough. postProcess maps those back to
//       CriticMarkup before parsing. Obsidian 1.13 renders highlights as `<mark data-highlight="">`;
//       matching only a bare `<mark>` left `{==` unrestored, so the element parse found fewer ranges
//       than the source and the line fell into the cross-block fallback, which sliced raw HTML.
function render(html: string, source: string | null) {
	const el = document.createElement("div");
	el.innerHTML = html;
	(el as any).getHTML = function(this: HTMLElement) {
		return this.innerHTML;
	};
	(el as any).empty = function(this: HTMLElement) {
		this.replaceChildren();
	};
	const plugin: any = { app: Object.assign(new App(), { workspace: { getActiveViewOfType: () => null } }), settings: { ...DEFAULT_SETTINGS } };
	const ctx: any = source === null ? null : {
		docId: "doc",
		getSectionInfo: () => ({ text: source, lineStart: 0, lineEnd: source.split("\n").length - 1 }),
	};
	return postProcess(el, ctx, plugin).then(() => el);
}

const META = `{"author":"Andrew","time":1791819807}@@`;
const SOURCE = `This is {==${META}some==}{>>${META}This is a comment on the text<<} text`;
const rendered = (mark: string) =>
	`<p dir="auto">This is {${mark}${META}some</mark>}{&gt;&gt;${META}This is a comment on the text&lt;&lt;} text</p>`;

describe("reading view post-processing of Obsidian's highlight markup", () => {
	test.each([
		["bare <mark>", "<mark>"],
		["Obsidian 1.13 <mark data-highlight>", `<mark data-highlight="">`],
	])("highlight + comment renders cleanly with %s", async (_name, mark) => {
		const el = await render(rendered(mark), SOURCE);
		expect(el.textContent).toBe("This is some text");
		expect(el.querySelector(".cmtr-highlight")?.textContent).toBe("some");
		expect(el.querySelector(".cmtr-comment-icon")).not.toBeNull();
		expect(el.innerHTML).not.toContain("<mark");
	});

	test("strikethrough markup with attributes is restored like a bare <del>", async () => {
		// EXPL: `{~~old~>new~~}` is a substitution; Obsidian renders its `~~...~~` as a strikethrough.
		const source = `a {~~old~>new~~} b {>>note<<} c`;
		const html = (del: string) => `<p dir="auto">a {${del}old~&gt;new</del>} b {&gt;&gt;note&lt;&lt;} c</p>`;
		const bare = await render(html("<del>"), source);
		const attributed = await render(html(`<del data-x="">`), source);
		expect(attributed.innerHTML).toBe(bare.innerHTML);
		expect(attributed.innerHTML).not.toContain("<del");
		expect(attributed.querySelector(".cmtr-comment-icon")).not.toBeNull();
	});
});

describe("trailing attribute blocks in reading view", () => {
	const ATTR_SOURCE = `This is {==some==}{>>This is a comment on the text<<}{author="Andrew B" time=1791819807} text`;
	const attrRendered = (mark: string) =>
		`<p dir="auto">This is {${mark}some</mark>}{&gt;&gt;This is a comment on the text&lt;&lt;}{author="Andrew B" time=1791819807} text</p>`;

	test.each([
		["bare <mark>", "<mark>"],
		["Obsidian 1.13 <mark data-highlight>", `<mark data-highlight="">`],
	])("highlight + comment + block renders cleanly with %s", async (_name, mark) => {
		const el = await render(attrRendered(mark), ATTR_SOURCE);
		expect(el.textContent).toBe("This is some text");
		expect(el.querySelector(".cmtr-highlight")?.textContent).toBe("some");
		expect(el.querySelector(".cmtr-comment-icon")).not.toBeNull();
		expect(el.innerHTML).not.toContain("author=");
	});

	test("a suggestion's block is not rendered", async () => {
		const source = `a {++b++}{author=A} c`;
		const el = await render(`<p dir="auto">a {++b++}{author=A} c</p>`, source);
		expect(el.innerHTML).not.toContain("author=");
		expect(el.querySelector(".cmtr-addition")?.textContent).toBe("b");
	});
});

describe("code blocks inside a rendered section", () => {
	test("markup in a fenced block nested in a callout is not decorated; a real range beside it is", async () => {
		const source = "> [!note]\n> ```\n> {++code++}\n> ```\n> {==h==}";
		const html = `<div class="callout"><div class="callout-title">note</div><div class="callout-content">` +
			`<pre><code>{++code++}\n</code></pre><p dir="auto">{<mark>h</mark>}</p></div></div>`;
		const el = await render(html, source);
		expect(el.querySelector(".cmtr-highlight")?.textContent).toBe("h");
		expect(el.querySelector(".cmtr-addition")).toBeNull();
		expect(el.querySelector("pre code")?.textContent).toBe("{++code++}\n");
	});

	test("the text \"<pre>…</pre>\" in a paragraph does not hide a range inside it", async () => {
		const el = await render(`<p dir="auto">use &lt;pre&gt; {++x++} &lt;/pre&gt;</p>`, null);
		expect(el.querySelector(".cmtr-addition")?.textContent).toBe("x");
	});

	test("a strikethrough before a code block does not shift which ranges are inside it", async () => {
		const html = `<p dir="auto">a {<del>old</del>} b</p><pre><code>{++code++}\n</code></pre><p dir="auto">{++x++}</p>`;
		const el = await render(html, null);
		expect(Array.from(el.querySelectorAll(".cmtr-addition"), e => e.textContent)).toEqual(["x"]);
		expect(el.querySelector("pre code")?.textContent).toBe("{++code++}\n");
	});

	test("a closer inside a code block does not close a range opened before it (review M2)", async () => {
		const html = `<p dir="auto">intro {++x</p><pre><code>a ++} b\n</code></pre><p dir="auto">done</p>`;
		const el = await render(html, null);
		expect(el.querySelector(".cmtr-addition")).toBeNull();
		expect(el.querySelector("pre code")?.textContent).toBe("a ++} b\n");
	});

	test("a wrapper without context holding a code block is left untouched", async () => {
		const html = `<pre><code>{++x++} {==y==}\n</code></pre>`;
		const el = await render(html, null);
		expect(el.innerHTML).toBe(html);
	});
});

describe("reading view reads fences as plain CommonMark, like the editor", () => {
	function section(html: string, source: string, lineStart: number, lineEnd: number) {
		const el = document.createElement("div");
		el.innerHTML = html;
		(el as any).getHTML = function(this: HTMLElement) {
			return this.innerHTML;
		};
		(el as any).empty = function(this: HTMLElement) {
			this.replaceChildren();
		};
		const plugin: any = { app: Object.assign(new App(), { workspace: { getActiveViewOfType: () => null } }), settings: { ...DEFAULT_SETTINGS } };
		const ctx: any = {
			docId: "doc",
			sourcePath: "note.md",
			getSectionInfo: () => ({ text: source, lineStart, lineEnd }),
		};
		return postProcess(el, ctx, plugin).then(() => el);
	}

	test("a block showing a deleted fence stays one code block, and the text after it is markup", async () => {
		const source = "```markdown\n{--```--}\n```\nafter {++y++}";
		const block = await section("<pre><code>{--```--}\n</code></pre>", source, 0, 2);
		expect(block.querySelector("code")!.textContent).toBe("{--```--}\n");
		expect(block.querySelector(".cmtr-deletion")).toBeNull();
		const after = await section(`<p dir="auto">after {++y++}</p>`, source, 3, 3);
		expect(after.querySelector(".cmtr-addition")?.textContent).toBe("y");
	});

	test("a whole block inside a suggested addition renders as part of the addition", async () => {
		const source = "intro{++\n```js\ncode\n```\n++}\nrest";
		const block = await section("<pre><code>code\n</code></pre>", source, 1, 3);
		expect(block.querySelector(".cmtr-addition pre code")?.textContent).toBe("code\n");
	});
});
