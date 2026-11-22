import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import svelte from "eslint-plugin-svelte";
import svelteParser from "svelte-eslint-parser";
import tseslint from "typescript-eslint";

// The same rules the Obsidian community scorecard's automated scan runs on each release
// (eslint-plugin-obsidianmd's recommended config, which includes typescript-eslint's type-checked
// rules), applied to everything that ships: src/, package.json, manifest.json and LICENSE.
// Run from the project root (`bun run lint`), or the package.json/manifest/LICENSE checks never run.
const TS_FILES = "**/*.{ts,cts,mts,tsx}";
const ALL_SCRIPT_FILES = "**/*.{ts,cts,mts,tsx,js,cjs,mjs,jsx}";

/** A block of obsidianmd's recommended config that lints TypeScript source (and not only tests). */
function appliesToTypeScript(config) {
	return (config.files ?? []).some((pattern) =>
		pattern === TS_FILES || pattern === ALL_SCRIPT_FILES || (Array.isArray(pattern) && pattern[0] === TS_FILES)
	);
}

export default defineConfig([
	// Build output, tests and Node-side tooling don't ship in the plugin.
	globalIgnores([
		"main.js",
		"styles.css",
		"node_modules",
		".obsidian-sandbox",
		".obsidian-cache",
		".claude",
		".superpowers",
		"docs",
		"scripts",
		"tests",
		"__mocks__",
		"jest.config.cjs",
		"eslint.config.js",
	]),
	...obsidianmd.configs.recommended,
	// The recommended config only targets JS and TS files. Svelte components get the same blocks.
	...obsidianmd.configs.recommended.filter(appliesToTypeScript).map(({ languageOptions, ...config }) => ({
		...config,
		files: ["**/*.svelte"],
	})),
	// eslint-plugin-svelte's rules block has no `files`, and its rules crash on JSON and LICENSE.
	...svelte.configs.recommended.map((config) =>
		config.files ? config : { ...config, files: ["**/*.svelte", "**/*.svelte.ts"] }
	),
	{
		files: ["**/*.ts", "**/*.svelte"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".svelte"],
			},
		},
	},
	{
		// eslint-plugin-svelte's recommended config assigns svelte-eslint-parser to .svelte and
		// .svelte.ts (Svelte 5 rune modules); it needs the TypeScript parser for the script content.
		files: ["**/*.svelte", "**/*.svelte.ts"],
		languageOptions: {
			parser: svelteParser,
			parserOptions: { parser: tseslint.parser },
		},
	},
	{
		// The e2e suite (WebdriverIO + mocha) has its own TypeScript project; the root one excludes it, because
		// mocha's globals clash with jest's. It gets the same rules: it runs in Node and in the Obsidian page.
		files: ["test/e2e/**/*.ts", "wdio.conf.mts"],
		languageOptions: {
			parserOptions: {
				projectService: false,
				project: "./test/e2e/tsconfig.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
]);
