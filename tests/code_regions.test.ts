import { findCodeRegions, inCodeRegion, sameRegions } from "../src/editor/base/edit-util/code-regions";

describe("findCodeRegions", () => {
	test("backtick fence", () => {
		expect(findCodeRegions("a\n```\nx\n```\nb")).toEqual([{ from: 2, to: 11 }]);
	});

	test("tilde fence and info string", () => {
		const t = "~~~js\nx\n~~~";
		expect(findCodeRegions(t)).toEqual([{ from: 0, to: t.length }]);
	});

	test("longer closer closes, shorter does not", () => {
		const t = "````\n```\n````";
		expect(findCodeRegions(t)).toEqual([{ from: 0, to: t.length }]);
	});

	test("different char does not close", () => {
		const t = "```\n~~~\n```";
		expect(findCodeRegions(t)).toEqual([{ from: 0, to: t.length }]);
	});

	test("4-space indent is not a fence", () => {
		expect(findCodeRegions("    ```\nx")).toEqual([]);
	});

	test("fence in blockquote/callout", () => {
		const t = "> [!note]\n> ```\n> {++x++}\n> ```";
		expect(findCodeRegions(t)).toEqual([{ from: 10, to: t.length }]);
	});

	test("unclosed fence runs to end", () => {
		const t = "a\n```\n{++x++}";
		expect(findCodeRegions(t)).toEqual([{ from: 2, to: t.length }]);
	});

	test.each(["++}", "--}", "==}", "~~}"])("closing fence may carry a CriticMarkup closer %s", (closer) => {
		const open = "{" + closer.slice(0, 2);
		const t = `${open}\`\`\`\nx\n\`\`\`${closer}\nafter`;
		const regions = findCodeRegions(t);
		expect(regions).toEqual([{ from: 3, to: t.indexOf("\nafter") }]);
		expect(inCodeRegion(regions, 0)).toBeUndefined();
	});

	test("text after a closing fence's CriticMarkup closer is outside the region", () => {
		const t = "{++```\nx\n```++} {--d--}";
		const regions = findCodeRegions(t);
		expect(regions).toEqual([{ from: 3, to: t.indexOf(" {--") }]);
		expect(inCodeRegion(regions, t.indexOf("{--"))).toBeUndefined();
	});

	test("range prefix after a quote marker stays outside the region", () => {
		const t = "> {++```\n> x\n> ```++}";
		const regions = findCodeRegions(t);
		expect(regions).toEqual([{ from: 5, to: t.length }]);
		expect(inCodeRegion(regions, 2)).toBeUndefined();
	});

	test("inline code is not a region", () => {
		expect(findCodeRegions("`{++x++}`")).toEqual([]);
	});

	test("backtick fence info string may not contain a backtick", () => {
		expect(findCodeRegions("``` a`b\nx")).toEqual([]);
	});
});

describe("inCodeRegion", () => {
	const regions = [{ from: 2, to: 11 }, { from: 20, to: 30 }];
	test("boundaries", () => {
		expect(inCodeRegion(regions, 2)).toBe(regions[0]);
		expect(inCodeRegion(regions, 10)).toBe(regions[0]);
		expect(inCodeRegion(regions, 11)).toBeUndefined();
		expect(inCodeRegion(regions, 1)).toBeUndefined();
		expect(inCodeRegion(regions, 25)).toBe(regions[1]);
		expect(inCodeRegion([], 0)).toBeUndefined();
	});
});

describe("sameRegions", () => {
	test("compares by value", () => {
		expect(sameRegions([{ from: 1, to: 2 }], [{ from: 1, to: 2 }])).toBe(true);
		expect(sameRegions([{ from: 1, to: 2 }], [{ from: 1, to: 3 }])).toBe(false);
		expect(sameRegions([], [{ from: 1, to: 3 }])).toBe(false);
	});
});
