import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import svelte from "eslint-plugin-svelte";
import svelteParser from "svelte-eslint-parser";
import tseslint from "typescript-eslint";

/** @typedef {import("eslint").Linter.Config} Config */
/** @typedef {import("eslint").Rule.RuleModule} RuleModule */
/** @typedef {import("eslint").Rule.RuleContext} RuleContext */

// The same rules the Obsidian community scorecard's automated scan runs on each release
// (eslint-plugin-obsidianmd's recommended config, which includes typescript-eslint's type-checked
// rules), applied to everything that ships: src/, package.json, manifest.json and LICENSE, and to the
// config files at the root, which the scan lints too (it reported this file's types on 0.15.3).
// Run from the project root (`bun run lint`), or the package.json/manifest/LICENSE checks never run.
const TS_FILES = "**/*.{ts,cts,mts,tsx}";
const ALL_SCRIPT_FILES = "**/*.{ts,cts,mts,tsx,js,cjs,mjs,jsx}";
const ROOT_CONFIG_FILES = ["eslint.config.js", "jest.config.cjs"];
const SHIPPED_SOURCE = ["src/**/*.ts", "src/**/*.svelte"];

/**
 * A block of obsidianmd's recommended config that lints TypeScript source (and not only tests).
 * @param {Config} config
 */
function appliesToTypeScript(config) {
	return (config.files ?? []).some((pattern) =>
		pattern === TS_FILES || pattern === ALL_SCRIPT_FILES || (Array.isArray(pattern) && pattern[0] === TS_FILES)
	);
}

// The scan runs an older eslint-plugin-obsidianmd than npm's latest (0.6.0), and its checks are stricter in
// two places that 0.15.3 failed on. The rules below put that strictness back on top of 0.6.0's rules.
//
// 1. no-unsupported-api. 0.6.0 accepts a newer API inside an override of a method only Obsidian calls
//    (getSettingDefinitions, setControlValue, ...), because Obsidian only calls it on the version that added
//    it. The scan doesn't, and reported `this.refreshDomState()` in setControlValue as an error. This is
//    0.6.0's rule with that one proof taken away: the rule skips the proof when the file also calls the
//    method by name (`.setControlValue`), so it's shown a source text that does. Guard a newer API with
//    `if (requireApiVersion("x.y.z"))` around the use; that's the guard both versions accept.
const OBSIDIAN_CALLED_HOOKS = [
	"getSettingDefinitions",
	"getControlValue",
	"setControlValue",
	"onExternalSettingsChange",
	"onPaneMenu",
	"onUserEnable",
];
const HOOK_CALLS = `\n/* ${OBSIDIAN_CALLED_HOOKS.map((name) => `.${name}`).join(" ")} */\n`;
const unsupportedApi = /** @type {RuleModule} */ (obsidianmd.rules["no-unsupported-api"]);

/** @type {RuleModule} */
const unsupportedApiWithoutHookProof = {
	meta: unsupportedApi.meta,
	create(context) {
		// The context and its source code as they are, but for the text.
		const sourceCode = { text: context.sourceCode.text + HOOK_CALLS };
		Object.setPrototypeOf(sourceCode, context.sourceCode);
		const contextWithHookCalls = { sourceCode };
		Object.setPrototypeOf(contextWithHookCalls, context);
		return unsupportedApi.create(/** @type {RuleContext} */ (/** @type {unknown} */ (contextWithHookCalls)));
	},
};

// 2. no-global-this. 0.6.0 leaves `globalThis` alone in a type (`typeof globalThis`); the scan reports it
//    there too, with the message below. `typeof window` is the same type.
const GLOBAL_THIS_IN_TYPE = {
	selector: ":matches(TSTypeQuery, TSTypeReference) Identifier[name='globalThis']",
	message: "Avoid using 'globalThis'. Use 'window' or 'activeWindow' for popout window compatibility.",
};

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
	]),
	...obsidianmd.configs.recommended,
	// The recommended config only targets JS and TS files. Svelte components get the same blocks.
	...obsidianmd.configs.recommended.filter(appliesToTypeScript).map(({ languageOptions: _, ...config }) => ({
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
		// The root config files aren't in a tsconfig; they get TypeScript's default project. obsidianmd's
		// recommended config lints JavaScript without type information, but the scan type-checks it (it reported
		// no-unsafe-* in this file on 0.15.3), so these get typescript-eslint's type-checked rules as TS does.
		files: ROOT_CONFIG_FILES,
		extends: [tseslint.configs.recommendedTypeChecked],
		languageOptions: {
			parserOptions: {
				projectService: { allowDefaultProject: ROOT_CONFIG_FILES },
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		files: ["jest.config.cjs"],
		languageOptions: { sourceType: "commonjs", globals: { module: "writable" } },
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
		// The scan's stricter checks (above), on the code that runs in Obsidian.
		files: SHIPPED_SOURCE,
		plugins: { "inkling-scan": { rules: { "no-unsupported-api": unsupportedApiWithoutHookProof } } },
		rules: {
			"inkling-scan/no-unsupported-api": "error",
			"no-restricted-syntax": ["warn", GLOBAL_THIS_IN_TYPE],
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
