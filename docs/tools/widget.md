# widget

> Renders an inline interactive widget card in the transcript (kimi inline-widget parity): calculator, slider panel, live quotes, metrics, todo, clock. The tool result carries `{ type, data, title? }`; the GUI's tool-render pipeline renders the shared registry component as a living card.

## Source
- Entry: `packages/coding-agent/src/bundled-plugins/visuals/index.ts` (built-in Cordis plugin `musepi-visuals`)
- Tool implementation: `packages/coding-agent/src/bundled-plugins/visuals/tool.ts`
- Model-facing prompt: `packages/coding-agent/src/bundled-plugins/visuals/prompt.md`
- Trigger rule (single source): `packages/coding-agent/src/bundled-plugins/visuals/when.ts`
- Key collaborators:
  - `packages/coding-agent/src/tools/board.ts` — `board schema` surfaces the same `WIDGET_TYPES` table.
  - `packages/client-core/src/widgets/registry.ts` — the shared widget registry (components + defaults) the renderer uses.
  - `packages/client-core/src/widgets/page-kit.ts` — the stylesheet and ready-class list every `page` face receives.
  - `packages/client-core/src/tool-render/tools/widget.tsx` — transcript renderer: inline shell, local data state, error boundary degradation.

## Prompting the model

Capability alone does not make an agent call a tool. The "when to visualize"
rule lives in `visuals/when.ts` and is rendered into TWO readers:

1. the `widget` tool description (`prompt.md` carries a marker, `tool.ts`
   expands it), and
2. the **system prompt** (`system-prompt.md`, `# Visual answers`), gated on
   `{{#if (includes tools "widget")}}` so a session without the tool never
   receives instructions to call it.

`buildSystemPrompt` supplies `widgetRenderWhen` from the same constant.
Stated only in the tool description the rule went unread: asked for a
breakdown of lines of code per package, an agent answered with a list and
drew the chart only when asked. The rule also names its own limits (no widget
for two numbers, short lists, code, or a plain-text request; at most one page
per answer; never restate what the card already shows) — a rule without
limits turns every answer into a card.

Contract: `packages/coding-agent/test/visual-prompt.test.ts`.

## Inputs

| Field | Required | Effect |
| --- | --- | --- |
| `action` | no | `card` (default) draws a structured widget; `page` draws one self-contained HTML page. |
| `type` | card | Widget type key (must exist in the registry schema). |
| `html` | page | The page document; receives the page kit, theme tokens, and `musepiSubmit`. |
| `data` | no | Widget payload; merged over the type's defaults (and injected into a page as `window.musepiWidgetData`). |
| `title` | no | Card or page title (falls back to the type's i18n name). |
| `data.task` | no | Optional runnable task attached to the card — MUST describe the card's own content (e.g. a ticker card's task refreshes rates); unrelated jobs are not allowed on display cards. |

## Output
- Text summary (`widget · <type>`) in the transcript plus a structured details payload the GUI renders as the interactive card.
- Unknown/stale types degrade to an inline note; a widget render error is caught by the error boundary and never crashes the transcript.
