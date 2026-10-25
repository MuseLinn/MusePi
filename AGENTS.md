# MusePi Development Guide

This file is the always-loaded hot path: execution boundaries, repository routing, and rules that apply to most tasks. Load the linked domain rule before work that enters its scope; do not duplicate those rules here.

## Execution and approvals

- Follow the user's current request and preserve unrelated worktree changes. Explicit implementation or “continue” instructions authorize continuous work through the stated scope; do not ask for confirmation again between tasks.
- Ask only when an unresolved answer would materially change requirements, architecture, or risk. Complete independent, well-understood items while an unrelated item is unresolved.
- Auto-approved plans only close the planning interface; the original request determines whether to execute. Subagents require explicit user authorization under the host's rules; otherwise work inline.
- Local reversible edits, focused tests, and read-only investigation do not need approval. Confirm irreversible or security-sensitive actions and effects beyond the local workspace unless the user already authorized that exact action.
- Never commit, merge, push, publish, create a PR, or discard work unless asked. Plan templates and skill workflows never override this rule.
- Never comment on GitHub or create issues unless the user specifies the exact content.
- A blocked or unverified result is reported as such. Existing unrelated failures do not erase completed work, but no failure may be hidden or relabeled as a pass.

## Repository map

| Area | Responsibility |
| --- | --- |
| `packages/coding-agent` | CLI, daemon, session runtime, tools, bundled plugins; default focus when no area is specified |
| `packages/agent` | Agent loop, tool calling, state, compaction |
| `packages/ai` | Provider-neutral LLM streaming client |
| `packages/catalog` | Model catalog, provider descriptors, model identity and thinking policies |
| `packages/client-core` | Shared GUI rendering and client state |
| `packages/desktop-app` | Electron shell and desktop GUI |
| `packages/tui` | Terminal UI and differential rendering |
| `packages/wire`, `packages/collab-proto` | Persisted/wire and GUI/daemon contracts |
| `packages/utils`, `packages/natives`, `crates/pi-natives` | Shared utilities and native operations |

“Agent” in a question about product behavior means `packages/coding-agent`, not the assistant currently answering.

## Rule routing

| Work | Required references |
| --- | --- |
| TypeScript, Bun, shared helpers, logging, TUI output | `.agents/rules/code-quality.md` |
| Packages, generated catalog, workers, capability seams | `.agents/rules/architecture.md` |
| Tests, smoke runs, session/daemon isolation, verification | `.agents/rules/testing.md` |
| Documentation, bilingual pairs, package READMEs, agent-facing docs | `.agents/rules/documentation.md` |
| Changelog and release | `.agents/rules/release.md` |
| GUI design or interaction | `docs/gui-design.md`, `docs/gui-design.zh-CN.md`; dialogs also `docs/gui-dialog-spec.md`, widgets also `docs/gui-widget-spec.md` |
| GUI RPC, lifecycle, implementation gotchas | `docs/gui-implementation.md`, `docs/gui-implementation.zh-CN.md` |
| Extension API or HMR | `docs/extensions-dev.md`, `docs/extensions-dev.zh-CN.md`, `docs/capability-seams.md` |
| i18n architecture | `docs/i18n.md`, `docs/i18n.zh-CN.md` |

The nearest package README and local code/test precedent supply local conventions. Code and runtime behavior outrank prose; update the owning documentation when they change.

## Always-on constraints

- Model identity is `provider/id`, never a bare id. Session model selection stays session-scoped; role effort choices use the selected model's supported ladder, including `auto` when supported.
- Reuse central utilities before adding a helper. Git/jj process execution goes through `packages/coding-agent/src/utils/git.ts` or `jj.ts`.
- Never edit `packages/catalog/src/models.json` directly; change its generator/resolver and regenerate.
- Keep secrets and production user data out of source, tests, logs, and generated artifacts. Tests and smoke runs must never write the production session store or share the production daemon directory.
- User-facing changes update the owning docs, both locales of paired docs, and `packages/coding-agent/CHANGELOG.musepi.md` under `[Unreleased]` with the inline English translation. Released sections are immutable.
- Use `bun check`, never `tsc` or `npx tsc`. Package `package.json` scripts are the command source of truth.
- Commit subjects, when a commit is explicitly requested, are Conventional Commits with a user-visible summary of at most 72 characters and no process jargon.

## Delivery contract

1. Read the actual code and exercise the exposed contract, not only imports or compilation.
2. Run the focused package checks and relevant tests; then run the repository checks required for the deliverable. Record environment-limited and pre-existing failures separately from regressions.
3. Keep evidence scoped to the current tree. A prior run does not prove a later edit; unchanged code may reuse recorded evidence.
4. Do not mark work complete with failing required checks, partial implementation, or unresolved requested behavior. Report precisely what remains instead.
5. Finish with the changed files, behavioral result, verification commands/results, and any unverified native or platform behavior.
