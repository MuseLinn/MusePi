# Documentation Maintenance

Load when editing documentation, agent instructions, skills, READMEs, or user-visible contracts.

## Information ownership

Keep each rule in one authoritative place. Other documents link to it and describe only local consequences. Code, configuration, package scripts, directory layout, and `--help` are already sources of truth; docs should capture non-obvious contracts, reasons, and workflows rather than cache easily queried facts.

Use progressive disclosure:

- Root `AGENTS.md`: only always-loaded execution boundaries, project routing, and cross-cutting constraints.
- `.agents/rules/`: detailed English-only engineering rules loaded by task domain.
- `.agents/skills/*/SKILL.md`: reusable procedures with trigger-focused frontmatter; large task-specific references live beside the skill.
- `docs/`: current product/implementation documentation. Planning and audit records belong in `docs/review/`; closed plans belong in `docs/archive/` and receive no living-status updates.
- Package-local README/`DOCUMENTATION.md`: module ownership and invariants that do not belong in the root guide.

Do not create summary/handoff documents as repository deliverables unless requested. Scratch plans and reports stay in ignored work areas.

## Living-document metadata

`docs/documentation.md` and its Chinese pair own the metadata schema, status meanings, splitting criteria, and change checklist. New docs and adopted living docs require `title`, `status`, `summary`, and `scope`; do not add manually maintained dates.

Run `bun run check:docs`. Moving a document out of legacy debt requires valid frontmatter, not a weaker checker. The opening body gives a reader map and omits historical narration.

## Bilingual pairs

A paired document consists of `X.md`, `X.zh-CN.md`, and `X.i18n.yaml`. Both languages have equal authority and mirrored structure. Agent-only instructions under `.agents/` and explicit exclusions in `scripts/verify-translation-pairing.ts` stay English-only.

- Update both languages in the same change whenever the final state retains a pair.
- Keep language switchers immediately after the H1.
- Use `bun run verify-translation-pairing <stem...>` for strict named-pair checks.
- After confirming semantic parity, record only the edited pairs with `bun run verify-translation-pairing --write <stem...>`.
- Corpus-wide report mode is informational; never mix unrelated historical hash refreshes into a task.
- Temporary or closed documents should be removed or archived, not translated as living docs.

Every package under `packages/` has `README.md` and `README.zh-CN.md`. Existing exceptions live only in `scripts/verify-package-readmes.ts`; translating one removes its exception.

## Writing contract

Preserve every operative proposition when pruning: actor, action, condition, timing, modality, exceptions, ownership, side effects, failure modes, and consequences. Shorter is not better if a contract disappears.

Current-state docs describe how the system works, not how a change happened. Remove dead design-session references, review dialogue, phase labels, speculative generalities, and control-flow narration. Changelogs and ADRs are the appropriate homes for history and rationale.

GUI behavior updates both `docs/gui-design*` and `docs/gui-implementation*` as applicable. Extension API changes update `docs/extensions-dev*`. Model-visible prompt and UI text changes need behavior or snapshot evidence.
