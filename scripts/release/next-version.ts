export type BumpType = "patch" | "minor" | "major";

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-(?:beta|rc)\.(\d+))?$/;

/**
 * The version after `current`.
 * @remarks A beta follows semver pre-release ordering, so it sorts between the stable before it and
 *   the stable it leads to: 0.12.4 < 0.13.0-beta.0 < 0.13.0-beta.1 < 0.13.0.
 *   - From a stable version, `type` picks the next version; `beta` makes it `-beta.0` of that.
 *   - From a beta, `beta` increments the beta number and `type` is ignored; without `beta`, the beta
 *     is promoted to its stable version.
 *   `-rc.N` is read like `-beta.N`, for tags made by the pre-beta release script.
 */
export function nextVersion(current: string, type: BumpType, beta: boolean): string {
	const match = VERSION_RE.exec(current);
	if (!match) throw new Error(`Cannot parse version "${current}"`);
	const [major, minor, patch] = match.slice(1, 4).map(Number);
	const prerelease = match[4] === undefined ? undefined : Number(match[4]);

	if (prerelease !== undefined) {
		const base = `${major}.${minor}.${patch}`;
		return beta ? `${base}-beta.${prerelease + 1}` : base;
	}

	const next = type === "major" ?
		`${major + 1}.0.0` :
		type === "minor" ?
		`${major}.${minor + 1}.0` :
		`${major}.${minor}.${patch + 1}`;
	return beta ? `${next}-beta.0` : next;
}
