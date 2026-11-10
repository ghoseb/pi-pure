# pi-pure

A set of simple [pi](https://pi.dev) extensions to provide an uncluttered experience along with some extra goodies.

## Extensions

### pure-editor

This extension replaces the pi input editor with an editor in a rounded box.

```text
╭──────────────────────────────────────────╮
│ ❱ input text here                        │
│   continuation lines                     │
╰──────────────────────────────────────────╯
```

- The border color shows the thinking level.
- The `❱` prompt uses the `borderAccent` color of the theme.
- When the text has more lines than the editor can show, the borders show the number of hidden lines:
  - The top border shows the number of lines above the editor (`↑ 3 more`).
  - The bottom border shows the number of lines below the editor (`↓ 3 more`).
- The editor shows the autocomplete list below the box.
- When the terminal is less than 10 columns wide, the extension shows the default pi editor.

### pure-status

This extension replaces the pi footer with one status line.

```text
[ session ] model high · parent/dir main        $0.42 ████▋▒▒▒▒▒▒▒▒▒▒▒ 28% · 42 τ/s
```

The left side shows these items:

1. The session name.
   The line shows the session name only when the session has a name.
2. The model name.
3. The thinking level.
   The line shows the thinking level only when the model supports reasoning.
4. The last two parts of the working directory path.
5. The git branch.

The right side shows these items:

1. The cost of the session.
   The cost includes all branches of the session.
2. A bar that shows the context usage.
   The bar is green below 50% and yellow below 80%.
   At 80% or more, the bar is red.
3. The context usage as a percentage.
   The line shows `?%` when pi does not know the context usage, for example after a compaction.
4. The output speed in tokens per second (τ/s).
   The line shows the median speed of the last 5 responses.

When the line is too long for the terminal, the extension shortens the left side first.

### rfc2119

This extension changes the [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) keywords in your messages to uppercase
before pi sends the messages to the model.
The uppercase keywords tell the model to use their RFC 2119 meaning.

For example, you write this message:

```text
you must not edit the tests and should keep the API
```

The model gets this text:

```text
you MUST NOT edit the tests and SHOULD keep the API
```

The extension changes these keywords:

- `MUST`, `MUST NOT`, `REQUIRED`, `SHALL`, `SHALL NOT`
- `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `NOT RECOMMENDED`
- `MAY`, `OPTIONAL`
- `NEVER`.
  RFC 2119 does not have this keyword.
  Use `NEVER` as a stronger `MUST NOT`.

The extension does not change these items:

1. Text in code blocks and inline code.
2. Words in paths, URLs, and identifiers, for example `src/must.ts` and `/skill:required`.
3. Words with a hyphen, for example `must-have` and `non-optional`.
4. Keywords inside other words, for example `maybe` and `mustard`.
5. Messages from other extensions.

### apply-patch

This extension adds an `apply_patch` tool.
The model uses the tool to change files with a patch in the [OpenAI Codex](https://github.com/openai/codex)
`apply_patch` format.

This is an example patch:

```text
*** Begin Patch
*** Update File: src/app.ts
@@ function main() {
   const port = 3000;
-  start(port);
+  start(port, { verbose: true });
*** Delete File: src/old.ts
*** End Patch
```

- One patch can add, delete, update, and move many files.
- The tool finds the lines to change, even when the whitespace or the punctuation is different from the file.
  For example, the tool matches `“` in the file to `"` in the patch.
- The tool checks the full patch before it changes a file.
  If the tool cannot apply one operation, it changes no files.
- Updated files keep their line endings and their byte order mark (BOM).
- The tool follows symbolic links:
  - The tool writes a change to a symbolic link into the target file.
  - When two paths in a patch go to the same file, the tool applies all the changes to that file.
  - When the tool deletes or moves a symbolic link, it removes only the link.
    The target file stays.
- The tool uses the pi file lock.
  Thus the tool does not overwrite changes that `edit`, `write`, or other `apply_patch` calls make at the same time.
- The tool result shows a diff of each file.

The extension does not remove the pi `edit` tool.
The `apply_patch` instructions tell the model to use `edit` for simple changes in one file.

## Install

Install the package from npm:

```sh
pi install npm:@ghoseb/pi-pure
```

To try the package for one session, use the `-e` option:

```sh
pi -e npm:@ghoseb/pi-pure
```

To use only some of the extensions, run `pi config` and disable the other extensions.

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

Use [Conventional Commits](https://www.conventionalcommits.org) for commit messages.
[git-cliff](https://git-cliff.org) uses the commit messages to write `CHANGELOG.md`.

To make a release, do these steps:

1. On the `main` branch, commit all changes.
2. Run `pnpm release`.
   The script selects the next version from the commit messages.
   - To set the version, add a version number, `major`, `minor`, or `patch`.
     For example: `pnpm release 1.0.0`.
3. Examine the release commit and `CHANGELOG.md`.
4. Push the commit and the tag: `git push --follow-tags`.
5. Publish the package: `npm publish`.

The release script does these steps:

1. It stops if the working tree has changes, if the branch is not `main`, or if there are no new commits.
2. It runs the checks and the tests.
3. It sets the version in `package.json`.
4. It writes `CHANGELOG.md`.
5. It makes a commit and a tag.

The script does not push or publish.

## License

[MIT](LICENSE)
