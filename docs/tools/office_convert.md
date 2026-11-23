# office_convert

> Converts an Office document to another format. Text targets are read in-process; binary formats go through the host's Office kit.

## Source
- Entry: `packages/coding-agent/src/tools/office.ts`
- Conversion service: `packages/coding-agent/src/office/office-kit.ts`
- Plugin package: `packages/coding-agent/src/plugins/document/tool-office/`
- Key collaborators:
  - `fflate` — reads the Office package ZIP for the in-process text targets.
  - `packages/coding-agent/src/tools/tool-ownership.ts` — `office_convert` shares the `tool/office` component with `office_render` and `office_recalculate`.
  - `packages/coding-agent/src/tools/office-activation.ts` — inactive until an Office skill loads.

## Admission
Same group admission as `office_render`: a successful Office skill load admits all three tools from the following step.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string` | Yes | `doc`, `docx`, `odt`, `xls`, `xlsx`, `ods`, `ppt`, `pptx`, or `odp`; PDF input is refused. |
| `format` | `string` | Yes | Word: `pdf`, `docx`, `odt`, `txt`, `md`. Excel: `pdf`, `xlsx`, `ods`, `csv`, `txt`, `md`. PowerPoint: `pdf`, `pptx`, `odp`, `txt`, `md`. |
| `sheet` | `string` | No | Spreadsheet only: worksheet to convert. Required for `csv` on a multi-sheet workbook, and only valid for `csv`. |
| `output` | `string` | No | Write/copy the result to this workspace path instead of leaving it in the conversion store. |
| `maxChars` | `number` | No | Text targets only: ceiling for the produced text (1000-500000); defaults to the plugin's `Config.maxChars`. |

## Outputs
- Text targets (`txt`, `md`, `csv`) are read in-process. Without `output` the text is the tool result (`details.format`/`target`); with `output` it is written first and `details.output` carries the absolute path.
- Binary targets (`pdf`, `docx`, `odt`, `xlsx`, `ods`, `pptx`, `odp`) are produced by the Office kit and left in the kit's conversion store; the result names the path and asks the model to copy it with the shell. `output` copies it into the workspace directly.

## Limits
- Binary targets need the Office kit's LibreOffice engine; without it the call fails as `unavailable` and never substitutes another converter.
- A format the input family cannot produce is refused before any conversion runs.