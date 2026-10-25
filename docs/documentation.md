---
layout: default
title: Documentation maintenance
status: living
summary: Ownership, progressive disclosure, metadata, bilingual pairing, and pruning rules for MusePi documentation.
scope:
  - docs
  - .agents
  - packages
---

# Documentation maintenance

English | [中文](documentation.zh-CN.md)

This guide owns how MusePi documents are organized and maintained. It applies to product docs, implementation contracts, package guides, and agent-facing instructions. Agent execution rules live in the root `AGENTS.md` and `.agents/rules/`; this page does not duplicate them.

## Assign one owner

Every rule has one authoritative home. Other documents link to it and keep only their local consequence. Before adding a rule, identify its owner rather than appending to the most convenient long file.

| Material | Home |
| --- | --- |
| Always-loaded execution and repository routing | Root `AGENTS.md` |
| Task-specific engineering rules | `.agents/rules/` |
| Reusable agent procedures | `.agents/skills/*/SKILL.md` |
| Product and implementation contracts | `docs/` |
| Module ownership and local invariants | Package README or `DOCUMENTATION.md` |
| Plans, audits, and verification records | `docs/review/` |
| Closed or superseded plans | `docs/archive/` |

Code, scripts, configuration, directory layout, and `--help` already answer many lookups. Document non-obvious contracts, reasons, side effects, and workflows instead of caching facts that can be queried cheaply.

## Use progressive disclosure

Always-loaded text is expensive on every turn. Keep only information every task needs in the root guide, and put branch-specific detail behind a precise pointer that says when to load it. A pointer names both the material and its trigger.

Long documents are not automatically bad. Split one when a reader must repeatedly scan unrelated material, when audiences differ, or when an independent contract can live beside its owning module. Do not split a coherent procedure into fragments that must all be read together.

Each document opens with a reader map: what it owns, what it deliberately excludes, and the related document to consult next. Historical narration belongs in ADRs, changelogs, or archived plans, not at the start of a current-state contract.

## Metadata

New docs and adopted living docs begin with YAML frontmatter:

```yaml
---
layout: default
title: Short document title
status: living
summary: One sentence naming the contract and its audience.
scope:
  - packages/example
  - docs/example.md
---
```

Fields have these meanings:

- `title`: site and reader-facing title; the body still has one H1.
- `status`: `living`, `reference`, `draft`, or `archived`.
- `summary`: one sentence that lets a reader decide whether this page answers the question.
- `scope`: owning code or documentation paths, not a list of every consumer.
- `layout`: `default` for pages rendered by the documentation site.
- `lang`: `zh-CN` on Chinese pages; English pages may omit it.

`living` requires synchronized review when scoped code changes. `reference` is stable background. `draft` is not a current contract. `archived` is historical and receives no living-status updates. Do not add manually maintained “last updated” dates; git owns chronology.

Run `bun scripts/check-docs.ts`. Existing legacy files migrate incrementally, while new files and adopted core docs require valid metadata. Moving a file out of legacy status means adding the metadata, not weakening the checker.

## Prune without losing contracts

Before deleting or moving a passage, preserve every operative proposition: actor, action, condition, order, modality, exception, ownership, side effect, failure mode, and consequence. A shorter document is an improvement only when those facts remain clear.

Remove duplicate rules, stale historical narration, dead design references, review dialogue, and instructions that merely restate the default. Keep non-obvious reasons whose omission would make misuse likely. Never use document length alone as a reason to drop a contract; restructure or link it instead.

## Keep bilingual pairs synchronized

A pair consists of `X.md`, `X.zh-CN.md`, and `X.i18n.yaml`. Both languages carry equal authority and mirrored heading/list/table structure. Update both in the same change and keep their language switchers after the H1.

Use named checks and scoped writes:

```sh
bun run verify-translation-pairing docs/example
bun run verify-translation-pairing --write docs/example
```

The write command records hashes only for the named pair. Do not run an unscoped write merely to clean old debt; it mixes unrelated files into the current change. Temporary or closed documents are removed or archived rather than maintained as living translations.

Agent-only rules under `.agents/` and the explicit exclusions in `scripts/verify-translation-pairing.ts` remain English-only. Every package has an English and Chinese README; legacy exceptions are tracked by `scripts/verify-package-readmes.ts`.

## Change checklist

1. Identify the owning document and its scoped code.
2. Preserve all contracts while removing duplication and stale narrative.
3. Add or update metadata and both languages where required.
4. Update indexes and pointers when ownership or document structure changes.
5. Run `bun scripts/check-docs.ts`, strict named-pair checks, and relevant behavior/documentation gates.
6. Inspect the final file list for unrelated hash or formatting changes.
