# pi-pure

A set of simple [pi](https://pi.dev) extensions to provide an uncluttered experience.

## Extensions

### pure-editor

This extension replaces the pi input editor with an editor in a rounded box.

```
╭──────────────────────────────────────────╮
│ ❱ input text here                        │
│   continuation lines                     │
╰──────────────────────────────────────────╯
```

- The border color shows the thinking level.
- The `❱` prompt uses the `borderAccent` color of the theme.
- When the text is longer than the editor, the top border shows the number of lines above the editor (`↑ 3 more`). The bottom border shows the number of lines below the editor (`↓ 3 more`).
- The autocomplete list shows below the box.
- When the terminal is less than 10 columns wide, the extension shows the default pi editor.

### pure-status

This extension replaces the pi footer with one status line.

```
[ session ] model high · parent/dir main        $0.42 ████▋▒▒▒▒▒▒▒▒▒▒▒ 28% · 42 τ/s
```

The left side shows these items:

1. The session name. The line shows the session name only when the session has a name.
2. The model name.
3. The thinking level. The line shows the thinking level only when the model supports reasoning.
4. The last two parts of the working directory.
5. The git branch.

The right side shows these items:

1. The cost of the session. The cost includes all branches of the session.
2. A bar that shows the context usage. The bar is green below 50%, yellow below 80%, and red at 80% or more.
3. The context usage as a percentage. The line shows `?%` when pi does not know the context usage, for example after a compaction.
4. The output speed in tokens per second (τ/s). The speed is the median of the last 5 responses.

When the terminal is too narrow, the extension cuts the left side first.

## Install

Install the package from npm:

```sh
pi install npm:@ghoseb/pi-pure
```

To try the package for one session, use the `-e` option:

```sh
pi -e npm:@ghoseb/pi-pure
```

To use only one of the extensions, run `pi config` and disable the other extension.

## Development

This project uses [pnpm](https://pnpm.io).

```sh
pnpm install     # Install the dependencies and the git hooks.
pnpm test        # Run the tests.
pnpm typecheck   # Check the types.
pnpm check       # Run the linter and the format check.
pnpm fix         # Fix the lint and format problems.
pnpm knip        # Find unused files, exports, and dependencies.
pnpm changelog   # Show the changelog entries for the next release.
```

## Release

Use [Conventional Commits](https://www.conventionalcommits.org) for commit messages. [git-cliff](https://git-cliff.org) uses the commit messages to write `CHANGELOG.md`.

To make a release, do these steps:

1. Run `pnpm release`. The script selects the next version from the commit messages. To set the version yourself, add a version or `major`, `minor`, or `patch`, for example `pnpm release 1.0.0`.
2. Examine the release commit and `CHANGELOG.md`.
3. Push the commit and the tag: `git push --follow-tags`.
4. Publish the package: `npm publish`.

The release script runs the checks and the tests, sets the version in `package.json`, writes `CHANGELOG.md`, and makes a commit and a tag. The script does not push or publish.

## License

[MIT](LICENSE)
