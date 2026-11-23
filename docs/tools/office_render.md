# office_render

> Renders the text structure of Office Open XML files (`.docx`, `.xlsx`, `.pptx`).

## Source
- Entry: `packages/coding-agent/src/tools/office.ts`
- Plugin package: `packages/coding-agent/src/plugins/document/tool-office/`
- Key collaborators:
  - `fflate` — reads the Office package ZIP synchronously.
  - `packages/coding-agent/src/tools/tool-ownership.ts` — `office_render` is owned by the `tool/office` component.
  - The plugin's `Config.maxChars` sets the default text ceiling.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string` | Yes | A `.docx`, `.xlsx` or `.pptx` file, relative to the session working directory. |
| `pages` | `number[]` | No | `pptx` only: one-based slide numbers; omitted renders every slide. Rejected for `docx` because page selection needs an Office converter. |
| `sheet` | `string` | No | `xlsx` only: exact worksheet name; omitted renders every sheet. |
| `range` | `string` | No | `xlsx` only: an A1 range such as `A1:H40`. |
| `maxChars` | `number` | No | Text ceiling for this call (1000-500000); defaults to the plugin's `Config.maxChars`. |

## Outputs
Text sections (`Paragraphs`, `Slide N`, `Sheet: <name>`) plus `details.format`, `details.sections` and `details.truncated`. Word paragraphs join their text runs; Excel rows are tab-separated; PowerPoint slides are listed in slide order.

## Limits
This is the text side of dsh's `office_render`. It reads package XML directly and does not render pages as images; that needs an Office converter service. Format conversion is `office_convert`; formula recalculation (`office_recalculate`) is not implemented.