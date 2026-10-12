import { App } from "obsidian";

import { DEFAULT_SETTINGS } from "../src/constants";
import { postProcess } from "../src/editor/renderers/post-process/renderer";

// EXPL: Reading view hands the post-processor Obsidian's rendered HTML, which has already turned
//       `==x==` into a highlight and `~~x~~` into a strikethrough. postProcess maps those back to
//       CriticMarkup before parsing. Obsidian 1.13 renders highlights as `<mark data-highlight="">`;
//       matching only a bare `<mark>` left `{==` unrestored, so the element parse found fewer ranges
//       than the source and the line fell into the cross-block fallback, which sliced raw HTML.
function render(html: string, source: string) {
	const el = document.createElement("div");
	el.innerHTML = html;
	(el as any).getHTML = function(this: HTMLElement) {
		return this.innerHTML;
	};
	(el as any).empty = function(this: HTMLElement) {
		this.replaceChildren();
	};
	const plugin: any = { app: Object.assign(new App(), { workspace: {} }), settings: { ...DEFAULT_SETTINGS } };
	const ctx: any = { docId: "doc", getSectionInfo: () => ({ text: source, lineStart: 0, lineEnd: 0 }) };
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
