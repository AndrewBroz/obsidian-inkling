module.exports = {
	testEnvironment: 'jsdom',
	testMatch: ["**/tests/**/*.test.ts"],

	collectCoverage: false,

	transform: {
		'^.+\\.ts$': ['ts-jest', {
			useESM: true,
			tsconfig: {
				verbatimModuleSyntax: false,
			}
		}],
		"^.+\\.(js|jsx)$": "esbuild-jest"
	},
	extensionsToTreatAsEsm: ['.ts'],

	setupFiles: ["<rootDir>/tests/setup.ts"],

	moduleDirectories: ["node_modules", "src", "tests"],
	moduleFileExtensions: ['js', 'ts'],
	// moduleNameMapper: {
	// 	"obsidian": "tests/__mocks__/obsidian_mock.ts",
	// },

	setupFilesAfterEnv: ["jest-expect-message"],
	noStackTrace: true,
};
