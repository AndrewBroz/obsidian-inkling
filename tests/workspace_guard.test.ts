import { isEntryStale } from "../src/editor/uix/workspace";

describe("isEntryStale", () => {
	test("file modified after index entry is stale", () => {
		expect(isEntryStale(2000, 1000)).toBe(true);
	});

	test("file not modified since index entry is fresh", () => {
		expect(isEntryStale(1000, 1000)).toBe(false);
		expect(isEntryStale(1000, 2000)).toBe(false);
	});

	test("missing index entry is stale", () => {
		expect(isEntryStale(1000, undefined)).toBe(true);
	});
});
