# Contributing to Inkling

Thanks for helping. Bug reports and feature requests go in
[GitHub issues](https://github.com/AndrewBroz/obsidian-inkling/issues); the bug report form asks for what we need
to reproduce the problem.

## Setup

Inkling builds with [Bun](https://bun.sh) (the version is in `package.json`, under `packageManager`).

```bash
bun install --frozen-lockfile
bun run build        # type-checks, then writes main.js and styles.css
```

To try a build, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/inkling-markup/`,
or use the sandbox below.

## Before you open a pull request

- `bun run lint` passes with no errors or warnings. It runs the same checks as Obsidian's review of community
  plugins. Fix what it reports rather than turning a rule off.
- `npx jest` passes, and a change in behaviour comes with a test.
- Anything you can see in Obsidian (rendering, styles, the editor, modals, settings) is checked in Obsidian
  itself. `bun run sandbox start` opens a separate Obsidian with a throwaway vault where Inkling is the only
  plugin; see `scripts/obsidian-sandbox/`.
- Keep each file's line endings as they are.

Pull requests go to `AndrewBroz/obsidian-inkling`. Keep them focused on one change, and say in the description what
it fixes and how you checked it.

## License

By contributing you agree that your work is released under the [MIT License](LICENSE).
