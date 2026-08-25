# Bilingual documentation

English | [中文](README.zh-CN.md)

MusePi's user-facing and project documentation is maintained in English and
Simplified Chinese, mirroring the dsh convention and the repo's existing
package-README rule (`README.md` + `README.zh-CN.md`, enforced by
`scripts/verify-package-readmes.ts`). This page defines the pairing contract,
the gate, and the progressive rollout policy.

## The pairing contract

- **Both languages carry equal authority.** A document may be authored in
  either language first; the counterpart is translated from it. Neither file
  outranks the other; what binds them is that they must say the same thing.
- **A pair is three sibling files.** The English `foo.md`, the Chinese
  `foo.zh-CN.md`, and a consistency record `foo.i18n.yaml`, all in the same
  directory. No locale directories, no interleaved bilingual files.
- **The consistency record.** `foo.i18n.yaml` holds the git blob hash of each
  side at the last confirmed-consistent state:
  ```yaml
  foo.md: 3f786850e387550fdab836ed7e6dc881de23001b
  foo.zh-CN.md: 89e6c98d92887913cadf06b2adb97f26cde4849b
  ```
  Blob hashes (not commit hashes) so the record is computable for files edited
  in the same PR and consistency is a pure content comparison.
- **Language switcher.** The English side links to the Chinese side right
  after its heading: `English | [中文](foo.zh-CN.md)` (or the equivalent inline
  HTML, as READMEs use). The Chinese side reciprocates with
  `[English](foo.md) | 中文`. Jekyll's relative-links plugin rewrites `.md`
  links to `.html` on the Pages site.
- **Structure mirrors the counterpart.** Heading order, list kinds, table
  dimensions, and code blocks match across the pair. A PR that edits one side
  updates the counterpart in the same PR.

## The gate: verify-translation-pairing

`bun run verify-translation-pairing` enforces the mechanical contract:

1. Every in-scope document has a complete pair (`.md` + `.zh-CN.md`).
2. Every existing pair is consistent: both sides present, each side's current
   blob hash equals the recorded one (editing either side without re-confirming
   the pair goes red), and both sides carry their language switchers.

Usage:

- `bun run verify-translation-pairing` — corpus-wide status report (never
  fails; missing pairs are listed so translation can land incrementally).
- `bun run verify-translation-pairing <stem...>` — strict check of named pairs
  (fails on violation); a pair is named by any of its three files or its bare
  stem.
- `bun run verify-translation-pairing --write <stem...>` — record blob hashes
  for named pairs; `--write --all` records every complete pair.

## Scope and exclusions

**Scope**: every markdown under `docs/**`, plus the root `index.md` and
`README.md` (and their `.zh-CN.md` counterparts).

**Excluded** (never paired; the gate rejects a `.zh-CN.md` or `.i18n.yaml`
for them):

- `docs/AGENTS.md`, `docs/CLAUDE.md` and other agent-instruction files —
  maintained in English only.
- `docs/skills/examples/**/README.md` — standalone sample projects, not docs.

**Universal requirement**: every current or future document in scope merges
as a complete bilingual pair. There is no per-file rollout list.

## Progressive rollout

The corpus is large (147 files as of 2026-08-25) and historically
single-language. Translation lands incrementally:

1. The corpus-wide report lists `missing-pair` rows; it does not gate CI.
2. Named-pair checks are strict, so an edited pair cannot silently go stale.
3. Priority order for new pairs: user-facing docs (settings, keybindings,
   environment-variables, session ops, tools), then the living specs
   (gui-design, gui-implementation, i18n), then the rest.
4. Internal design/plan documents that are obsolete or already closed are
   deleted rather than translated (see the 2026-08-25 cleanup: upstream-sync,
   extension-hmr-v2-plan).
