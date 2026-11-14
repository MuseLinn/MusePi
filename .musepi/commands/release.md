# Release

Release all packages at specified version.

## Arguments

`$ARGUMENTS`: semver version, e.g. `0.7.5`, or `major`/`minor`/`patch`.

## Version

- Last release: latest git tag (`vX.Y.Z`); confirm it matches the `@musepi/*` catalog entries in root `package.json` and `packages/*/package.json`.
- No version: review commits since last tag; choose major/minor/patch; bump.
- `major`/`minor`/`patch`: bump last tag — major `X+1.0.0`; minor `X.(Y+1).0`; patch `X.Y.Z+1`.

## Run

```bash
bun scripts/release.ts $ARGUMENTS
```

Script automatically:
1. Pre-flight: on `main`; clean working dir; requested version greater than the latest `v*` tag.
2. Update every published `package.json` version plus the release-artifact packages `@musepi/desktop-app`, `@musepi/client-core`, `@musepi/mobile`; other private packages keep their version.
3. Regenerate lockfiles.
4. Update CHANGELOGs: `[Unreleased] → [version] - date`.
5. Run `bun run check`.
6. Commit `chore: bump version to <version>` and tag `v<version>`.
7. Push branch and tag atomically to origin.
8. Watch CI until all workflows pass.

## CI failures

CI failure → script exits with error and prints the retry recipe. Fix, then repeat until CI passes:

```bash
VERSION=<resolved release version, e.g. 0.7.6>
git commit -m "chore: bump version to $VERSION" -m "<what was fixed>"
git tag -f v$VERSION
git push --atomic origin refs/heads/main:refs/heads/main "+$(git rev-parse HEAD):refs/tags/v$VERSION"
bun scripts/release.ts watch
```

Keep the `chore: bump version to vX.Y.Z` subject: CI's `concurrency` block recognizes a release run by that subject and gives it a per-sha, never-cancel group. Push the commit object id into the tag ref as one atomic push; a standalone `git tag -f` + tag push can be pruned by concurrent git maintenance. `watch` re-watches CI for the current commit until all checks pass.
