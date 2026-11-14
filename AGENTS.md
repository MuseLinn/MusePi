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
| `apps/desktop` | Electron shell and desktop GUI |
| `packages/tui` | Terminal UI and differential rendering |
| `packages/wire`, `packages/collab-proto` | Persisted/wire and GUI/daemon contracts |
| `packages/utils`, `packages/natives`, `crates/pi-natives` | Shared utilities and native operations |
| `apps/mobile`, `apps/harmony` | Capacitor mobile app and HarmonyOS WebView shell |
| `tools/metaharness`, `tools/typescript-edit-benchmark` | Developer tooling and benchmarks; never shipped |

Layout: `apps/` holds deployable surfaces, `packages/` holds reusable libraries, `tools/` holds developer tooling. Package names stay `@musepi/*` wherever a package lives, so a directory move never changes an import.

“Agent” in a question about product behavior means `packages/coding-agent`, not the assistant currently answering.

## Rule routing

| Work | Required references |
| --- | --- |
| TypeScript, Bun, shared helpers, logging, TUI output | `.agents/rules/code-quality.md` |
| Packages, generated catalog, workers, capability seams | `.agents/rules/architecture.md` |
| Connector catalog, remote MCP onboarding, OAuth reuse | `docs/connectors.md` |
| Tests, smoke runs, session/daemon isolation, verification | `.agents/rules/testing.md` |
| CI workflows, test sharding, runtime versions, flaky/async tests | `.agents/skills/musepi-ci-test-reliability/SKILL.md` |
| Documentation, bilingual pairs, package READMEs, agent-facing docs | `.agents/rules/documentation.md` |
| Changelog and release | `.agents/rules/release.md` |
| GUI design or interaction | `docs/gui-design.md`, `docs/gui-design.zh-CN.md`; dialogs also `docs/gui-dialog-spec.md`, widgets also `docs/gui-widget-spec.md` |
| GUI RPC, lifecycle, implementation gotchas | `docs/gui-implementation.md`, `docs/gui-implementation.zh-CN.md` |
| Extension API or HMR | `docs/extensions-dev.md`, `docs/extensions-dev.zh-CN.md`, `docs/capability-seams.md` |
| i18n architecture | `docs/i18n.md`, `docs/i18n.zh-CN.md` |

The nearest package README and local code/test precedent supply local conventions. Code and runtime behavior outrank prose; update the owning documentation when they change.

## Always-on constraints

- Model identity is `provider/id`, never a bare id. Session model selection stays session-scoped; role effort choices use the selected model's supported ladder, including `auto` when supported.
- Agent-facing capabilities are designed with the model contract and UI together: review tool schema/description, static prompt guidance, structured results, user rendering, and behavior tests in the same change; if no prompt change is needed, record why.
- Reuse central utilities before adding a helper. Git/jj process execution goes through `packages/coding-agent/src/utils/git.ts` or `jj.ts`.
- Converge on evidence: the same interaction or helper appearing in a second place is a signal, and a third is a defect. Before a fourth copy, extract a named primitive and record its contract in the owning doc; do not build a generic abstraction with fewer than two real consumers. For hover-revealed controls, the contract is hover plus `:focus-visible` (never `:focus-within`) with sibling readouts switching in the same state set — see `docs/gui-design.md`.
- The connector catalog accepts remote `http`/`sse` endpoints, local `stdio` commands, and managed CLI packages; stdio/CLI mount only after per-fingerprint user approval, CLI installs stay in the isolated prefix, enabling a connector is user state, never model state, the agent-facing catalog tool stays read-only, and Token values never leave the encrypted connector secret store.
- Never edit `packages/catalog/src/models.json` directly; change its generator/resolver and regenerate.
- Keep secrets and production user data out of source, tests, logs, and generated artifacts. Tests and smoke runs must never write the production session store or share the production daemon directory.
- For GUI work, hierarchy, restraint, and polish are part of correctness. Avoid unnecessary secondary labels and descriptions; let layout, spacing, typography, and grouping communicate structure. Keep essential guidance and accessible names, remove redundant copy and chrome, and verify the composed interface rather than accepting a functionally complete but cluttered or awkward result.
- User-facing changes update the owning docs, both locales of paired docs, and `packages/coding-agent/CHANGELOG.musepi.md` under `[Unreleased]` with the inline English translation. Released sections are immutable.
- Use `bun check`, never `tsc` or `npx tsc`. Package `package.json` scripts are the command source of truth.
- Commit subjects, when a commit is explicitly requested, are Conventional Commits with a user-visible summary of at most 72 characters and no process jargon.

## Delivery contract

1. Read the actual code and exercise the exposed contract, not only imports or compilation.
2. Run the focused package checks and relevant tests; then run the repository checks required for the deliverable. Record environment-limited and pre-existing failures separately from regressions.
3. Keep evidence scoped to the current tree. A prior run does not prove a later edit; unchanged code may reuse recorded evidence.
4. Do not mark work complete with failing required checks, partial implementation, or unresolved requested behavior. Report precisely what remains instead.
5. Finish with the changed files, behavioral result, verification commands/results, and any unverified native or platform behavior.

<!-- rtk-instructions v2 -->
# RTK

Prefix every shell command with `rtk`: `rtk git status`, `rtk cargo test`,
`rtk npm run build`, `rtk ls src/`. Keep the prefix inside chains:
`rtk git add . && rtk git commit -m "msg"`. Commands RTK has no filter for
run as-is, so the prefix is always safe.

# Command output

Command output here is condensed to save tokens, keeping every signal and
dropping costly noise. Treat it as the complete result: run commands
normally, and batch related commands into one call to avoid extra turns.
Truncated results state their recovery path in their own output. Re-run a
command as `rtk bypass <cmd>` only when its result is unusable: empty when
output was clearly expected, contradicting its exit code, or garbled.

## About RTK

RTK (Rust Token Killer) is a CLI proxy that filters command output to save
tokens; behavior and exit code are unchanged.

- `rtk gain` / `rtk gain --history` — token savings, overall and per command.
- `rtk bypass <cmd>` — run a command unfiltered, still tracked.
- `RTK_DISABLED=1 <cmd>` — skip RTK for one command.
- `rtk discover` — find past commands RTK could have condensed.
<!-- /rtk-instructions -->