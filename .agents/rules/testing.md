# Testing and Verification

Load before changing behavior, tests, smoke infrastructure, or delivery verification.

## Isolation is mandatory

Tests and smoke runs must never write `~/.musepi/agent/sessions/` or share `%TEMP%/musepi-daemon` with production.

- Real session-storage suites use `test/helpers/isolate-agent-dir.ts`: `isolateAgentDirForTest` in `beforeAll`, `restoreAgentDirForTest` in `afterAll`, with a 30-second hook timeout on Windows. Suites passing an explicit isolated session directory for every write are exempt.
- A temporary cwd only changes the session slug; it does not isolate the session root.
- Manual desktop, daemon, or real-model smoke runs go through `bun scripts/dev-smoke.ts -- <command>`.
- Daemon tests inherit isolated `MUSEPI_DAEMON_DIR` from the bunfig preload. Import daemon paths from owning source modules; never hardcode production paths.

## Test contract

Each new test names an externally observable failure mode and exercises real behavior, state transitions, output/error mapping, or a regression-prone parsing boundary.

Good tests cover transformations, distinct branches, malformed input, precedence, negative contracts, wire/persisted shapes, and real regression reproductions. Do not add static echoes, success passthroughs, wording/default checks, duplicate same-path rows, placeholder assertions, or tests that merely prove code ran.

Prefer contract-level assertions and focused package verification. Do not duplicate the same behavior at multiple abstraction levels. Small low-risk changes need tests only when they protect a real contract or regression-prone edge.

Tests must be safe in the full suite:

- Prefer per-test `vi.spyOn()` and `vi.restoreAllMocks()`; avoid persistent mutation of `Bun.*`, `process.platform`, or environment variables when a narrower seam exists.
- Never use `mock.module()`; it leaks through Bun's global registry. Spy on imported module objects instead.
- Trigger real failure paths rather than instantiating errors or inspecting private metadata.
- Do not source-grep implementation text. Test behavior, generated output, runtime wiring, types, or lint-enforced structure instead.
- Exact strings and ordering are asserted only when a consumer depends on those bytes.
- If the project has no tests, do not create a framework or scaffold unless asked.

Production behavior follows RED → GREEN: reproduce the contract failure, watch it fail for the intended reason, implement, then verify. Generated files, configuration, and documentation use their generator, parser, type checker, or behavior check rather than a mechanical unit test for every line.

## Verification and failure reporting

For CI workflows, test sharding, runtime-version drift, or nondeterministic async tests, follow `.agents/skills/musepi-ci-test-reliability/SKILL.md`.

Use package scripts as the command source of truth. Start with affected contracts and package checks, then run the repository checks required for the deliverable and the original end-to-end scenario.

- Read exit codes and failure counts; never infer success from a diff or another agent's report.
- Evidence must postdate the code it describes. Unchanged code may reuse a recorded run; changed code needs fresh verification.
- Native GUI, OS integration, and real model behavior require their real harness. Web/SSR evidence is not a substitute.
- Classify failures as regression, pre-existing, or environment-limited using baseline comparison and focused reruns. Fix regressions. Report all other failures honestly without claiming the full suite is green.
- A review-loop round limit stops an ineffective strategy, not the obligation to satisfy the request. Correctness, security, data-loss, protocol, and explicitly requested behavior cannot be unilaterally deferred.

The final report states changed behavior, verification commands and results, and anything not verified.
