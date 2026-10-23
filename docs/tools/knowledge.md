# knowledge

> Read and write the project's knowledge: notes, todos and plans.

## Source
- Entry: `packages/coding-agent/src/tools/knowledge.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/knowledge.md`
- Collaborators:
  - `packages/coding-agent/src/knowledge/store.ts` — the storage contract for all three kinds (notes dir, todos JSON file, plans dir) plus project addressing and optimistic concurrency.
  - GUI panel "项目知识" — renders the same store; the tool and the panel are two views of one dataset.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `action` | `"list" \| "save" \| "delete" \| "show"` | Yes | Operation to apply. |
| `kind` | `"note" \| "todo" \| "plan"` | For `save`/`delete`/`show` | Which knowledge kind. `show` requires `"plan"`. |
| `id` | `string` | For `delete`/`show`, and to replace a note or plan | Item id, as reported by `list`. |
| `body` | `string` | For note/plan saves | Note text, or the whole markdown document for a plan (must start with a `# title` line). |
| `text` | `string` | To create a todo | Todo label. |
| `done` | `boolean` | No | Todo completion state; may be sent alone (with `id`) to tick without retyping the label. |
| `directory` | `string` | No | Absolute path of the project to address. Defaults to this session's workspace. Mutually exclusive with `projectId`. |
| `projectId` | `string` | No | Project id as reported by `list` (alternative to `directory`). |
| `expected` | `string` | No | The exact note or plan text the caller last read; a mismatch fails the save instead of overwriting. Notes and plans only, and only when `id` is set. |

## Outputs
Returns a single-shot tool result.

- `list` — one text block for the whole project:
  - `project <slug>`, then `## notes (n)`, `## todos (n)`, `## plans (n)` sections;
  - notes are `- <id> "<title>" — <80-char preview>`;
  - todos are `- <id> [x| ] <text>`;
  - plans report their **path**, not their body: `- <id> "<title>" (<done>/<total> steps) — <path>`.
- `save` — `created note <id>` / `updated note <id>` / `created todo <id>: <text>` / `updated todo <id> [x| ] <text>` / `saved plan <id> "<title>" (<done>/<total> steps) — <path>`.
- `show` — the plan body as text, plus `details.showPlan = { id, title, directory }` so the GUI panel opens the plan in front of the user.
- `delete` — `deleted <kind> <id>`.
- `details` always carries `{ action, projectId }` and, when exactly one item changed, its `id`; todo saves also mirror the new state in `details.todo` so the panel checkbox follows without a refetch.

## Flow
1. `resolveProject(params, session.cwd)` picks the target project: `directory` or `projectId` if given (both together is refused), else the session's workspace; everything keys on the project slug.
2. `action: "list"` runs `listNotes`, `listTodos`, `listPlans` in parallel and formats the combined answer. Plans are listed by path because a plan is a markdown file the agent continues to work on with its own file tools.
3. `action: "show"` loads the plan and returns its body; `details.showPlan` tells the panel to open it for the user.
4. `action: "delete"` validates the id with `isValidKnowledgeId` and removes the row; a missing id throws.
5. `action: "save"`:
   - `expected` on a create is rejected early (nothing to compare against), and on a todo (todos patch only named fields).
   - notes: `id` set → `updateNote(projectId, id, body, expected)`; otherwise `createNote`.
   - todos: `id` set → `updateTodo` with only the named fields; otherwise `createTodo` (requires `text`).
   - plans: the body must open with `# title` (`/^\s*#\s+\S/`), then `savePlan(projectId, body, id, expected)` writes the document and derives the title and step counters.

## Modes / Variants
- One tool with a `kind` discriminator instead of three tools, because notes, todos and plans are one concept ("things this project remembers").
- Cross-project addressing: a session may read or write another project's knowledge by `projectId` or `directory`; the slug is the identity, so no filesystem path of the other project is needed.
- The GUI panel and headless sessions (scheduled tasks, dispatched subagents) share the same store — panel edits are visible to the tool and vice versa.

## Side Effects
- Filesystem (under `getAgentDir()`):
  - notes: `<agentDir>/notes/<slug>/<id>.md`
  - todos: `<agentDir>/todos/<slug>.json`
  - plans: `<agentDir>/plans/<slug>/<id>.md`
- GUI: `show` opens the plan in the panel; `details.todo` keeps the panel checkbox in sync.

## Limits & Caps
- Plans must start with a `# title` line; the title is derived from it (no separate title field).
- `expected` optimistic concurrency applies to notes and plans only, and only when replacing (`id` set).
- `directory` and `projectId` are mutually exclusive because they can disagree.
- `list` previews note bodies at 80 characters; plans never return their body from `list` — read the file at the reported path.

## Errors
- `show requires kind=plan` / `show requires id` / `no plan with id <id>`.
- `delete requires kind` / `delete requires id` / `invalid id` / `no <kind> with id <id>`.
- `save requires kind`; `save a todo requires text`.
- `expected requires an id: pass the id you are replacing, or leave expected out to create`.
- `expected applies to notes and plans; a todo save changes only the fields it names`.
- `A plan starts with a # title line` when the plan body has no leading `#` heading.
- Store-level conflicts surface when `expected` text no longer matches the stored note/plan.

## Notes
- Plans are markdown files on disk: after `save`, continue editing with the regular file tools (`read`/`edit`) at the returned path; step counters (`<done>/<total>`) are recomputed from checkbox-style list items.
- Todos support partial updates: send only `done` to tick, only `text` to relabel.
- For cross-session long-term memory of facts and experience (not project artifacts), use `retain`/`recall` instead — `knowledge` is the project's working surface, not the memory backend.
