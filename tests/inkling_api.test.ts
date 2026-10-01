import { createApi } from "../src/api";
import { DEFAULT_SETTINGS } from "../src/constants";

describe("createApi", () => {
	test("exposes version 1 and toOriginalText", () => {
		const api = createApi(() => DEFAULT_SETTINGS);
		expect(api.version).toBe(1);
		expect(api.toOriginalText("a {++b ++}c")).toBe("a c");
	});

	test("is frozen", () => {
		const api = createApi(() => DEFAULT_SETTINGS);
		expect(Object.isFrozen(api)).toBe(true);
	});

	test("reads settings at call time", () => {
		let calls = 0;
		const api = createApi(() => (calls++, DEFAULT_SETTINGS));
		api.toOriginalText("x");
		api.toOriginalText("y");
		expect(calls).toBe(2);
	});
});
