# eval

> Execute Python or JavaScript code in persistent cell-based runtimes.

> **Notice:** Do not shell out to `python -c`/`python -e`, `bun -e`, or `node -e` via the `bash` tool for ad-hoc code execution. Use this tool instead — it gives you persistent state across cells, structured `display()` output, image/JSON capture, and proper cancellation/timeout handling that one-shot `-e`/`-c` invocations cannot provide.

## Source
- Entry: `packages/coding-agent/src/tools/eval.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/eval.md`
- Key collaborators:
  - `packages/coding-agent/src/eval/backend.ts` — backend execution contract
  - `packages/coding-agent/src/eval/agent-bridge.ts` — host-side `agent()` bridge into the subagent executor
  - `packages/coding-agent/src/eval/js/executor.ts` — JS backend adapter
  - `packages/coding-agent/src/eval/js/worker-core.ts` — JS execution, VM context, display/log capture
  - `packages/coding-agent/src/eval/js/shared/prelude.txt` — JS global helper installer
  - `packages/coding-agent/src/eval/js/shared/helpers.ts` — JS filesystem/text/env helper implementations
  - `packages/coding-agent/src/eval/py/index.ts` — Python backend adapter
  - `packages/coding-agent/src/eval/py/executor.ts` — kernel session retention, reset, cleanup
  - `packages/coding-agent/src/eval/py/kernel.ts` — subprocess NDJSON runner protocol, display capture
  - `packages/coding-agent/src/eval/py/prelude.py` — Python helper functions and status events
  - `packages/coding-agent/src/session/streaming-output.ts` — truncation, artifacts, streamed chunks
  - `docs/python-repl.md` — Python kernel/runner internals

## Inputs

Tool parameters are a JSON object with a single `cells` field — an ordered array of cell objects. Each cell is a structured record; there is no `*** Cell` header parsing, no language sniffing, and no implicit single-cell fallback. Cells run in array order; state persists within each language across cells and across tool calls.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cells` | `EvalCellInput[]` | Yes | Cells executed in order. At least one cell is required (`.min(1)`). |

Each `EvalCellInput` (from `evalCellSchema` in `packages/coding-agent/src/tools/eval.ts`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `language` | `"py" \| "js"` | Yes | Backend selector. `"py"` maps to the IPython-style subprocess kernel (`python` backend); `"js"` maps to the persistent JavaScript VM. |
| `code` | `string` | Yes | Cell body, verbatim. JSON-encoded — embed newlines, quotes, and indentation directly; no fences, no headers. |
| `title` | `string` | No | Short label rendered in the transcript (e.g. `"imports"`, `"load config"`). |
| `timeout` | `integer` | No | Per-cell timeout in seconds, clamped to `1..3600`. Defaults to 30 when omitted. |
| `reset` | `boolean` | No | Wipe this cell's language kernel before running. Reset is per-language: a `py` cell's reset does not touch the JS VM and vice versa. Defaults to `false`. |

Minimal example matching the live schema:

```json
{
  "cells": [
    { "language": "py", "title": "imports", "timeout": 10, "code": "import json\nfrom pathlib import Path" },
    { "language": "py", "title": "load config", "code": "data = json.loads(read('package.json'))\ndisplay(data)" },
    { "language": "js", "title": "summary", "reset": true, "code": "const data = JSON.parse(await read('package.json'));\ndisplay(data);\nreturn data.name;" }
  ]
}
```

## Outputs

`execute()` returns one text content block plus any image blocks. `onUpdate` streams the active cell's output and details while it runs.

- Text is stdout/stderr plus model-visible JSON `display()` values and image dimension notes.
- Image-only success reports `(displayed N image(s); no text output)`; a cell with no visible output reports `(no output)`.
- A nonzero backend exit appends `Command exited with code N`, marks the cell `error`, and sets `details.isError`.
- Cancellation returns the captured output or `Command aborted`, with `details.isError=true`.

`EvalToolDetails`:

- `cells`: a one-element `EvalCellResult[]` with `index`, `title?`, `code`, backend `language`, `output`, `status`, `durationMs?`, `exitCode?`, `statusEvents?`, and `hasMarkdown?`.
- `language`: the backend used; `languages`: the distinct backend list. These retain the historical multi-cell-compatible shape, but a current call has one backend.
- `jsonOutputs`: values captured through structured display.
- `images`: present on live updates when images have arrived; final images are content blocks.
- `statusEvents`: deduplicated helper/tool status events.
- `notice`: optional backend notice.
- `meta`: output truncation/artifact metadata supplied by `toolResult(...)`.
- `isError`: set for backend failure or cancellation.

The renderer merges call and result inline, syntax-highlights from the declared language, renders markdown and JSON trees specially, and shows timeout/truncation metadata. `session.allocateOutputArtifact?.("eval")` backs spilled output; `artifact://...` in `meta` reaches the full capture.

