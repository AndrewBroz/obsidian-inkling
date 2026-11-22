# End-to-end tests in real Obsidian

## Why

Unit tests run in jsdom, where Obsidian's CSS, theme variables, markdown decorations and plugin lifecycle don't
exist. The 0.13–0.15 bugs passed every unit test and were only found in the app:
- a crash in decoration sorting;
- invisible highlights (Obsidian renamed a CSS variable);
- comment cards duplicated when a code block was typed;
- the draft reflow;
- typing interference inside code blocks.

An automated suite in real Obsidian catches that class of bug before it ships. It runs on every push and gates every
release.

## Approach

[`wdio-obsidian-service`](https://github.com/jesse-r-s-hines/wdio-obsidian-service) is a WebdriverIO service for
Obsidian plugins (MIT, v3.5.0, roughly monthly releases). It downloads and launches the requested Obsidian versions
in sandboxed instances, installs the plugin from the project directory (`plugins: ["."]`), and copies a fixture
vault for each run. It also provides `browser.executeObsidian(({app}) => …)`, `executeObsidianCommand`,
`obsidianPage.resetVault()` and a GitHub Actions recipe (Xvfb + herbstluftwm, with the download cached).

Alternatives considered:
- **A runner on top of our CDP sandbox scripts.** It only runs where Obsidian is installed (not in CI), only on one
  Obsidian version, and we'd own all the plumbing.
- **Playwright `connectOverCDP`.** Same version and CI gaps.

The sandbox (`scripts/obsidian-sandbox`) stays the tool for investigating and reproducing new bugs. When a bug is
reproduced there, it becomes an e2e spec.

## Setup

- Dev dependencies: `wdio-obsidian-service`, `wdio-obsidian-reporter`, `mocha`, `@types/mocha` (pinned).
- `wdio.conf.mts` (ESM). The version matrix is `parseObsidianVersions("earliest/earliest latest/latest")`, which is
  the manifest's `minAppVersion` (1.8.7) plus the latest release. `cacheDir` is `.obsidian-cache` (git-ignored).
  Locally `maxInstances` is 1; in CI it's 2.
- Specs: `test/e2e/specs/*.e2e.ts`. Fixture vaults: `test/e2e/vaults/`. The sandbox fixtures move here and become
  one source for both; the sandbox setup script points at them. Pre-set plugin settings (author, settings version)
  come from the vault's `.obsidian/plugins/inkling-markup/data.json`; that this survives `plugins: ["."]` is
  verified in the first step.
- Scripts: `bun run build` builds as today, then `test:e2e` runs `wdio run ./wdio.conf.mts` under Node (bun runs
  the build; WebdriverIO expects Node).
- Locally the suite runs at low priority (`nice`), like the jest rule in CLAUDE.md.

## First specs

These are the regressions from 0.13–0.15, written as user-level checks: open a fixture, act through commands or real
keys, then assert on the note text, the DOM, computed styles and console errors.

1. **Live preview with attribute blocks:** no "Ranges must be added sorted" error; markup and tags hidden;
   highlight, addition and deletion styling present.
2. **Comment highlight colour:** the computed `background-color` of `.cmtr-highlight` isn't transparent, in both
   metadata formats.
3. **Typing a fence in a commented note:** the number of cards stays the same.
4. **Typing inside a code block:** select, `{`, `~~` gives the same result as without Inkling, in Editing and
   Suggest mode.
5. **Draft comment:**
   - the anchor is highlighted while drafting;
   - the pill is hidden;
   - clicking away commits, and an empty draft is discarded;
   - the note's `x` position is stable on open and submit at a wide window size.
6. **Suggest mode:** typing writes `{++…++}{author=… time=…}`; line markers go in untracked; Accept and Reject work.
7. **Comments on code blocks:**
   - a selection writes a comment after the fence with its quote;
   - focusing it highlights the code;
   - editing the code away shows "This code has changed".
8. **Settings:**
   - an existing install sees the format notice once;
   - settings without a version show no "migration failed" notice;
   - (after the scorecard work) Inkling settings appear in settings search on 1.13+.

## CI and the release gate

- A new workflow, `.github/workflows/e2e.yml`, runs on push and pull request, following the sample's recipe.
- The release workflow runs the same suite (`needs: e2e`) before publishing, so a red suite blocks a release.
- CLAUDE.md "Releasing": a passing e2e run joins lint, audit and unit tests.

## Out of scope

Android/Appium, Obsidian beta versions (they need Insider credentials), and visual screenshot diffs.

## Later

Once this works here, the `obsidian-plugin-setup` skill packages it. That skill covers lint rules, the e2e suite,
the sandbox, the release workflow and CLAUDE.md sections, for new or existing plugins.
