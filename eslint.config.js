import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	// Vendored third-party code and build outputs are not ours to lint
	{
		ignores: [
			"main.js",
			"src/database/**",
			"src/ui/components/**",
			"scripts/**",
			"**/*.js",
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	...svelte.configs.recommended,
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
				// Obsidian injects these onto the DOM/Window at runtime (see obsidian's
				// global.d.ts); no-undef doesn't know about them without this.
				app: "readonly",
				activeWindow: "readonly",
				createDiv: "readonly",
				createEl: "readonly",
				createSpan: "readonly",
			},
		},
		rules: {
			// Carried over from .eslintrc.cjs
			"no-unused-vars": "off",
			"@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
			"@typescript-eslint/no-explicit-any": ["error", { ignoreRestArgs: true }],
			"@typescript-eslint/ban-ts-comment": "off",
			"no-prototype-builtins": "off",
			"@typescript-eslint/no-empty-function": "off",
			// Ignore A11y rules (carried over)
			"svelte/valid-compile": "off",

			// PRE-EXISTING violations found when svelte linting was first enabled (Phase 2).
			// Downgraded to warnings so the gate stays green; burn down separately.
			// Priority: svelte/no-at-html-tags (XSS-adjacent, AnnotationThread.svelte x2) and no-undef (Row x2, Interval x1 — real missing refs).
			"no-useless-assignment": "warn",
			"prefer-const": "warn",
			"no-cond-assign": "warn",
			"@typescript-eslint/no-unused-expressions": "warn",
			"no-undef": "warn",
			"svelte/no-at-html-tags": "warn",
			"svelte/require-each-key": "warn",
			"svelte/no-useless-mustaches": "warn",
			"svelte/no-unused-svelte-ignore": "warn",
			"@typescript-eslint/no-require-imports": "warn",
		},
	},
	{
		// PRE-EXISTING no-unused-vars / no-explicit-any debt (Phase 2 lint migration).
		// Ratchet: fix a file, remove it from this list. Do not add files.
		files: [
			"src/editor/base/edit-logic/mark.ts",
			"src/editor/base/edit-util/range-operations.ts",
			"src/editor/base/ranges/base_range.ts",
			"src/main.ts",
			"src/types/extensions.d.ts",
			"src/ui/pages/annotations-view/AnnotationThread.svelte",
			"src/ui/pages/annotations-view/AnnotationThreadQuickActions.svelte",
			"src/ui/pages/annotations-view/AnnotationsView.svelte",
			"src/ui/pages/annotations-view/filter-ranges.ts",
			"src/ui/pages/settings/tabs/AdvancedSettings.svelte",
			"src/ui/pages/settings/tabs/EditorSettings.svelte",
			"src/ui/pages/settings/tabs/StyleSettings.svelte",
			"src/ui/pages/settings/tabs/SuggestionSettings.svelte",
			"src/ui/view.svelte.ts",
		],
		rules: {
			"@typescript-eslint/no-unused-vars": ["warn", { args: "none" }],
			"@typescript-eslint/no-explicit-any": ["warn", { ignoreRestArgs: true }],
		},
	},
	{
		// Replaces eslint-plugin-deprecation: type-aware deprecation warnings on .ts only
		// (type-aware linting of .svelte files is still fragile; the old config had the same caveat)
		files: ["**/*.ts"],
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
		rules: { "@typescript-eslint/no-deprecated": "warn" },
	},
	{
		// eslint-plugin-svelte's recommended config also assigns svelte-eslint-parser
		// to **/*.svelte.ts (Svelte 5 rune modules), which otherwise falls back to
		// espree for the script content and can't parse TypeScript syntax.
		files: ["**/*.svelte", "**/*.svelte.ts"],
		languageOptions: {
			parserOptions: {
				parser: tseslint.parser,
				extraFileExtensions: [".svelte"],
			},
		},
	},
);
