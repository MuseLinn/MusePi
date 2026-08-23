# @musepi/pi-tool-select

Progressive tool disclosure (`select_tools`) for MusePi agents: keep MCP and
other deferrable schemas out of the top-level `tools[]` and load them on
demand, so the model only ever sees the schemas it can actually use this turn.

## Modules

| Module | Purpose |
| --- | --- |
| `partition` | Which tools may be deferred + active-set math. Never-deferred sources: `builtin`, `sdk` |
| `gate` | Is progressive disclosure active for this model? (catalog `deferredToolsMode`, e.g. `kimi`) |
| `ledger` | The loaded-tool set folded from session history — deferred-load markers in past turns decide what is already available |
| `plan` | `planLoad`: three-way split of a `select_tools` request (already loaded / deferrable / refused) |
| `announcement` | Announcement + result rendering for the disclosure flow (`SELECT_TOOLS_TOOL_NAME = "select_tools"`) |
| `types` | Shared types (`ToolSelectModelRef`, gate config, load plan) |

## Usage

The agent loop calls `select_tools` with the tool names the model asks for;
`plan` decides which can load now, `ledger` folds the result back into session
history, and `announcement` renders the change for the transcript.

## Constraints

- Builtin and SDK tools are never deferred — progressive disclosure only
  applies to extension/MCP surfaces.
- The ledger is the source of truth for the loaded set; do not keep a second
  in-memory copy that can drift from session history.
