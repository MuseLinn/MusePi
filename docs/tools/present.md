# present

> Declares existing files as final deliverables for the user; records paths without copying contents.

## Source
- Entry: `packages/coding-agent/src/tools/present.ts`
- Plugin package: `packages/coding-agent/src/plugins/session/tool-present/`
- Key collaborators:
  - `packages/coding-agent/src/tools/tool-ownership.ts` — `present` is owned by the `tool/present` component.
  - `packages/coding-agent/src/presets/standard-profile.ts` — `present` is part of the standard top-level surface.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `files` | `{ path: string; description?: string }[]` | Yes | One or more final deliverables. The plugin's `Config.maxFiles` caps the call (default 8). |

`path` resolves against the session working directory; absolute paths may name files outside it. Every path must be an existing regular file — a missing path, a directory or a non-regular file fails the call instead of presenting a dead link.

## Outputs
A single text result (`Presented <absolute path>` per file) and `details.files` with the resolved absolute paths and optional descriptions. Hosts show presented files after the turn ends; the contents are not copied.

## Failure modes
- Empty path, zero files or more than `maxFiles` — rejected before any filesystem access.
- `file not found` / `not a regular file` — the path is not an existing regular file.