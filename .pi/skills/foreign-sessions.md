---
description: >-
  Scan and resume sessions from other AI coding agents (Claude Code, Codex) within MusePi.
  Sessions appear in the session picker with a [claude] or [codex] badge.
---

# Foreign Session Import

MusePi can scan session files from other AI coding tools and show them in the
built-in session picker, alongside native MusePi sessions. This lets you resume
work started in another tool without manually exporting and importing.

## Supported Agents

| Agent | Format | Scanner | Resume |
|-------|--------|---------|--------|
| Claude Code | JSONL (`~/.claude/projects/`) | `claude-scanner.ts` | ✅ Auto-convert |
| Codex (OpenAI) | SQLite (`~/.codex/state/`) | `codex-scanner.ts` | ❌ List only |

## Enabling

Foreign session scanning is opt-in. Enable it via the compat settings:

```json
{
  "musepi": {
    "compat": {
      "scanClaudeSessions": true,
      "scanCodexSessions": true
    }
  }
}
```

Or use the `/setup` wizard, which walks through enabling scanners and
importing Claude Code configuration.

## Commands

- `/import-claude` — Import MCP servers and skills from Claude Code
  configuration (`~/.claude/settings.json`). Shows a checkbox selector
  so you pick only the items you want.
- `/setup` — Step-by-step wizard covering provider setup, session scanning,
  and Claude Code import.

## Files

| File | Purpose |
|------|---------|
| `foreign-sessions/claude-scanner.ts` | Scans `~/.claude/projects/` for `.jsonl` session files |
| `foreign-sessions/codex-scanner.ts` | Scans `~/.codex/state/` for SQLite session databases |
| `foreign-sessions/claude-converter.ts` | Converts Claude JSONL → MusePi JSONL format |
| `foreign-sessions/import-claude.ts` | Reads Claude settings (MCP servers, skills) |

## Configuration

Settings live under `musepi.compat` in `settings.json`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `loadPiExtensions` | boolean | false | Load extensions from `~/.pi/agent/extensions/` |
| `scanClaudeSessions` | boolean | false | Show Claude Code sessions in picker |
| `scanCodexSessions` | boolean | false | Show Codex sessions in picker |
