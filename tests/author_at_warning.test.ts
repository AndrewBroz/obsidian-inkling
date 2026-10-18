import { author_at_warning } from "../src/editor/base/edit-util/attributes";

describe("author_at_warning (spec: @ inside a value)", () => {
	test.each(["@andrew", "Bea (@bea)", "x @y"])("warns for %j", (author) => {
		expect(author_at_warning(author)).toContain("citation");
	});
	test.each(["Andrew", "a@b.com", "", undefined])("is quiet for %j", (author) => {
		expect(author_at_warning(author)).toBeUndefined();
	});
});
