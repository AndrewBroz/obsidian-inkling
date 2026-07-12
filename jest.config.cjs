module.exports = {
	testEnvironment: "jsdom",
	testMatch: ["**/tests/**/*.test.ts"],

	collectCoverage: false,

	transform: {
		"^.+\\.ts$": ["ts-jest", {
			// Type-checking is the responsibility of `bun run build`
			// (tsc -noEmit). ts-jest's full-program type-check resolves
			// @codemirror/state types differently than the main build in
			// this repo (readonly-array mismatches, differing verdicts on
			// whether an existing @ts-expect-error is "used"), which
			// otherwise blocks the whole suite from loading over files the
			// tests don't even exercise. isolatedModules makes ts-jest
			// transpile-only (like the rest of the toolchain already does
			// via esbuild for the production build).
			isolatedModules: true,
			tsconfig: {
				verbatimModuleSyntax: false,
			},
		}],
	},

	setupFiles: ["<rootDir>/tests/setup.ts"],

	moduleDirectories: ["node_modules", "src", "tests"],
	moduleFileExtensions: ["js", "ts"],
	moduleNameMapper: {
		// The real module extends a class resolved at import time from the
		// live Obsidian app (resolveEditorPrototype(app)), which is
		// unavailable under jest. Stub it out for any importer.
		//
		// Anchored to a leading path separator (not just the bare "ui/"
		// segment) because real importers use both "../../../ui/embeddable-editor"
		// (from outside src/ui/) and "./embeddable-editor" (from
		// src/ui/preview-editor.ts, which lives inside src/ui/ itself and so
		// has no literal "ui/" segment in its specifier). This still rejects
		// an unrelated module whose name merely ends in "embeddable-editor"
		// without a path separator directly before it (e.g. "my-embeddable-editor"),
		// which the previous bare "embeddable-editor$" pattern would have
		// matched.
		"/embeddable-editor$": "<rootDir>/tests/__mocks__/embeddable-editor.ts",
	},

	setupFilesAfterEnv: ["jest-expect-message"],
	noStackTrace: true,
};
