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
		// EXPL: `off` means "plain editing, nothing enforced beyond syntax protection" — it maps to
		//       CORRECTED now that the unprotected EditMode.OFF is gone.
		expect(resolveFrontmatterMode({ commentator: "off" }, "")).toBe(
			EditMode.CORRECTED,
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
		).toBe(EditMode.CORRECTED);
	});

	test("the inkling key works the same as the legacy commentator key", () => {
		expect(resolveFrontmatterMode({ inkling: "suggest" }, "")).toBe(
			EditMode.SUGGEST,
		);
		expect(resolveFrontmatterMode({ inkling: "Comment" }, "")).toBe(
			EditMode.COMMENT,
		);
		expect(resolveFrontmatterMode({ inkling: "off" }, "")).toBe(
			EditMode.CORRECTED,
		);
	});

	test("inkling key takes precedence over a coexisting commentator key", () => {
		const fm = { inkling: "suggest", commentator: "comment" };
		expect(resolveFrontmatterMode(fm, "")).toBe(EditMode.SUGGEST);
	});

	test("inkling-authors exempts listed authors when inkling is the matched key", () => {
		const fm = {
			inkling: "suggest",
			"inkling-authors": ["Alice"],
			"commentator-authors": ["Bob"],
		};
		// EXPL: Alice is exempt via the matched (inkling) family
		expect(resolveFrontmatterMode(fm, "Alice")).toBeNull();
		// EXPL: Bob is only listed in the other (commentator) family, which is not
		//       consulted since the matched family already has an authors entry
		expect(resolveFrontmatterMode(fm, "Bob")).toBe(EditMode.SUGGEST);
	});

	test("authors lookup falls back to the other family when the matched family has no authors entry", () => {
		const fm = { inkling: "suggest", "commentator-authors": ["Bob"] };
		expect(resolveFrontmatterMode(fm, "Bob")).toBeNull();
		expect(resolveFrontmatterMode(fm, "Mallory")).toBe(EditMode.SUGGEST);
	});
});
