# MusePi

<p>
  <a href="https://github.com/MuseLinn/MusePi/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/MuseLinn/MusePi/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://muselinn.github.io/MusePi/"><img alt="Site" src="https://img.shields.io/badge/site-muselinn.github.io%2FMusePi-0e5f4e?style=flat-square" /></a>
  <a href="https://github.com/MuseLinn/MusePi/releases"><img alt="Release" src="https://img.shields.io/github/v/release/MuseLinn/MusePi?style=flat-square" /></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
</p>

MusePi is a fork of the [pi agent harness](https://github.com/earendil-works/pi)
with the muselinn feature set layered on top. See [CHANGELOG.md](CHANGELOG.md).

## Quick install

```sh
npm install -g @musepi/coding-agent
musepi --version    # => MusePi 0.2.10
```

Requires **Node.js 22+**. Config, sessions, and auth live under `~/.musepi`.

## Key features

- **OMP-aligned controllers** — EventController, StreamingReveal, ToolArgsReveal
  extracted from InteractiveMode. Full TTSR support (text + AST rules via `@ast-grep/napi`),
  abort/retry cycle, and configurable tool card style (bordered/filled).
- **Background Advisor** — passive watcher loop with emission guard, config,
  WATCHDOG.yml discovery, transcript recording, and secret obfuscation.
- **BTW (By The Way)** — side-channel `/btw <question>` panel with streaming
  answer, copy to clipboard, branch to session, and braille spinner animation.
- **i18n framework** — `t()` lookup with `en-US` / `zh-CN` locale files. Language
  selector in Settings → General. UI strings migrate incrementally.
- **Hashline editing** — robust tag-anchored diffs (`@musepi/core/hashline`).
- **Long-term memory** — MiMo-style markdown memory with BM25 recall.
- **TTSR** — stream rules with regex + ast-grep conditions, scoped buffering,
  injection tracking, and auto-interrupt/retry.
- **Native advisor & MCP** — second-opinion AI review, MCP server management.
- **Session extras** — `/move`, `snapcompact`, `toolSelect`, `modelRoles`.
- **Independent home** — `~/.musepi`, migrates from `~/.pi/agent` on first run.

## Packages

| Package | Description |
|---|:---|
| **[@musepi/coding-agent](packages/coding-agent)** | Interactive CLI (`musepi` command) |
| **[@musepi/pi-ai](packages/ai)** | Unified multi-provider LLM API |
| **[@musepi/pi-agent-core](packages/agent)** | Agent runtime |
| **[@musepi/pi-tui](packages/tui)** | Terminal UI library |
| **[@musepi/core](packages/musepi/core)** | Orchestration core (goal/plan/permission/swarm/task) |
| **[@musepi/transcript](packages/musepi/transcript)** | Transcript layer |

## Upstream policy

MusePi tracks `earendil-works/pi` with a **pin + monthly cherry-pick** — no
continuous rebase. See [UPSTREAM.md](UPSTREAM.md).

## License

MIT — see [LICENSE](LICENSE). Built on [pi](https://github.com/earendil-works/pi)
by [@badlogicgames](https://github.com/badlogicgames) and the earendil-works
contributors.
