import { DEFAULT_SETTINGS } from "../src/constants";
import { generate_metadata } from "../src/editor/base/edit-util/metadata";

describe("attribution defaults (Phase 3a)", () => {
	test("metadata parsing and writing are on by default", () => {
		expect(DEFAULT_SETTINGS.enable_metadata).toBe(true);
		expect(DEFAULT_SETTINGS.enable_author_metadata).toBe(true);
		expect(DEFAULT_SETTINGS.enable_timestamp_metadata).toBe(true);
		expect(DEFAULT_SETTINGS.add_metadata).toBe(true);
		expect(DEFAULT_SETTINGS.add_author_metadata).toBe(true);
		expect(DEFAULT_SETTINGS.add_timestamp_metadata).toBe(true);
	});

	test("generate_metadata produces author and timestamp under defaults", () => {
		const metadata = generate_metadata({
			...DEFAULT_SETTINGS,
			author: "Test Author",
		});
		expect(metadata).toBeDefined();
		expect(metadata!.author).toBe("Test Author");
		expect(typeof metadata!.time).toBe("number");
	});

	test("generate_metadata omits author when name is unset", () => {
		const metadata = generate_metadata({ ...DEFAULT_SETTINGS, author: "" });
		expect(metadata).toBeDefined();
		expect(metadata!.author).toBeUndefined();
		expect(typeof metadata!.time).toBe("number");
	});
});
