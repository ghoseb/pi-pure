#!/usr/bin/env bash
#
# Prepare a release: bump the version, write CHANGELOG.md, commit, and tag.
#
# Usage: pnpm release [<version> | major | minor | patch]
#
# With no argument, git-cliff picks the next version from the Conventional
# Commits since the last tag. The script does not push or publish; it prints
# the commands for those steps.

set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  echo "release: $*" >&2
  exit 1
}

[[ -z "$(git status --porcelain)" ]] || fail "the working tree has uncommitted changes"
[[ "$(git branch --show-current)" == "main" ]] || fail "releases are made from the main branch"

bump="${1:-}"
if [[ -z "$bump" ]]; then
  bump="$(pnpm exec git-cliff --bumped-version)"
  bump="${bump#v}"
  current="$(node --print 'require("./package.json").version')"
  [[ "$bump" != "$current" ]] || fail "no new commits to release since v$current"
fi

echo "release: running checks"
pnpm run typecheck
pnpm run check
pnpm run knip
pnpm run test

# npm version accepts an explicit version or major/minor/patch, and fails when
# the version does not change. It prints the new version with a "v" prefix.
tag="$(npm version "$bump" --no-git-tag-version)"
version="${tag#v}"

if git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null; then
  git checkout -- package.json
  fail "tag $tag already exists"
fi

echo "release: writing CHANGELOG.md for $tag"
pnpm exec git-cliff --tag "$tag" --output CHANGELOG.md
pnpm exec oxfmt CHANGELOG.md package.json

git add package.json CHANGELOG.md
git commit --message "chore(release): $tag"
git tag --annotate "$tag" --message "$tag"

cat <<EOF

release: created commit and tag $tag (version $version).

Check the commit and CHANGELOG.md. Then publish:

  git push --follow-tags
  npm publish

To undo before you push:

  git tag --delete $tag && git reset --hard HEAD~1
EOF
