# Changelog and Release

Load before editing release notes, versioning, publishing, or committing a user-facing change.

## Changelog ownership

`packages/coding-agent/CHANGELOG.musepi.md` is the only changelog and the release source for the GUI what's-new panel, `/changelog`, OTA notes, and GitHub release body. Do not create per-package changelog files.

New entries go under `## [Unreleased]` as flat `- **title**：body` bullets; `### Added`-style category headings are optional. The what's-new panel counts every top-level bullet in a version and turns the first three bold bullets into highlight cards, so the bold title is the card heading and must stay meaningful on its own. Released sections are immutable. Release tooling normalizes section order and formatting.

Every Chinese bullet has exactly one indented `- EN:` child containing the complete English translation on one line. Do not use a trailing language section. Run `bun run check:changelog-i18n` before release.

Titles describe the user-visible result, not the development process. The first three bold titles in document order become what's-new cards, so put user-facing changes before internal maintenance. Do not include reference-repository provenance, parity language, roadmap codes, cut numbers, review narration, or internal decision history. Mechanism, rationale, rollout, and compatibility details may follow in the body.

Internal issue attribution uses `([#123](https://github.com/MuseLinn/MusePi/issues/123))`; external contributions use the corresponding PR and author link.

## Commands and release

- `bun scripts/check-changelog-voice.ts` checks unreleased titles and runs through `check:tools`.
- `bun run check:changelog-i18n` checks bilingual entry shape.
- `bun run release` performs version bump, changelog finalization, commit, tag, publish, and creation of new unreleased sections.

Run release only when the user requests it. Before release, ensure all user-facing changes since the last release are represented and both changelog checks pass. Publication jobs must require their validation gate in both `needs` and `if`; a gate that does not block publication is not a release guarantee. A release request is explicit authorization for the script's normal commit/tag/publish flow; it does not authorize unrelated Git operations.
