# User-Facing Packages

This page indexes README-only user-facing package CLIs and features that need root docs coverage beyond package-local READMEs/manifests.

## Root-docs policy

- **Include** root docs coverage for package-local CLIs, extension features, dashboards, and benchmark runners that users can run directly or through `musepi`.
- **Exclude explicitly** when a package/crate is internal implementation only; point to the architecture doc that owns it.
- Package READMEs and manifests remain the source of truth for package-local setup and flags; root docs make the feature discoverable and link to exact source paths.
- Internal Rust crates remain covered by native architecture docs unless promoted as standalone user-facing commands or APIs. The contributor-facing map lives at [`native-crates.md`](./native-crates.html); today every `crates/*` entry is internal to `@musepi/pi-natives` and the embedded shell, so [`natives-architecture.md`](./natives-architecture.html) and the surrounding native docs own them.

## Package CLIs and features

### `packages/stats` — local usage dashboard

Sources: [`packages/stats/README.md`](../packages/stats/README.html), [`packages/stats/package.json`](../packages/stats/package.json), [`packages/coding-agent/src/cli/stats-cli.ts`](../packages/coding-agent/src/cli/stats-cli.ts).

- Package: `@musepi/musepi-stats`; bin: `musepi-stats`; main user path: `musepi stats`.
- Feature: local observability dashboard for AI usage statistics from session JSONL logs.
- CLI modes: `musepi stats` starts the dashboard server, opens `http://localhost:3847`, and keeps running; `musepi stats --port <port>` changes the port; `musepi stats --summary` prints a console summary; `musepi stats --json` prints JSON and exits.
- Programmatic API: exports helpers such as `syncAllSessions()` and `getDashboardStats()` for embedding.
- Inputs/storage: reads `~/.musepi/agent/sessions/`; stores aggregates in `~/.musepi/stats.db`.
- Outputs: dashboard metrics and API endpoints including `/api/stats`, `/api/stats/models`, `/api/stats/folders`, `/api/stats/timeseries`, and `/api/sync`.
- Side effects/limits: syncs session files before output; long-running dashboard stops on `Ctrl+C` and closes the stats database.

### `packages/omptype` — schema validation library (package `@musepi/musepi-type`)

Sources: [`packages/omptype/README.md`](../packages/omptype/README.html), [`packages/omptype/package.json`](../packages/omptype/package.json), and the repository [musepi-type authoring guide](./musepi-type-guide.html).

- Package: public `@musepi/musepi-type`; install with `bun add @musepi/musepi-type`; requires Bun 1.3.14 or newer.
- Feature: callable ArkType-compatible schemas with cheap interpreted startup, lazy hot-path compilation, validation errors, defaults and morphs, and JSON Schema emission.
- Public surfaces: `@musepi/musepi-type` for native authoring, `/typebox` and `/zod` for compatibility builders, and `/ark` for the alias-free ArkType compatibility facade.
- Runtime behavior: schema calls return the validated value or `type.errors`; `.assert()` returns the value or throws; `.allows()` performs a boolean check.
- Limits: this is an intentionally focused compatibility surface rather than a complete implementation of every ArkType, TypeBox, or Zod API.

### `packages/typescript-edit-benchmark` — TypeScript edit benchmark

Sources: [`packages/typescript-edit-benchmark/package.json`](../packages/typescript-edit-benchmark/package.json), [`packages/typescript-edit-benchmark/src/index.ts`](../packages/typescript-edit-benchmark/src/index.ts), [`packages/typescript-edit-benchmark/src/runner.ts`](../packages/typescript-edit-benchmark/src/runner.ts), [`packages/typescript-edit-benchmark/src/tasks.ts`](../packages/typescript-edit-benchmark/src/tasks.ts), [`packages/typescript-edit-benchmark/src/report.ts`](../packages/typescript-edit-benchmark/src/report.ts).

There is no package README at this path today; the manifest and CLI entrypoint help are the cited package-local sources.

- Package: private `@musepi/typescript-edit-benchmark`; bin: `typescript-edit-benchmark`.
- Feature: benchmark suite for evaluating coding-agent edit success on TypeScript source-code mutation fixtures.
- CLI: `bun run bench:edit [options]` in source help; package scripts also expose `bun run src/index.ts` through `start`.
- Key inputs: provider/model, thinking level, runs per task, timeout, task concurrency, task IDs, max tasks, fixture directory or `.tar.gz`, edit variant/fuzzy settings, guided mode, retry/turn limits, output path, report format, fixture validation, and required tool-call flags.
- Fixtures: each task directory contains `prompt.md`, `input/`, `expected/`, and `metadata.json`; bundled distribution can use `fixtures.tar.gz`.
- Outputs: markdown or JSON benchmark reports under `runs/` by default, with live progress and optional conversation dumps.
- Side effects/limits: creates the repository `runs/` directory, extracts fixture archives to temp space, and runs agent sessions against copied fixtures; `--check-fixtures` validates fixture structure and exits.

