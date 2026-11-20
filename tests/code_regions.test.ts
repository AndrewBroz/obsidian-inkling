import { findCodeRegions, inCodeContent, inCodeRegion, sameRegions } from "../src/editor/base/edit-util/code-regions";

describe("findCodeRegions", () => {
	test("backtick fence", () => {
		expect(findCodeRegions("a\n```\nx\n```\nb")).toEqual([{
			from: 2,
			to: 11,
			head_end: 5,
			inner_from: 6,
			inner_to: 8,
		}]);
	});

	test("tilde fence and info string", () => {
		const t = "~~~js\nx\n~~~";
		expect(findCodeRegions(t)).toEqual([{ from: 0, to: t.length, head_end: 5, inner_from: 6, inner_to: 8 }]);
	});

	test("longer closer closes, shorter does not", () => {
		const t = "````\n```\n````";
		expect(findCodeRegions(t)).toEqual([{ from: 0, to: t.length, head_end: 4, inner_from: 5, inner_to: 9 }]);
	});

	test("different char does not close", () => {
		const t = "```\n~~~\n```";
		expect(findCodeRegions(t)).toEqual([{ from: 0, to: t.length, head_end: 3, inner_from: 4, inner_to: 8 }]);
	});

	test("4-space indent is not a fence", () => {
		expect(findCodeRegions("    ```\nx")).toEqual([]);
	});

	test("fence in blockquote/callout", () => {
		const t = "> [!note]\n> ```\n> {++x++}\n> ```";
		expect(findCodeRegions(t)).toEqual([{ from: 10, to: t.length, head_end: 15, inner_from: 16, inner_to: 26 }]);
	});

	test("unclosed fence runs to end", () => {
		const t = "a\n```\n{++x++}";
		expect(findCodeRegions(t)).toEqual([{ from: 2, to: t.length, head_end: 5, inner_from: 6, inner_to: t.length }]);
	});

	test.each(["++}", "--}", "==}", "~~}"])("closing fence may carry a CriticMarkup closer %s", (closer) => {
		const open = "{" + closer.slice(0, 2);
		const t = `${open}\`\`\`\nx\n\`\`\`${closer}\nafter`;
		const regions = findCodeRegions(t);
		expect(regions).toEqual([{ from: 3, to: t.indexOf("\nafter"), head_end: 6, inner_from: 7, inner_to: 9 }]);
		expect(inCodeRegion(regions, 0)).toBeUndefined();
	});

	test("text after a closing fence's CriticMarkup closer is outside the region", () => {
		const t = "{++```\nx\n```++} {--d--}";
		const regions = findCodeRegions(t);
		expect(regions).toEqual([{ from: 3, to: t.indexOf(" {--"), head_end: 6, inner_from: 7, inner_to: 9 }]);
		expect(inCodeRegion(regions, t.indexOf("{--"))).toBeUndefined();
	});

	test("range prefix after a quote marker stays outside the region", () => {
		const t = "> {++```\n> x\n> ```++}";
		const regions = findCodeRegions(t);
		expect(regions).toEqual([{ from: 5, to: t.length, head_end: 8, inner_from: 9, inner_to: 13 }]);
		expect(inCodeRegion(regions, 2)).toBeUndefined();
	});

	test.each(["{++", "{--", "{~~", "{==", "{>>"])("closing fence may carry a trailing range opener %s", (opener) => {
		const t = `\`\`\`\nx\n\`\`\`${opener}\nmore`;
		const regions = findCodeRegions(t);
		expect(regions).toEqual([{ from: 0, to: 9, head_end: 3, inner_from: 4, inner_to: 6 }]);
		expect(inCodeRegion(regions, 9)).toBeUndefined();
	});

	test("Enter at the end of a closing fence in suggest mode leaves the fence closed", () => {
		const t = "```\nx\n```{++\n++}\nafter {++y++}";
		expect(findCodeRegions(t)).toEqual([{ from: 0, to: 9, head_end: 3, inner_from: 4, inner_to: 6 }]);
	});

	test("head_end excludes a carriage return", () => {
		expect(findCodeRegions("```js\r\nx\r\n```")[0]).toMatchObject({ head_end: 5, inner_from: 7, inner_to: 10 });
	});

	test("unclosed fence on the last line has empty content at the end", () => {
		const t = "a\n```";
		expect(findCodeRegions(t)).toEqual([{ from: 2, to: 5, head_end: 5, inner_from: 5, inner_to: 5 }]);
	});

	test("inline code is not a region", () => {
		expect(findCodeRegions("`{++x++}`")).toEqual([]);
	});

	test("backtick fence info string may not contain a backtick", () => {
		expect(findCodeRegions("``` a`b\nx")).toEqual([]);
	});
});

describe("inCodeRegion", () => {
	const regions = [{ from: 2, to: 11, head_end: 5, inner_from: 6, inner_to: 8 }, {
		from: 20,
		to: 30,
		head_end: 23,
		inner_from: 24,
		inner_to: 27,
	}];
	test("boundaries", () => {
		expect(inCodeRegion(regions, 2)).toBe(regions[0]);
		expect(inCodeRegion(regions, 10)).toBe(regions[0]);
		expect(inCodeRegion(regions, 11)).toBeUndefined();
		expect(inCodeRegion(regions, 1)).toBeUndefined();
		expect(inCodeRegion(regions, 25)).toBe(regions[1]);
		expect(inCodeRegion([], 0)).toBeUndefined();
	});
});

describe("inCodeContent", () => {
	// "a\n```\nxy\n```\nb": region 2..12; content runs from 6 (after the opening line) to 9 (the closing line)
	const regions = findCodeRegions("a\n```\nxy\n```\nb");
	test("inside content", () => {
		expect(inCodeContent(regions, 6, 6)).toBe(true);
		expect(inCodeContent(regions, 6, 9)).toBe(true);
		expect(inCodeContent(regions, 9, 9)).toBe(true);
	});
	test("an insertion at the end of the opening fence line is content; a deletion there is not", () => {
		expect(inCodeContent(regions, 5, 5)).toBe(true);
		expect(inCodeContent(regions, 4, 4)).toBe(false);
		expect(inCodeContent(regions, 5, 6)).toBe(false);
		expect(inCodeContent(regions, 4, 5)).toBe(false);
	});
	test("touching a fence line is not content", () => {
		expect(inCodeContent(regions, 2, 2)).toBe(false);
		expect(inCodeContent(regions, 5, 6)).toBe(false);
		expect(inCodeContent(regions, 8, 10)).toBe(false);
		expect(inCodeContent(regions, 12, 12)).toBe(false);
		expect(inCodeContent(regions, 2, 12)).toBe(false);
		expect(inCodeContent([], 0, 0)).toBe(false);
	});
});

describe("sameRegions", () => {
	const r = (from: number, to: number, inner_from = from, inner_to = to, head_end = inner_from) => ({
		from,
		to,
		head_end,
		inner_from,
		inner_to,
	});
	test("compares by value", () => {
		expect(sameRegions([r(1, 2)], [r(1, 2)])).toBe(true);
		expect(sameRegions([r(1, 2)], [r(1, 3)])).toBe(false);
		expect(sameRegions([r(1, 5, 2, 4)], [r(1, 5, 2, 3)])).toBe(false);
		expect(sameRegions([r(1, 5, 2, 4)], [r(1, 5, 3, 4)])).toBe(false);
		expect(sameRegions([r(1, 5, 3, 4, 2)], [r(1, 5, 3, 4, 1)])).toBe(false);
		expect(sameRegions([], [r(1, 3)])).toBe(false);
	});
});
