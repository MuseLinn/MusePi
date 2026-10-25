# Code Quality and Runtime Rules

Load for TypeScript, Bun, shared utilities, logging, and TUI rendering work.

## TypeScript and structure

- Avoid `any` unless no sound alternative exists. Never use `ReturnType<>`; name the actual type.
- Type imports stay at top level. Inline/dynamic type imports are forbidden.
- Dynamic `import()` belongs only at real split points: lazy routes/components, plugin loaders, optional heavy dependencies, or genuine module cycles.
- Inspect installed dependency types rather than guessing external APIs.
- Barrel files prefer `export * from "./module"`, including type-only modules. Remove duplicate ambiguous paths instead of adding named duplicates.
- Class fields use ES `#private`; externally accessible members stay bare. Visibility keywords are allowed only on constructor parameter properties.
- Use `Promise.withResolvers()` instead of manually constructing resolver promises.
- Model prompts live in static `.md` files with Handlebars for dynamic content. Import with `with { type: "text" }`; never assemble prompts in code.
- New built-in capabilities require the six-field seam declaration in their authoritative registry and an anchor in `docs/capability-seams.md`. Always-on capabilities need a stated reason; the default is an overlay-controlled lifecycle.

## Central utilities

Before writing a helper, search `packages/coding-agent/src/utils/`, `@musepi/pi-utils`, `@musepi/pi-tui`, and adjacent domain modules. Extend the central owner rather than forking behavior.

- Git/jj commands go only through `src/utils/git.ts` and `src/utils/jj.ts`.
- Rendering uses `replaceTabs`, `truncateToWidth`, `shortenPath`, `PREVIEW_LIMITS`, and `TRUNCATE_LENGTHS`; do not duplicate string-width or path-display logic.
- Use the shared stream readers unless the protocol requires manual framing (SSE, streaming JSON-RPC).
- If a central capability is missing, add an option or namespace function there and call it.

## Bun first

Prefer Bun APIs; use `node:*` only where Bun has no equivalent. Never spawn a shell for an operation with a direct API.

| Operation | Use |
| --- | --- |
| File text/JSON and writes | `Bun.file()`, `Bun.write()` |
| Simple process execution | Bun Shell `$` |
| Long-running, streaming, or controlled processes | `Bun.spawn()` / `Bun.spawnSync()` |
| Sleep | `Bun.sleep()` |
| Executable lookup | `$which()` from `@musepi/pi-utils` |
| HTTP server | `Bun.serve()` |
| SQLite | `bun:sqlite` |
| Hashes/passwords | `Bun.hash()`, `Bun.password.*`, WebCrypto |
| Module-local paths | `import.meta.dir`, `import.meta.path` |
| JSON5/JSONL | `Bun.JSON5`, `Bun.JSONL` |
| String width/wrapping | `Bun.stringWidth()`, `Bun.wrapAnsi()` |

Use namespace imports for `node:fs`, `node:path`, and `node:os`. Async-only code uses `node:fs/promises`; mixed sync/async code uses `node:fs`. Directory operations may use `node:fs/promises`.

`Bun.write` creates parent directories. In async code, avoid sync file APIs, redundant existence checks, repeated handles for one path, and `Buffer.from(await file.arrayBuffer())`; use `fs.readFile` for binary data. Catch `isEnoent(err)` around the actual read instead of checking existence first.

## Logging

Code reachable from TUI, RPC, SDK, workers, or background runtimes uses `logger` from `@musepi/pi-utils`, never `console.log/error/warn`. Logs rotate under `~/.omp/logs/`.

A standalone CLI command that exits without entering the TUI may write intentional user-facing output to console/process streams. Structured stdout must remain protocol-clean; shared modules need `logger` or an injected output sink.

## TUI sanitization

Every tool-rendered path sanitizes raw content: success, errors, diffs, search results, and streaming previews.

- Tabs become spaces through `replaceTabs()`.
- Lines truncate through shared width helpers and constants.
- Paths use `shortenPath()`.
- Previews use `PREVIEW_LIMITS`, not local numeric limits.

Streaming tool previews cover live events, transcript rebuilds, and merged call/result rendering. Partial-argument decoding and bash `__partialJson` behavior are documented in `modes/controllers/tool-args-reveal.ts`.
