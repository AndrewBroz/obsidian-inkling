/**
 * File inspired by:
 * 	- https://github.com/Enveloppe/obsidian-enveloppe/blob/master/commit-and-tag-version.js
 * 	- https://github.com/mProjectsCode/obsidian-meta-bind-plugin/blob/master/automation/release.ts
 */
import * as Bun from "bun";
import { Command, Option } from "commander";
import { format } from "../utils/formatting";
import { nextVersion } from "./next-version";

const program = new Command()
	.addOption(
		new Option("-t, --type <type>", "Version bump type").choices(["patch", "minor", "major"]).default("patch"),
	)
	.addOption(new Option("-T, --testRun", "Run without commiting changes").default(false))
	.addOption(new Option("-b, --beta", "Create a beta version (published to the beta repo only)").default(false))
	.parse();

const versionType = program.opts().type as "patch" | "minor" | "major";
const testRun = program.opts().testRun;

const currentVersion = process.env.npm_package_version!;
const isBeta = program.opts().beta;

// EXPL: manifest.json on the default branch is what Obsidian's community updater reads, so it only
//       ever names a stable version. A beta's manifest gets its version at build time instead
//       (.github/workflows/releases.yml); BRAT reads the manifest attached to the release, never
//       manifest-beta.json, which BRAT 2.x no longer supports.
const package_json_file = Bun.file("package.json");
const manifest_file = Bun.file("manifest.json");

const package_json = await package_json_file.json();
const manifest = await manifest_file.json();

const newVersion = nextVersion(currentVersion, versionType, isBeta);
const label = `[${isBeta ? "beta" : currentVersion.includes("-") ? "promote beta" : versionType}]`;

if (testRun) {
	console.log(
		`${format(" Test run ", "bg_blue")} | Bumped plugin version ${
			format(`${currentVersion} -> ${newVersion}`, "fg_blue")
		} | ${format(label, "fg_yellow")}`,
	);
	process.exit(0);
}

package_json.version = newVersion;
if (!isBeta)
	manifest.version = newVersion;

await Bun.write("package.json", JSON.stringify(package_json, null, "\t") + "\n");
await Bun.write(manifest_file, JSON.stringify(manifest, null, "\t") + "\n");

try {
	Bun.spawnSync(["git", "add", "package.json", "manifest.json"]);
	Bun.spawnSync(["git", "commit", "-m", `chore(release): ${newVersion}`]);
	Bun.spawnSync(["git", "tag", "-a", newVersion, "-m", `chore(release): ${newVersion}`]);
	console.log(
		`${format(" Success ", "bg_green")} | Bumped plugin version ${
			format(`${currentVersion} -> ${newVersion}`, "fg_blue")
		} | ${format(label, "fg_yellow")}`,
	);

	// EXPL: Push the version tag BY ITSELF, never via `--follow-tags` or `--tags`. GitHub silently
	//       skips workflow runs for EVERY tag when more than three tags arrive in one push — no
	//       error, no skipped run, nothing in the Actions tab. Releases 0.7.1 through 0.9.0 all hit
	//       this: `--follow-tags` dragged a backlog of never-pushed annotated tags along with the new
	//       one, tripped the limit, and silently took the release build down with it. Each was then
	//       published by hand via workflow_dispatch, and the tag-push trigger was written off as
	//       "broken" — it never was. Confirmed by experiment (2026-07-13): one tag pushed alone
	//       triggers immediately; four pushed at once trigger nothing.
	console.log(
		`\n${format(" Next ", "bg_blue")} | Push the commit and the tag ${format("separately", "fg_yellow")}:\n\n` +
			`    git push origin main\n` +
			`    git push origin ${newVersion}\n\n` +
			`${format("  Do NOT use --follow-tags or --tags.", "fg_red")} GitHub skips workflow runs\n` +
			`  for all tags when >3 are pushed at once, so the release would never build.\n` +
			(isBeta ?
				`\n  This beta publishes to AndrewBroz/obsidian-inkling-beta only. The main repo never\n` +
				`  gets a beta: BRAT installs pre-releases for everyone tracking "latest".\n` :
				""),
	);
} catch (error) {
	console.log(`${format(" Error ", "bg_red")} | ${format("Failed when running git commands", "fg_red")}`);
}
