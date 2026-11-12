# notify_user

> Post a progress update into the conversation without ending the turn.

## Source
- Entry: `packages/coding-agent/src/tools/notify-user.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/notify-user.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/index.ts` — registers the tool and gates it behind the `notifyUser` setting.
  - `packages/coding-agent/src/config/settings-schema.ts` — defines the default-on toggle.
  - `packages/client-core/src/components/transcript/round-collapse.ts` — exempts the carrier row from round folds and splits tool runs around it.
  - `packages/client-core/src/tool-render/tools/notify-user.tsx` — renders the title as the card summary and the message as prose.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | `string` | Yes | One-line headline. No markdown, no trailing period. |
| `message` | `string` | Yes | Chat-style update: evidence, findings, next step. |

## Outputs
The tool returns a single text result plus structured details:

- text body: `Progress update shown to the user. Continue the task; do not restate the update in your final answer.`
- `details`:
  - `title: string`
  - `message: string`

## Flow
1. `BUILTIN_TOOLS.notify_user` constructs the tool only when `notifyUser` is on; the tool set is fixed at session creation, so the toggle applies to sessions created after it.
2. The assistant's tool-call entry is the transcript row: the renderer shows `title` + `message`, and the card stays open instead of auto-folding.
3. `round-collapse` treats the carrier as turn content: it is exempt from a closed round fold, is excluded from the 活动 tool count, and breaks tool runs so the update never collapses into an aggregated summary line.
4. The tool does not persist anything separately — the wire entry is both the visible row and the model's record of what it told the user.