## Execution flow

1. `EvalTool` builds a session-specific schema from enabled languages. It is essential, strict, `approval="exec"`, and `concurrency="exclusive"` within one agent session.
2. `execute()` maps `py/js/rb/jl` to `python/js/ruby/julia`, resolves availability, and wraps the single input in the renderer-compatible internal cell list.
3. It obtains the retained executor id from `session.getEvalSessionId?.()` or `defaultEvalSessionId(session)`, allocates the output sink/artifact, and registers the run through `trackEvalExecution?.(...)`.
4. The timeout defaults to 30 seconds. `0` creates no watchdog. Otherwise `IdleTimeout` is combined with tool and session abort signals.
5. `agent()`, `parallel()`, and `completion()` emit pause/resume status operations: time spent in those host bridges does not consume the cell's runtime-work budget. Compute, output, status helpers, and ordinary `tool.*` calls do consume it.
6. The selected backend receives cwd, retained session id, session file, kernel owner, reset flag, callbacks, and cancellation signal.
7. Output chunks stream into an artifact-aware `OutputSink` and live tail. Rich displays are separated into JSON, image, markdown, and status channels.
8. Success, nonzero exit, and cancellation are assembled into the result shapes above. The output sink is finalized even when execution fails.

## Runtime behavior

### JavaScript (`js`)

- Persistent worker VM keyed by `js:${sessionId}`; `reset` recreates the VM and is destructive to concurrent users of that session id.
- Runs under Bun and exposes host globals including `Bun`, `Buffer`, `fetch`, `process`, `require`, `createRequire`, `fs`, and Web Crypto.
- Top-level `await` and bare `return` work through async wrapping.
- Static top-level imports and dynamic imports are rewritten through the local module loader. Local filesystem imports are cache-busted between cells; bare package and scheme/URL imports retain normal cache identity.
- Awaited regions can interleave with another session sharing the executor; synchronous code still blocks the worker event loop.

### Python (`py`)

- Retained kernels are keyed by `python:${sessionId}`, normalized cwd, and interpreter. `python.kernelMode="per-call"` instead creates and shuts down a fresh kernel for each invocation.
- The runner uses one persistent asyncio event loop, so top-level `await` works; `asyncio.run(...)` is invalid there.
- MIME frames support status, PNG, JSON, markdown, plain text, and HTML-to-markdown conversion.
- Interactive stdin is rejected with `Kernel requested stdin; interactive input is not supported.`
- Synchronous blocks use the default executor with copied ContextVars; Python bytecode still contends on the GIL.

### Ruby (`rb`)

- Retained kernels are keyed by `ruby:${sessionId}`, normalized cwd, and interpreter.
- Cells evaluate in persistent `TOPLEVEL_BINDING`; locals, methods, and constants survive. A trailing value is displayed like IRB unless it is nil, an assignment, or a definition.
- Rich display supports the OMP MIME convention and IRuby-compatible MIME hooks, using the shared kernel display pipeline.
- `reset` replaces the retained Ruby kernel.

### Julia (`jl`)

- Retained kernels are keyed by `julia:${sessionId}`, normalized cwd, and interpreter.
- Cells evaluate in persistent `Main`; a value-bearing trailing expression is displayed unless suppressed by statement form.
- Julia's display stack is bridged into the same MIME/status pipeline.
- `reset` replaces the retained Julia kernel.

## Prelude helpers

All enabled runtimes expose equivalent helpers where the language permits:

- `display(value)`, `print(...)`
- `read(path, offset?, limit?)`, `write(path, content)`, `env(...)`, `output(...)`
- `tool.<name>(args)` for a normal session tool call
- `completion(...)`, `agent(...)`, `parallel(...)`, `pipeline(...)`
- `log(message)`, `phase(title)`, `budget`

JS filesystem/bridge helpers are asynchronous; Python, Ruby, and Julia helpers are synchronous. `read()` delegates non-`local://` schemes to the registered read tool, resolves `local://` through injected roots, and reads regular paths relative to cwd. `write()` accepts regular and `local://` paths but rejects other protocol URLs.

`display()` captures JSON-compatible structures, images, markdown, or text according to the backend. Ruby and Julia additionally auto-display eligible final expressions.

### `completion()`

A stateless, tool-free one-shot model call:

- JS: `await completion(prompt, { model?, system?, schema? })`
- Python/Ruby/Julia: keyword form with `model`, `system`, and `schema`
- `model`: `"smol"`, `"default"`, or `"slow"` tier; default is the active/default tier.
- `schema`: JSON Schema for a synthetic `respond` tool; successful structured calls return parsed data.
- Unresolved tier, missing credentials, error/abort stop, empty output, and invalid structured output raise into the cell.

