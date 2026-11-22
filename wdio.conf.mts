import { existsSync } from "node:fs";
import * as path from "node:path";
import { env } from "node:process";
import { parseObsidianVersions } from "wdio-obsidian-service";

// EXPL: End-to-end tests in real, sandboxed Obsidian instances (see docs/superpowers/specs/2026-11-22-e2e-tests-design.md).
//       wdio-obsidian-service downloads each Obsidian version into `cacheDir`, copies the fixture vault to a tmpdir and
//       launches Obsidian with its own tmp `--user-data-dir`, so the developer's own Obsidian config and vaults are
//       never opened or touched. Run under Node (`bun run test:e2e`); bun only builds the plugin.

const cacheDir = path.resolve(".obsidian-cache");

// EXPL: `plugins: ["."]` copies a repo-root data.json over every fixture vault's preset plugin settings. It's
//       git-ignored, so a stray one is invisible; refuse to run rather than test against the wrong settings.
if (existsSync(path.resolve("data.json")))
	throw new Error("e2e: remove ./data.json — it would overwrite the fixture vaults' plugin settings");

// EXPL: "earliest" is the manifest's minAppVersion; "latest" is the newest non-beta release. Override with
//       OBSIDIAN_VERSIONS="1.9.0/1.9.0 latest/latest" etc.
const versions = await parseObsidianVersions(env.OBSIDIAN_VERSIONS ?? "earliest/earliest latest/latest", { cacheDir });
if (env.CI) {
	// Printed so a CI workflow can use it as the cache key for .obsidian-cache
	console.log("obsidian-cache-key:", JSON.stringify(versions));
}

export const config: WebdriverIO.Config = {
	runner: "local",
	framework: "mocha",
	// EXPL: Must be absolute: wdio exports it to child processes via tsx's env, and the service's 7z extractor runs
	//       in another cwd, where a relative path fails ("Cannot resolve tsconfig at path").
	tsConfigPath: path.resolve("test/e2e/tsconfig.json"),

	specs: ["./test/e2e/specs/**/*.e2e.ts"],

	// EXPL: One Obsidian at a time locally: unthrottled parallel runs have frozen the dev machine before.
	maxInstances: Number(env.WDIO_MAX_INSTANCES ?? (env.CI ? 2 : 1)),

	capabilities: versions.map(([appVersion, installerVersion]) => ({
		browserName: "obsidian",
		"wdio:obsidianOptions": {
			appVersion,
			installerVersion,
			plugins: ["."],
			vault: "test/e2e/vaults/basic",
		},
	})),

	services: ["obsidian"],
	reporters: ["obsidian"],

	mochaOpts: {
		ui: "bdd",
		timeout: 60 * 1000,
	},
	waitforInterval: 250,
	waitforTimeout: 5 * 1000,
	logLevel: "warn",

	cacheDir,

	injectGlobals: false,
};
