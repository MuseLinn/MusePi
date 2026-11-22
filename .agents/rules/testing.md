# Testing and Verification

Load before changing behavior, tests, smoke infrastructure, or delivery verification.

## Isolation is mandatory

Tests and smoke runs must never write `~/.musepi/agent/sessions/` or share `%TEMP%/musepi-daemon` with production.

- Placement: a unit test that exercises one module with local fixtures sits next to that module (`src/**/*.test.ts(x)`); suites that compose several modules, drive the GUI, or need shared helpers live in `<package>/test/`. Do not create a third location.
- Run package tests from the package, with the package's own flags: a `bunfig.toml` preload (`apps/desktop` loads the DOM shim there) is read from the working directory, and a wrapper that changes directory but runs bare `bun test` drops the `test` script's `--isolate --timeout=15000`, which gives each file its own happy-dom and localStorage registry. Use `bun run test:desktop [file...]` from the root — it composes `apps/desktop`'s `test` script, so the flags cannot drift — or `bun run test` inside the package; CI's `ci-test-ts.ts` adds `--isolate` for the same reason.
- Real session-storage suites use `test/helpers/isolate-agent-dir.ts`: `isolateAgentDirForTest` in `beforeAll`, `restoreAgentDirForTest` in `afterAll`, with a 30-second hook timeout on Windows. Suites passing an explicit isolated session directory for every write are exempt.
- A temporary cwd only changes the session slug; it does not isolate the session root.
- Manual desktop, daemon, or real-model smoke runs go through `bun scripts/dev-smoke.ts -- <command>`.
- Daemon tests inherit isolated `MUSEPI_DAEMON_DIR` from the bunfig preload. Import daemon paths from owning source modules; never hardcode production paths.

## Test contract

Each new test names an externally observable failure mode and exercises real behavior, state transitions, output/error mapping, or a regression-prone parsing boundary.

Good tests cover transformations, distinct branches, malformed input, precedence, negative contracts, wire/persisted shapes, and real regression reproductions. Do not add static echoes, success passthroughs, wording/default checks, duplicate same-path rows, placeholder assertions, or tests that merely prove code ran.

Prefer contract-level assertions and focused package verification. Assert externally observable behavior (state transitions, output/error mapping, the world after an action), not DOM classes, data attributes, private fields, or "the marker is absent" checks that can flip with an implementation change while the feature stays correct. Do not duplicate the same behavior at multiple abstraction levels. Small low-risk changes need tests only when they protect a real contract or regression-prone edge.

A regression guard must be shown to fail on the unfixed code: reproduce the regression, watch the guard go red for that reason, then revert. A guard that passes both ways guards nothing. For delegated fixes, re-run the gates yourself on the actual tree — a report describes intent, not what landed.

**Mutation control is executable, not remembered.** A guard names its own revert on the test file, and `bun run check:guards-mutation` applies it in a scratch worktree and reports the outcome per guard:

```ts
// @guard: revert apps/desktop/src/styles/gui-chrome.css:869 | color: inherit;
// @guard: test both cards' rows take the recipe's muted tone
```

The pipe carries what the line reads **in the broken build** (empty deletes it), never a copy of the good text — a stored copy goes stale on the first reformat and then either blocks an honest revert or rewrites the wrong line. Outcomes are `caught` (the named test failed with a real diff), `unproven` (timed out, or the suite still passed — a timeout proves nothing about discrimination, and `expect(<DOM node>).toBeNull()` reddens exactly that way), and `error` (the revert could not be applied, or the guard already fails unmodified). Anything but `caught` exits non-zero. It is not in `check:tools`: it takes minutes, needs a browser, and states a fact about a guard rather than about the product.

**Do not assert presence with `toBeNull`/`toBeDefined` on a DOM node.** A failing `expect(querySelector(...)).toBeNull()` makes Bun's reporter serialise the node and stall, so a real failure reads as `timed out` flake; the same holds when the node is held in a variable. Write `expect(node === null).toBe(true)` or `expect(rows.length).toBe(0)`. `scripts/check-dom-assertions.ts` (in `check:tools`) fails on a new occurrence in any `apps/desktop` test file — `test/` and the co-located `src/` suites alike, since the stall depends on the matcher and the received value rather than the directory — against `scripts/dom-assertions-baseline.json`. Re-record with `--write` after paying a file's debt down; the success line names any baseline entry whose file no longer exists.

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

Merge gating is one check: `CI required` aggregates every blocking job and is the only status branch protection needs. Heavy jobs run only when the `changes` job reports a build input, and `scripts/ci-contract.test.ts` fails when a new job is not wired into the gate.

**CI is asynchronous confirmation.** The local gates decide whether the change may land and whether the next piece of work may start; the Actions run is a second confirmation, not a synchronisation point. After a push, read the run's status once and return to other work; come back when it reports a failure. Do not spend a session on `gh run watch`, and never call a run green — or count it as the verification for the change — before it finishes. A run that has not completed is reported as pending.

Use package scripts as the command source of truth. Start with affected contracts and package checks, then run the repository checks required for the deliverable and the original end-to-end scenario.

- Read exit codes and failure counts; never infer success from a diff or another agent's report.
- Evidence must postdate the code it describes. Unchanged code may reuse a recorded run; changed code needs fresh verification.
- Native GUI, OS integration, and real model behavior require their real harness. Web/SSR evidence is not a substitute.
- Classify failures as regression, pre-existing, or environment-limited using baseline comparison and focused reruns. Fix regressions. Report all other failures honestly without claiming the full suite is green.
- A review-loop round limit stops an ineffective strategy, not the obligation to satisfy the request. Correctness, security, data-loss, protocol, and explicitly requested behavior cannot be unilaterally deferred.

A check that dies with a module-resolution error from `node_modules/.bun/...` (for example `Could not resolve "es-toolkit/compat"` inside `verify-generated`) is a stale or partial install, not a regression: run `bun install`, rerun the same command, and confirm the tree stayed clean afterwards, since postinstall regenerates the tool views. If `bun install` itself fails at that resolution in its postinstall, the store is corrupt: run `bun install --force`, and only then remove `node_modules` and reinstall. When another session is working in the same checkout, a clean reinstall would delete its dependencies — report the block instead of racing it. Call the failure environmental only after the rerun passes.

The final report states changed behavior, verification commands and results, and anything not verified.
