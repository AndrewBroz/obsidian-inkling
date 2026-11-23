# Inkling — instructions for Claude

## Never leave known bugs

A known bug is fixed before the work is called done. That includes bugs a review finds, bugs found while
working on something else, and regressions a fix introduces. Don't park them as "minor", "deferred",
"out of scope" or "ship and fix later", and don't let a process limit (a review-round cap, "one fix wave")
stand in for fixing. If a fix needs the user's decision, ask; don't ship around it.

## Test in real Obsidian

Unit tests can't see Obsidian's CSS, theme variables, its own markdown decorations or the plugin lifecycle. Anything
the user sees (rendering, styles, live preview / source / reading view, modals, commands) is checked in the
sandbox before it's called fixed, and a bug the user reports is reproduced there first. Use the
`obsidian-plugin-sandbox` skill if it's available; this section is enough without it.

The sandbox is a separate Obsidian instance (`--user-data-dir=.obsidian-sandbox/app-data`) with a throwaway vault
(`.obsidian-sandbox/vault`) where Inkling is the only community plugin, linked to this repo's build. It runs next to
the user's Obsidian. Never quit, open or otherwise touch the user's Obsidian or vaults, and never use
`obsidian://` links (they reach the user's instance).

```bash
bun run build                                   # the vault links main.js / styles.css / manifest.json
bun run sandbox start                           # first run sets up; prints Obsidian version + plugins
node scripts/obsidian-sandbox/cdp.mjs open 'Comments.md'
node scripts/obsidian-sandbox/cdp.mjs mode reading         # live | source | reading
node scripts/obsidian-sandbox/cdp.mjs size 2400 1400      # resize the sandbox window (layout bugs can need a wide one)
node scripts/obsidian-sandbox/cdp.mjs keys 'abc{Backspace}'   # real key events into the focused editor ({{ }} = literal braces)
node scripts/obsidian-sandbox/cdp.mjs mouse move 800 400     # real pointer events: move | click | down | up | drag
node scripts/obsidian-sandbox/cdp.mjs eval '<js>'          # `app`, `require` are globals; JSON result
node scripts/obsidian-sandbox/cdp.mjs shot .obsidian-sandbox/shot.png   # then Read the PNG
node scripts/obsidian-sandbox/cdp.mjs logs 3000 '<js>'     # console + uncaught errors
bun run sandbox reload                          # after each rebuild
bun run sandbox stop                            # when done (reset deletes the sandbox)
```

- Fixtures live in `test/e2e/vaults/basic/`, the e2e suite's fixture vault (one source for both): its files are
  copied into the sandbox vault, and `.obsidian/plugins/inkling-markup/data.json` pre-sets the author so the
  first-run author prompt doesn't appear. Add a fixture note for each bug you reproduce. That `data.json` must keep
  `version` and the metadata keys: a partial settings file is treated as an older install, which turns metadata off
  and runs migrations. After changing fixtures: `bun run sandbox reset`, then `start`.
- The sandbox runs the same Obsidian version as the user (it copies their newest `obsidian-<ver>.asar`). Trust
  `bun run sandbox status` for the version; the window's user-agent shows only the base installer version.
- Check computed styles and a screenshot, not just the DOM: a class can be present while its colour resolves to
  nothing (0.13.2: `--text-highlight-bg` no longer existed).

### End-to-end tests

`test/e2e/` holds an automated suite that runs in real, sandboxed Obsidian instances (wdio-obsidian-service), on the
manifest's `minAppVersion` and the latest release. It never touches the user's Obsidian: each run downloads Obsidian
into `.obsidian-cache/` and opens a temporary copy of `test/e2e/vaults/basic/` with its own user-data dir.

```bash
bun run build && bun run test:e2e                     # both versions, one at a time, at nice 19
OBSIDIAN_VERSIONS=latest/latest bun run test:e2e      # one version
bun run test:e2e -- --spec test/e2e/specs/settings.e2e.ts
```

- Never run it at the same time as jest. Locally it runs one Obsidian at a time (`maxInstances` 1); CI runs two.
- A bug reproduced in the sandbox becomes an e2e spec (with its fixture note in `test/e2e/vaults/basic/`), and the
  spec must fail with the bug put back before it counts.
- A stray `./data.json` (git-ignored) would replace the fixture vault's plugin settings, so the suite refuses to run.

## Releasing

Releases go out only when the owner says so. Every release keeps the plugin's community scorecard
(https://community.obsidian.md/plugins/inkling-markup, "Scorecard" tab) at **Review: Excellent** and
**Health: Excellent**. Its automated scan of each release is part of the bar, alongside the tests.

Before releasing:
1. `bun run lint`: 0 errors and 0 warnings (it also type-checks the e2e suite). The config includes Obsidian's `eslint-plugin-obsidianmd` and
   typescript-eslint's type-checked rules, which are what the scorecard's scan reports. Don't silence a rule to
   get there: fix the code. If a finding is a false positive, disable it on that line only, with a comment saying why.
2. `bun audit`: no advisories in shipped dependencies.
3. Full suite (`nice -n 19 npx jest --maxWorkers=2`), `npx tsc --noEmit`, `bun run build`, and a sandbox check of
   anything user-visible (see "Test in real Obsidian").
4. `bun run test:e2e`: passes on both Obsidian versions (not alongside jest). The release workflow runs the same suite
   (`.github/workflows/e2e.yml`) and publishes nothing if it fails. A bug reproduced in the sandbox becomes an e2e
   spec before the fix ships.

Release: `bun run release-patch|minor|major`, then `git push origin main` and `git push origin <tag>` alone (never
`--follow-tags`). Then confirm the workflow passed: `gh run list --repo AndrewBroz/obsidian-inkling`.

After the scan of the new release appears on the scorecard (read the page in a browser; the Scorecard tab is
rendered client-side), compare its findings with what lint reported. Anything new is fixed in the next patch,
and if lint missed it, add a rule or check that catches it next time.
