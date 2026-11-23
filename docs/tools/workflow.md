# workflow

> Runs a model-authored JavaScript orchestration that delegates to subagents and returns the script's value.

## Source
- Entry: `packages/coding-agent/src/tools/workflow.ts`
- Plugin package: `packages/coding-agent/src/plugins/session/tool-workflow/`
- Key collaborators:
  - `packages/coding-agent/src/tools/eval.ts` — the session JS kernel; the workflow script runs there, so `agent()` / `parallel()` / `pipeline()` / `tool.<name>()` are the same APIs `eval` exposes.
  - `packages/coding-agent/src/tools/tool-ownership.ts` — `workflow` is owned by the `tool/workflow` component.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Short kebab-case workflow name used in the result details. |
| `description` | `string` | No | One-line description of what the workflow does. |
| `script` | `string` | Yes | Plain JavaScript body (not TypeScript, no `export const meta`). Top-level await/return are allowed. |
| `args` | `object` | No | JSON object exposed to the script as the `args` global. |

The script has the eval kernel globals: `args`, `agent(prompt, options)` for subagents, `parallel(thunks)`, `pipeline(items, ...stages)`, `log(message)`, `phase(title)`, `budget`, and `tool.<name>(args)`.

## Outputs
The kernel's text output, capped at the plugin's `Config.maxResultChars` (default 50000), with `details.name` and `details.description`. A failed or cancelled run reports the failure (or `isError`) instead of returning partial success.

## Limits
Use it when the user explicitly asks for a workflow or large multi-agent orchestration; one or two plain `task` calls are cheaper. Background execution is not exposed by this tool; the underlying eval cell may auto-background according to the host's eval policy.