### `agent()`

Runs one subagent through `runStructuredSubagent(...)`:

- JS supports the preferred `await agent(prompt, { agent?, label?, schema?, schemaMode?, isolated?, apply?, merge?, handle? })`; legacy positional slots are still implemented.
- Python/Ruby/Julia use keyword arguments (`schema_mode` outside JS).
- `agent` defaults from the current spawn policy; the selected agent's frontmatter model and settings always apply (there is no per-call model override — `model` is not accepted). `schema` overrides agent/session schemas; `schemaMode`/`schema_mode` chooses `permissive` or `strict`.
- `isolated` requests isolation. `apply` controls whether captured changes are integrated; `merge=false` selects patch mode while the normal setting controls branch mode.
- `handle=true` returns `{ text, output, handle, id, agent }`, optional parsed `data`, and isolation metadata instead of only output/data.
- Eval subagents are one-shot (`keepAlive=false`), are unregistered/disposed after completion, and **do not share the caller's eval executor** (`shareEvalSession=false`). Their code mutations therefore do not appear in the caller's retained VM/kernel.
- Spawn policy, discovered-agent availability, the `task.maxRecursionDepth` gate (default `2`; negative values disable the cap), hard turn budget, subagent failure, strict schema failure, and isolation-apply failure are enforced as cell errors.

`parallel(thunks)` runs zero-argument callables in a bounded pool and preserves input order. `pipeline(items, ...stages)` applies each stage as a barriered wave. Pool width is read live from `task.maxConcurrency`; `0` means all items at once. The lowest-index failure is propagated.

## Side effects and cancellation

- Prelude helpers may read/write files and call arbitrary registered tools; JS exposes network-capable `fetch`.
- Python, Ruby, and Julia use retained subprocess kernels speaking framed local IPC. JavaScript uses a worker VM.
- Retained runtimes survive calls until reset, owner cleanup, or process exit.
- Cancellation is destructive when needed: JS terminates its worker; managed kernels interrupt and may escalate to shutdown. A reset is likewise destructive to concurrent work sharing that backend session.
- Eval-driven `agent()` may run tools and isolated workspaces, but its child is disposed rather than retained for hub follow-up.

## Limits and errors

- Default timeout: 30 seconds; `0` disables. Nonzero timeouts are clamped through `clampTimeout("eval", ..., tools.maxTimeout)`.
- Output sink default window: 50 KiB (`DEFAULT_MAX_BYTES`); live tail: 100 KiB; truncation helpers cap at 3000 lines.
- Each JSON display value included in model-visible text is capped at 8000 characters; the full structured value remains in `jsonOutputs`.
- Transcript preview defaults to 10 lines.
- Eval subagent spawning obeys `task.maxRecursionDepth` (default `2`; negative values allow unlimited depth). Helper fan-out uses `task.maxConcurrency` (default 32, `0` unbounded).
- Malformed params are schema errors; unavailable/disabled backends and missing session are `ToolError`s.
- Runtime exceptions become backend output with nonzero exit. Interactive stdin is an error. Output truncation does not fail the call.
- A dead retained managed kernel may be replaced and the invocation retried once by its executor.

## Notes

- Backend selection is strictly explicit per cell: `language` must be `"py"` or `"js"`. The previous `*** Cell` header parser, the `eval.lark` constrained grammar, and the sniffer-based fallback have all been removed.
- `EvalTool.customFormat` no longer exists. Tool calls flow through the standard JSON schema; there is no Lark-constrained sampling path.
- `tool.<name>()` exists in both JS and Python. Python calls route through a per-run loopback bridge keyed by the current cell id.
- `read()` delegates non-`local://` scheme URIs to `tool.read`, resolves `local://` under its injected root, and resolves plain paths against the session cwd or an absolute filesystem path; `resolveRegularFile()` rejects directory paths. `write()` accepts `local://` and plain paths but rejects any other `scheme://` via `resolveHelperPath()` (`Protocol paths are not supported by write()`).
- Python helper `output(...)` depends on `PI_ARTIFACTS_DIR` or `PI_SESSION_FILE`; it fails outside a session-backed run.
- `display()` can produce text and structured outputs from the same value; the renderer prefers markdown over `text/plain` when both exist.
- JS static imports are rewritten only at top level. Nested imports stay invalid and surface normal JS syntax/runtime errors.
- `EvalTool` is `concurrency = "exclusive"` within one agent session, but parent and subagent sessions can run eval concurrently when they share an inherited executor id.
- The tool description shown to the model is templated by backend availability (`getEvalToolDescription()`); if Python is unavailable, the prompt omits Python-specific instructions.

