# office_convert

> Converts Office Open XML files to text or CSV (the text-target subset of dsh's `office_convert`).

## Source
- Entry: `packages/coding-agent/src/tools/office.ts`
- Plugin package: `packages/coding-agent/src/plugins/document/tool-office/`
- Key collaborators:
  - `fflate` — reads the Office package ZIP synchronously.
  - `packages/coding-agent/src/tools/tool-ownership.ts` — `office_convert` shares the `tool/office` component with `office_render`.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string` | Yes | A `.docx`, `.xlsx` or `.pptx` file. |
| `format` | `"txt" \| "md" \| "csv"` | Yes | docx/pptx: `txt` or `md`. xlsx: `csv` (a sheet is required for a multi-sheet workbook), `txt` or `md`. |
| `sheet` | `string` | No | `xlsx` only: worksheet to convert. |
| `output` | `string` | No | Write the converted text to this path; otherwise the text is returned. |
| `maxChars` | `number` | No | Text ceiling for the returned text (1000-500000). |

## Outputs
Without `output`, a text result with the converted content and `details.format/target/truncated`. With `output`, the file is written (parent directories created) and the result names the source and destination; `details.output` carries the absolute path.

## Limits
PDF and Office-format conversion need an Office converter service. `office_recalculate` (formula refresh) is not implemented.