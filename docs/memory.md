# Autonomous Memory

[English](memory.md) | [中文](memory.zh-CN.md)

MusePi supports five memory modes. Memory is disabled by default; select one backend via `/settings` or `config.yml`:

| `memory.backend` | Storage and behavior                                                                               | Guide                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `off`            | No memory backend                                                                                  | —                                                       |
| `musemem`        | Project-scoped summaries and lessons, plus opt-in cross-project lessons                            | This page                                               |
| `hindsight`      | Remote, bank-scoped Hindsight memory                                                               | [Hindsight](#hindsight-remote-backend)                  |
| `mnemopi`        | Local Mnemopi SQLite memory                                                                        | [Mnemopi memory backend](./mnemosyne-memory-backend.md) |
| `sharpshooter`   | Friction-gated project decision files (architecture/product/style), consolidated in the background | [Sharpshooter](#sharpshooter-backend)                   |

Enable the MuseMem summary pipeline:

```yaml
memory:
   backend: musemem
```

`memory.backend: local` from an older config selects the same backend and is migrated to `musemem` on load.

## Usage

### What gets injected

At session start, if a consolidated summary or manually captured lesson exists for the current project, it is injected into the system prompt as a **Memory Guidance** block. The summary and lessons share `memories.summaryInjectionTokenLimit`.

If startup consolidation finishes after the first prompt build, the active session's summary snapshot is refreshed. Captured lessons remain pinned to the initial snapshot, so a concurrent `learn` call still affects only later sessions.

### Cross-project lessons

`learn` accepts `scope: "global"` for knowledge that holds outside the current repository — tool behaviour, personal workflow preferences, cross-repo constraints. Those lessons are stored in `memories/_global/learned.md`, separately from every project's `--<cwd>--` directory, and each row records its origin (`_(from <project>, <date>)_`).

- `musemem.globalScope` (on by default) controls the destination; it is provided by the `memory-musemem` plugin, so the row appears only while that backend is selected. With it off, `scope: "global"` is refused with a message naming the setting; the lesson is not silently downgraded.
- Project lessons load first; cross-project lessons follow, and are truncated first when `memories.summaryInjectionTokenLimit` runs out. On conflict, the project lesson wins.
- `/memory clear` clears the current project only; `/memory clear global` clears the shared file.
- `memory://global/learned.md` reads the full cross-project file.

- Treat memory as heuristic context — useful for process and prior decisions, not authoritative on current repo state.
- Cite the memory artifact path when memory changes the plan, and pair it with current-repo evidence before acting.
- Prefer repo state and user instruction when they conflict with memory; treat conflicting memory as stale.

### Reading memory artifacts

The agent can read memory files directly using `memory://` URLs with the `read` tool:

| URL                                    | Content                                                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `memory://root`                        | Compact summary injected at startup                                                                                                      |
| `memory://root/MEMORY.md`              | Full long-term memory document                                                                                                           |
| `memory://root/learned.md`             | Lessons captured by the `learn` tool                                                                                                     |
| `memory://global/learned.md`           | Cross-project lessons (`scope: "global"`), when MuseMem global scope is on                                                               |
| `memory://root/skills/<name>/SKILL.md` | A generated skill playbook                                                                                                               |
| `memory://<memory-id>`                 | Full Mnemopi memory row (working or episodic) with a YAML frontmatter metadata header; only available when `memory.backend` is `mnemopi` |

The `memory://<memory-id>` form returns the full stored row rather than the clipped recall preview (recall content that exceeds the preview cap ends with a trailing `…`); agents are instructed to read it before any `memory_edit update`.

The `memory://root[/…]` rows are file-backed and only exist with `memory.backend: musemem`, which populates the on-disk memory root via the consolidation pipeline. Under `hindsight` or `mnemopi` the root is never written, so those URLs do not resolve — use `recall`/`reflect` (and `read memory://<memory-id>` on `mnemopi`) instead.

### `/memory` slash command

| Subcommand            | Effect                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `view`                | Show the current backend injection payload                                                                               |
| `stats`               | Show backend-specific memory statistics, when supported                                                                  |
| `diagnose`            | Show backend-specific diagnostics, when supported                                                                        |
| `queue`               | Show pending memory deltas awaiting consolidation                                                                        |
| `sync`                | Run memory consolidation now                                                                                             |
| `clear` / `reset`     | Delete the active backend's data for the current project                                                                |
| `clear global`        | Delete only the cross-project lessons (MuseMem)                                                                          |
| `enqueue` / `rebuild` | Force consolidation/retention work for the active backend                                                                |
| `mm …`                | Hindsight mental-model maintenance (`list`/`show`/`refresh`/`history`/`seed`/`delete`/`reload`); unsupported in ACP mode |

### Capturing lessons

Enable `autolearn.enabled` to make the `learn` tool available:

```yaml
autolearn:
   enabled: true
```

With the MuseMem backend active, `learn` saves explicit durable lessons to the project's `learned.md`, or to the shared `_global/learned.md` for `scope: "global"`. Lessons are newest-first, deduplicated, secret-redacted, capped at 100 entries per file, and injected starting with the next session; a `learn` call does not mutate the active session's prompt-cache prefix. Each lesson's content is capped at 2,000 characters and optional context at 400 characters. Structured memory search, `recall`, `retain`, `reflect`, and `memory_edit` are not available for the MuseMem backend.

## How it works

MuseMem summary memories are built by a background pipeline that runs at startup; `/memory enqueue` marks consolidation work that the next startup picks up. The pipeline is skipped for subagents and for sessions that are not persisted to a session file.

**Phase 1 — per-session extraction:** For each past session that has changed since it was last processed, a model reads the session history and extracts durable signal: technical decisions, constraints, resolved failures, recurring workflows. Sessions that are too recent, too old, currently active, or beyond the configured scan/age limits are skipped. Each extraction produces a raw memory block and a short synopsis for that session.

**Phase 2 — consolidation:** After extraction, a second model pass reads all per-session extractions and produces three generated outputs written to disk:

- `MEMORY.md` — a curated long-term memory document
- `memory_summary.md` — the compact text injected at session start
- `skills/` — reusable procedural playbooks, each in its own subdirectory

The separately maintained `learned.md` is not overwritten by consolidation.

Phase 2 uses a lease and heartbeat to prevent double-running when multiple processes start simultaneously. Stale skill directories from prior runs are pruned automatically.

Consolidated output is redacted for common secret/token patterns before `MEMORY.md`, `memory_summary.md`, or generated skills are written to disk.

### Extraction behavior

Memory extraction and consolidation behavior is driven by static prompt files in `packages/coding-agent/src/prompts/memories/`.

| File                      | Purpose                                          | Variables                                   |
| ------------------------- | ------------------------------------------------ | ------------------------------------------- |
| `stage_one_system.md`     | System prompt for per-session extraction         | —                                           |
| `stage_one_input.md`      | User-turn template wrapping session content      | `{{thread_id}}`, `{{response_items_json}}`  |
| `consolidation_system.md` | System prompt for cross-session consolidation    | —                                           |
| `consolidation.md`        | User-turn prompt for cross-session consolidation | `{{raw_memories}}`, `{{rollout_summaries}}` |
| `read-path.md`            | Memory guidance injected into live sessions      | `{{memory_summary}}`, `{{learned}}`, `{{global_learned}}` |

### Model selection

Memory piggybacks on the model role system.

| Phase                   | Role                                                                | Purpose                          |
| ----------------------- | ------------------------------------------------------------------- | -------------------------------- |
| Phase 1 (extraction)    | `default`                                                           | Per-session knowledge extraction |
| Phase 2 (consolidation) | `smol` (falls back to `default`, then current/first registry model) | Cross-session synthesis          |

If the requested memory role is not configured, memory model resolution falls back to the `default` role, then the active session model, then the first model in the registry.

## Configuration

| Setting                               | Default | Description                                                                                                                              |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                      | `off`   | Select `musemem` for this pipeline; legacy `memories.enabled: true` migrates to `musemem`, and `memory.backend: local` migrates to `musemem` on load |
| `musemem.globalScope`                 | `true`  | Let `learn` store `scope: "global"` lessons in `memories/_global/learned.md`, recalled by every project; off keeps every lesson project-local |
| `memories.maxRolloutAgeDays`          | `30`    | Sessions older than this are not processed                                                                                               |
| `memories.minRolloutIdleHours`        | `12`    | Sessions active more recently than this are skipped                                                                                      |
| `memories.maxRolloutsPerStartup`      | `64`    | Cap on sessions processed in a single startup                                                                                            |
| `memories.threadScanLimit`            | `300`   | Maximum recent session records scanned at startup                                                                                        |
| `memories.maxRawMemoriesForGlobal`    | `200`   | Maximum per-session extractions supplied to global consolidation                                                                         |
| `memories.stage1Concurrency`          | `8`     | Concurrent per-session extraction jobs                                                                                                   |
| `memories.stage1LeaseSeconds`         | `120`   | Extraction job lease duration                                                                                                            |
| `memories.stage1RetryDelaySeconds`    | `120`   | Delay before a failed extraction becomes claimable again                                                                                 |
| `memories.phase2LeaseSeconds`         | `180`   | Consolidation lease duration                                                                                                             |
| `memories.phase2RetryDelaySeconds`    | `180`   | Delay before failed consolidation is retried                                                                                             |
| `memories.phase2HeartbeatSeconds`     | `30`    | Consolidation lease heartbeat interval                                                                                                   |
| `memories.rolloutPayloadPercent`      | `0.7`   | Fraction of the selected model's context budget available to rollout payloads                                                            |
| `memories.phase1InputTokenLimit`      | `4000`  | Per-session extraction input cap                                                                                                         |
| `memories.fallbackTokenLimit`         | `16000` | Model token budget used when the model has no finite declared context window                                                             |
| `memories.summaryInjectionTokenLimit` | `5000`  | Shared approximate token cap for the summary and captured lessons injected into the system prompt                                        |
| `memory.idleEnqueueEnabled`           | `false` | Run the active backend's consolidation (the `/memory enqueue` pass) after the session has been quiet for a while                          |
| `memory.idleEnqueueMinutes`           | `60`    | How long the session stays quiet before that pass runs; clamped to 1 minute – 24 hours                                                     |

### Idle consolidation

The memory backends already know what may be folded and when: the `local` pipeline claims only rollouts idle for `memories.minRolloutIdleHours`, and Mnemopi's sleep pass takes only working-memory rows older than half its `MNEMOPI_WM_TTL_HOURS`. What none of them did was decide *when* to ask. `memory.idleEnqueueEnabled` adds that decision to the bundled idle-maintenance plugin, which already owns the quiet-session timers used by idle compaction and the recap: one `agent_end` arms them together, any activity disarms them, and each session keeps its own timers. When the timer fires it calls the same entry point as `/memory enqueue`, so a backend that keeps no background work returns immediately and a run with nothing eligible is a no-op.

It is off by default for two reasons: a backend's consolidation pass can call a model, and consolidation is most useful when it runs on material that has had time to settle, not on the session the user is still in. Turn it on per profile when long-lived sessions are normal — a daemon, a gateway chat, or a bot that stays open for days.

## Hindsight remote backend

Hindsight requires a reachable [Hindsight](https://hindsight.vectorize.io/) server. The default endpoint is `http://localhost:8888`; set a token when the server requires authentication:

```yaml
memory:
   backend: hindsight
hindsight:
   apiUrl: http://localhost:8888
   apiToken: ${HINDSIGHT_API_TOKEN}
```

`HINDSIGHT_*` environment variables override `hindsight.*` settings, which override built-in defaults. See the [complete Hindsight environment-variable table](#hindsight-remote-backend) for all 18 supported overrides, accepted values, parsing rules, precedence, and defaults.

The `hindsight.*` rows in this section are contributed by the `memory-hindsight` plugin. The values remain under the same keys and stay readable when the plugin is not mounted; an absent plugin only removes the settings UI.

By default, Hindsight uses `per-project-tagged` scoping: writes go to a shared bank with a project tag, while recall includes project-tagged and untagged global memories. With `hindsight.globalScope: true` (off by default), `retain` and `learn` accept `scope: "global"` to write such an untagged memory, so a preference or lesson that holds everywhere reaches every project. Recall finds the global fact itself in every project. Per-project mental models refresh with strict project-tag matching, so they never include global memories; the untagged `user-preferences` model does. Consolidation may also fold a global fact into an existing project-tagged observation, so observation results in other projects can miss that consolidated form. A bank configuration that tags extracted facts (an `entity_labels` group with `tag: true`) adds a tag to every fact carrying such a label, and a global fact tagged that way no longer surfaces in other projects. `per-project` isolates each working-directory project in its own bank and does not offer `scope: "global"`; `global` uses one shared bank. An explicit `hindsight.bankId` selects the bank base. Changes to the bank ID, prefix, or scoping rebuild the primary session state so later operations use the new scope.

Both project-scoped modes name the project the same way: take the repository's primary checkout root (so every linked worktree of one repository resolves to the same directory), then lowercase its basename. A checkout at `~/code/General` therefore tags `project:general`. Tags are matched literally, so this fold is what keeps one repository in one memory scope no matter how the path is capitalised.

The primary session recalls on its first model turn (`hindsight.autoRecall: true`) and automatically retains completed conversation turns every three user turns by default. `/memory enqueue` flushes queued tool retains and forces retention of the current session. At agent end, the primary state schedules cadence-based retention and flushes the retain queue; session disposal drains that queue before releasing the state. Request failures and configured timeouts are logged and leave the coding session usable. Subagents alias the parent's client, bank, and scope for explicit `recall`, `retain`, and `reflect` calls, but do not run their own automatic recall or retention.

Tool-initiated `retain` and `learn` writes go through a durable outbox: each memory is written to a private file under `<agentDir>/hindsight-outbox/` (without the bearer token, with recognizable secrets redacted) before the tool reports it queued, and the file is deleted once the server accepts it. Failed deliveries stay on disk and retry with exponential backoff; the next primary session for the same API URL and bank delivers what earlier processes left. Each memory's id doubles as its server `document_id`, so a resend replaces instead of duplicating. Requests the server refuses (HTTP 400, 413, 422), malformed files, and events undelivered for 7 days move to `hindsight-outbox/quarantine/` with a warning and are deleted 30 days later. A 2xx response means server acceptance, not completed extraction. Automatic transcript retention does not use the outbox.

Recall is injected as background context, not instructions, and recalled memory is also available as extra context during compaction. The first-turn recall is stored in the session file, so resuming, switching to, or forking the session sends it unchanged instead of recalling again; a context reset, a different bank or tag filter, or a branch that edits the first prompt recalls afresh. Hindsight memories cannot be looked up by id, so changes to them since the recall are not reported. Mental models are still reloaded when a new process starts. Selecting Hindsight exposes `recall`, `retain`, and `reflect`; `memory_edit` is not available because upstream Hindsight memories are not edited through this backend.

`/memory view`, `/memory stats`, `/memory diagnose`, and `/memory enqueue` operate through the active Hindsight state. `/memory clear` first drains pending retains, then clears only the local session state and recall cache. It **does not delete the server-side bank**; delete that bank with the Hindsight UI or API.

## Mnemopi local backend

Mnemopi is the local SQLite backend: working memory ages into episodic memory, extracted facts form a recallable graph, and recall runs locally with optional ONNX embeddings. It needs no server. It exposes `recall`, `retain`, `reflect`, and `memory_edit`, stores the first-turn recall in the session so a resume does not re-query or change the prompt cache, and reports memories that changed since that recall through a hidden note. See [Mnemopi memory backend](./mnemosyne-memory-backend.md) for scoping, ranking, and its full settings.

## Sharpshooter backend

Sharpshooter keeps three short project decision files — `architecture.md`, `product.md`, and `style.md` — and injects them into the system prompt. It needs no server; files live under `<agentDir>/memories/sharpshooter/<bank>/`, where the bank is derived from the working directory, so each project has its own decisions.

```yaml
memory:
   backend: sharpshooter
sharpshooter:
   minPromptLength: 4
   intervalMinutes: 5
```

**Extraction:** each user prompt in the main session (subagents are skipped) goes to the extraction model, which records durable decisions the user made — architecture, product, and style decisions, constraints, rejected approaches, and corrections — as deltas in a per-session queue. Slash commands and prompts shorter than `sharpshooter.minPromptLength` characters are not sent; a session runs one extraction at a time, and a prompt that arrives while one is running is not extracted. Short replies such as "opt 2" are resolved against the preceding assistant message, but at the default of 16 characters they are too short to be sent — lower `sharpshooter.minPromptLength` to capture them.

**Consolidation:** a scheduler checks every minute and, once `sharpshooter.intervalMinutes` have passed since the last run, applies the queued deltas to the three files in one model pass and removes them from the queue. `/memory enqueue` consolidates immediately; `/memory queue` lists pending deltas and `/memory clear` deletes the project's files and queue.

| Setting                            | Default | Description                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                   | `off`   | Set to `sharpshooter` to enable this backend                                                                                                                                                                                                                                       |
| `sharpshooter.model`               | unset   | Model selector for extraction and consolidation; unset uses the `smol` role                                                                                                                                                                                                        |
| `sharpshooter.minPromptLength`     | `16`    | Prompts shorter than this many characters are not sent for extraction; values below `2` act as `2`. Characters are counted as displayed (one CJK character or emoji is one), the same in every language, so Chinese users may lower it to capture short replies such as "用方案二" |
| `sharpshooter.intervalMinutes`     | `5`     | Minimum minutes between consolidation runs                                                                                                                                                                                                                                         |
| `sharpshooter.injectionTokenLimit` | `15000` | Approximate token cap for the decision files injected into the system prompt                                                                                                                                                                                                       |

## Key files

- `packages/coding-agent/src/memories/index.ts` — pipeline orchestration, injection, clear/enqueue entry points (the `/memory` command routes here via `packages/coding-agent/src/memory-backend/local-backend.ts`)
- `packages/coding-agent/src/memories/storage.ts` — SQLite-backed job queue and thread registry
- `packages/coding-agent/src/prompts/memories/` — memory prompt templates
- `packages/coding-agent/src/internal-urls/memory-protocol.ts` — `memory://` URL handler
