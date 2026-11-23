# office_read

> Reads text and structure from Office Open XML files (`.docx`, `.xlsx`, `.pptx`).

## Source
- Entry: `packages/coding-agent/src/tools/office.ts`
- Plugin package: `packages/coding-agent/src/plugins/document/tool-office/`
- Key collaborators:
  - `fflate` — reads the Office package ZIP synchronously.
  - `packages/coding-agent/src/tools/tool-ownership.ts` — `office_read` is owned by the `tool/office` component.
  - The plugin's `Config.maxChars` sets the default text ceiling.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | `string` | Yes | A `.docx`, `.xlsx` or `.pptx` file, relative to the session working directory. |
| `sheet` | `string` | No | `xlsx` only: exact worksheet name; omitted reads every sheet. |
| `slide` | `number` | No | `pptx` only: one-based slide number; omitted reads every slide. |
| `maxChars` | `number` | No | Text ceiling for this call (1000-500000); defaults to the plugin's `Config.maxChars`. |

## Outputs
Text sections (`Paragraphs`, `Slide N`, `Sheet: <name>`) plus `details.format`, `details.sections` and `details.truncated`. Word paragraphs join their text runs; Excel rows are tab-separated; PowerPoint slides are listed in slide order.

## Limits
This is the text side of dsh's Office family. It reads package XML directly and does not render pages as images, convert formats, or recalculate workbook formulas; those operations need an Office converter service.