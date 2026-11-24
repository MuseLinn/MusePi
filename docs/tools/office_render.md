# office_render

> Renders document pages, slides, or worksheet areas as PNG images.

## Source
- Entry: `packages/coding-agent/src/tools/office.ts`
- Conversion service: `packages/coding-agent/src/office/office-kit.ts`
- Plugin package: `packages/coding-agent/src/plugins/document/tool-office/`
- Skill: `packages/coding-agent/src/plugins/prompt/product-skills/skills/office/SKILL.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/tool-ownership.ts` — `office_render` is owned by the `tool/office` component.
  - `packages/coding-agent/src/tools/office-activation.ts` — the tool is registered but inactive until an Office skill loads.

## Admission
`office_render` is in the session's registry from the start but not in its tool slate. A successful `/skill:office` invocation or `skill://office` read admits the whole Office group (`office_render`, `office_convert`, `office_recalculate`) from the following step. The activation skill names default to `office`, `office-docx`, `office-xlsx`, `office-pptx` and are the plugin's `Config.activationSkills`.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string` | Yes | `doc`, `docx`, `odt`, `xls`, `xlsx`, `ods`, `ppt`, `pptx`, `odp`, or `pdf`, relative to the session working directory. The source is never modified. |
| `pages` | `number[]` | No | Distinct one-based pages or slides; omitted renders every page. Rejected for spreadsheets. |
| `sheet` | `string` | No | Spreadsheet only: exact worksheet name; omitted renders every sheet. |
| `range` | `string` | No | Spreadsheet only: an A1 range such as `A1:H40`; requires `sheet`. |
| `dpi` | `number` | No | Rendering resolution from 24 to 600; default 144. |

## Outputs
One text summary block, then one `image` block per rendered page (`image/png`). `details` carries `format`, `pageCount`, `dpi`, and each image's `page`/`sheet`/`range`, `bytes`, `width`, and `height`.

## Engine
Rendering goes through the host's Office kit. The default engine converts Office documents to PDF with LibreOffice (`soffice`) and rasterizes pages with poppler's `pdftoppm`; a PDF source needs only `pdftoppm`. LibreOffice and `pdftoppm` are discovered at call time.

A spreadsheet selection is a workbook rewrite, not a crop: `sheet` keeps only that worksheet visible and hides the others, and `range` also becomes the sheet's `_xlnm.Print_Area`, so the engine prints exactly that area. This needs an `.xlsx` workbook; convert `.xls`/`.ods` to `.xlsx` first.

## Limits
- A missing engine fails the call with an `unavailable` message; the tool never substitutes a text summary, `soffice`, `npx`, or another converter.
- The image count (`Config.maxImages`, default 20) and total PNG bytes (`Config.maxBytes`, default 32 MiB) bound one render.