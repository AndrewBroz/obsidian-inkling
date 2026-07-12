import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

let pkgDir = cwd();
const relativePath = join("node_modules", "obsidian-typings");
if (pkgDir.endsWith(relativePath))
	pkgDir = pkgDir.slice(0, -(relativePath.length + 1));

// NOTE: The @codemirror packages define both an index.d.cts and an index.d.ts file,
//       which causes TypeScript to treat them as separate modules with separate types,
//       even though they are actually the same module. Removing the .d.cts files resolves this issue.
//       (This might be an issue with obsidian-typings)
const filesToRemove = [
	join(pkgDir, "node_modules", "@codemirror", "state", "dist", "index.d.cts"),
	join(pkgDir, "node_modules", "@codemirror", "view", "dist", "index.d.cts"),
];

for (const file of filesToRemove) {
	if (existsSync(file)) {
		rmSync(file);
		console.log(`Removed ${file}`);
	}
}
