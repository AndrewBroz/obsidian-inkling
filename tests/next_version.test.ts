import { nextVersion } from "../scripts/release/next-version";

// EXPL: Betas ship to the release-only beta repo (see .github/workflows/releases.yml). A beta
//       version must sort above the stable it follows and below the stable it leads to, which is
//       what semver pre-release ordering gives: 0.12.4 < 0.13.0-beta.0 < 0.13.0-beta.1 < 0.13.0.
describe("nextVersion", () => {
	test.each(
		[
			["0.12.4", "patch", false, "0.12.5"],
			["0.12.4", "minor", false, "0.13.0"],
			["0.12.4", "major", false, "1.0.0"],
			["0.12.4", "minor", true, "0.13.0-beta.0"],
			["0.12.4", "patch", true, "0.12.5-beta.0"],
			["0.13.0-beta.0", "minor", true, "0.13.0-beta.1"],
			["0.13.0-beta.9", "patch", true, "0.13.0-beta.10"],
			["0.13.0-beta.2", "minor", false, "0.13.0"],
			["0.13.0-beta.2", "patch", false, "0.13.0"],
		] as const,
	)("%s, %s, beta=%s -> %s", (current, type, beta, expected) => {
		expect(nextVersion(current, type, beta)).toBe(expected);
	});

	test("a legacy -rc version is promoted like a beta", () => {
		expect(nextVersion("0.13.0-rc.1", "minor", false)).toBe("0.13.0");
	});

	test("rejects a version it cannot parse", () => {
		expect(() => nextVersion("0.13", "patch", false)).toThrow();
	});
});
