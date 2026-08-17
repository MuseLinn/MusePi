# widget

> Renders an inline interactive widget card in the transcript (kimi inline-widget parity): calculator, slider panel, live quotes, metrics, todo, clock. The tool result carries `{ type, data, title? }`; the GUI's tool-render pipeline renders the shared registry component as a living card.

## Source
- Entry: `packages/coding-agent/src/tools/widget.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/widget.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/board.ts` — `board schema` surfaces the same `WIDGET_TYPES` table.
  - `packages/collab-web/src/widgets/registry.ts` — the shared widget registry (components + defaults) the renderer uses.
  - `packages/collab-web/src/tool-render/tools/widget.tsx` — transcript renderer: inline shell, local data state, error boundary degradation.

## Inputs

| Field | Required | Effect |
| --- | --- | --- |
| `type` | yes | Widget type key (must exist in the registry schema). |
| `data` | yes | Widget payload; merged over the type's defaults. |
| `title` | no | Card title (falls back to the type's i18n name). |
| `data.task` | no | Optional runnable task attached to the card — MUST describe the card's own content (e.g. a ticker card's task refreshes rates); unrelated jobs are not allowed on display cards. |

## Output
- Text summary (`widget · <type>`) in the transcript plus a structured details payload the GUI renders as the interactive card.
- Unknown/stale types degrade to an inline note; a widget render error is caught by the error boundary and never crashes the transcript.
