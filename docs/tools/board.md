# board

> Reads and edits the desktop kanban boards — the same store the GUI renders (`~/.musepi/boards/boards.json`). Agents design board cards: list boards, read one board, save an edited board, or query the widget schema before authoring widgets.

## Source
- Entry: `packages/coding-agent/src/tools/board.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/board.md`
- Key collaborators:
  - `packages/coding-agent/src/daemon/boards.ts` — board persistence (`readBoards`/`writeBoards`) and validation (known widget types, integer positions, id/title strings).
  - `packages/coding-agent/src/tools/widget.ts` — the widget schema (`WIDGET_TYPES`/`WIDGET_TONES`) this tool exposes via the `schema` action.
  - `packages/collab-web/src/widgets/registry.ts` — the GUI-side widget registry the daemon table mirrors.

## Inputs

One `action` discriminator:

| Action | Fields | Effect |
| --- | --- | --- |
| `list` | — | List all boards (id + title). |
| `get` | `id` | Read one board's full widget layout. |
| `save` | `id`, `board` | Replace a board (`{id, title, widgets}`); validated against the widget schema. |
| `schema` | — | Return the widget type table (types/fields/defaults/tones) for authoring widgets. |

Builtin example boards are protected: a full-list overwrite never drops them (mirrors the daemon `board.save` RPC).

## Output
- Text summary of the affected boards, or the schema table for `schema`.
- Widget data is validated before write; invalid boards are rejected with the failing field.
