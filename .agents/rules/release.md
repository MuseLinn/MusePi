# Changelog and Release

Load before editing release notes, versioning, publishing, or committing a user-facing change.

## Changelog ownership

`packages/coding-agent/CHANGELOG.musepi.md` is the only changelog and the release source for the GUI what's-new panel, `/changelog`, OTA notes, GitHub release body, and the generated GitHub Pages changelog. Do not create per-package changelog files.

New entries go under `## [Unreleased]`, filed under one of three category headings in this order:

```markdown
### 新功能
### 改进
### 修复
```

`新功能` is a capability the user did not have; `改进` changes existing behaviour, ergonomics or performance; `修复` restores behaviour that was supposed to work. Categorizing means moving an existing bullet; do not rewrite its title or body to fit a heading. A bullet directly under `## [Unreleased]`, or under any other heading, fails `bun scripts/check-changelog-categories.ts`. Those headings are the only structure release notes have: `release.ts` renames the section in place, so the categories ship as written, and released sections are immutable — never back-fill categories into them.

Consumers recognize both languages: the what's-new cards, the startup summary and the OTA notes read the Chinese `### 新功能` / `### 改进` / `### 修复` headings above as well as the English `### Added` / `### Changed` / `### Fixed` headings older sections already ship with. Author new entries under the Chinese headings; leave a released section's existing English headings untouched.

`scripts/render-release-notes.ts` is the single source of the GitHub release body. For the tagged version it keeps the platform download table, drops the duplicated `## [version] - date` heading, adds the counts line `本次发布：N 项新功能 · M 项改进 · K 项修复`, then the categorized entries and links to the full changelog and to the comparison against the next older release. The renderer requires the tag's `## [version]` section and refuses a tag that does not equal `v<version>` (`--tag` alone derives the version, and the workflow passes the app package version so a mismatched tag fails the job), so finalize the changelog before tagging instead of publishing another release's notes. The OTA `update-manifest.json` notes come from the same script as the version heading, counts line and categorized entries; the update dialog clamps to about 200 characters, so that head must name the release and its category breakdown. The download table and the footer links belong to the release page only. The default repository's full-changelog link points to the generated Pages changelog; a custom repository keeps its GitHub blob link.

`scripts/build-site-changelog.ts` renders every released section through `listReleaseSections` into the ignored `web/changelog.html`; do not commit that output or hand-maintain a second page. The Pages workflow runs the generator before overlaying `web/`. The newest release starts open, all versions use independent native `details` disclosures, and the expand/collapse-all button keeps `aria-expanded` synchronized. Preserve the nested English entries when changing the renderer.

The what's-new panel counts every top-level bullet in a version and turns the first three bold bullets into highlight cards, so the bold title is the card heading and must stay meaningful on its own. Release tooling normalizes section order and formatting.

Every Chinese bullet has exactly one indented `- EN:` child containing the complete English translation on one line. Do not use a trailing language section. Run `bun run check:changelog-i18n` before release.

Titles describe the user-visible result, not the development process. The first three bold titles in document order become what's-new cards, so put user-facing changes before internal maintenance. Do not include reference-repository provenance, parity language, roadmap codes, cut numbers, review narration, or internal decision history. Mechanism, rationale, rollout, and compatibility details may follow in the body.

Internal issue attribution uses `([#123](https://github.com/MuseLinn/MusePi/issues/123))`; external contributions use the corresponding PR and author link.

## Commands and release

- `bun scripts/check-changelog-categories.ts` checks that every `[Unreleased]` entry is filed under the three categories and runs through `check:tools`.
- `bun scripts/check-changelog-voice.ts` checks unreleased titles and runs through `check:tools`.
- `bun run check:changelog-i18n` checks bilingual entry shape.
- `bun scripts/render-release-notes.ts --tag vX.Y.Z` renders the release body and, with `--ota-out`, the OTA notes; the GUI release workflow calls it.
- `bun run release` performs version bump, changelog finalization, commit, tag, publish, and creation of new unreleased sections.

Run release only when the user requests it. Before release, ensure all user-facing changes since the last release are represented and every changelog check passes. Publication jobs must require their validation gate in both `needs` and `if`; a gate that does not block publication is not a release guarantee. A release request is explicit authorization for the script's normal commit/tag/publish flow; it does not authorize unrelated Git operations.
