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
node scripts/obsidian-sandbox/cdp.mjs eval '<js>'          # `app`, `require` are globals; JSON result
node scripts/obsidian-sandbox/cdp.mjs shot .obsidian-sandbox/shot.png   # then Read the PNG
node scripts/obsidian-sandbox/cdp.mjs logs 3000 '<js>'     # console + uncaught errors
bun run sandbox reload                          # after each rebuild
bun run sandbox stop                            # when done (reset deletes the sandbox)
```

- Fixtures live in `sandbox-fixtures/`: notes are copied into the vault, and `plugin-data.json` pre-sets the author
  so the first-run author prompt doesn't appear. Add a fixture note for each bug you reproduce. `plugin-data.json`
  must keep `version` and the metadata keys: a partial settings file is treated as an older install, which turns
  metadata off and runs migrations. After changing fixtures: `bun run sandbox reset`, then `start`.
- The sandbox runs the same Obsidian version as the user (it copies their newest `obsidian-<ver>.asar`). Trust
  `bun run sandbox status` for the version; the window's user-agent shows only the base installer version.
- Check computed styles and a screenshot, not just the DOM: a class can be present while its colour resolves to
  nothing (0.13.2: `--text-highlight-bg` no longer existed).
