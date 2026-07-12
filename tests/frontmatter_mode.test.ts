import { resolveFrontmatterMode } from "../src/editor/uix/frontmatter-mode";
import { EditMode } from "../src/types";

describe("resolveFrontmatterMode", () => {
	test("maps the three mode strings, case-insensitively", () => {
		expect(resolveFrontmatterMode({ commentator: "suggest" }, "")).toBe(
			EditMode.SUGGEST,
		);
		expect(resolveFrontmatterMode({ commentator: "Comment" }, "")).toBe(
			EditMode.COMMENT,
		);
		expect(resolveFrontmatterMode({ commentator: "off" }, "")).toBe(
			EditMode.OFF,
		);
	});

	test("absent or invalid values yield null (no enforcement)", () => {
		expect(resolveFrontmatterMode(undefined, "")).toBeNull();
		expect(resolveFrontmatterMode({}, "")).toBeNull();
		expect(resolveFrontmatterMode({ commentator: "banana" }, "")).toBeNull();
		expect(resolveFrontmatterMode({ commentator: 3 }, "")).toBeNull();
	});

	test("authors list exempts listed authors, enforces for others", () => {
		const fm = {
			"commentator": "suggest",
			"commentator-authors": ["Alice", "Bob"],
		};
		expect(resolveFrontmatterMode(fm, "Alice")).toBeNull();
		expect(resolveFrontmatterMode(fm, "Mallory")).toBe(EditMode.SUGGEST);
	});

	test("empty local author is never exempted by an authors list", () => {
		const fm = { "commentator": "comment", "commentator-authors": ["Alice"] };
		expect(resolveFrontmatterMode(fm, "")).toBe(EditMode.COMMENT);
	});

	test("malformed authors list is ignored (mode still enforced)", () => {
		expect(
			resolveFrontmatterMode({
				"commentator": "off",
				"commentator-authors": "Alice",
			}, "Alice"),
		).toBe(EditMode.OFF);
	});
});
