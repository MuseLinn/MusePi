---
title: office_recalculate
status: reference
summary: Recalculates a workbook's formulas and saves the refreshed workbook.
scope:
  - packages/coding-agent/src/tools/office.ts
  - packages/coding-agent/src/office/office-kit.ts
---

# office_recalculate

> Recalculates a workbook's formulas and saves the refreshed workbook.

## Source
- Entry: `packages/coding-agent/src/tools/office.ts`
- Conversion service: `packages/coding-agent/src/office/office-kit.ts`
- Plugin package: `packages/coding-agent/src/plugins/document/tool-office/`
- Key collaborators:
  - `packages/coding-agent/src/tools/tool-ownership.ts` — `office_recalculate` shares the `tool/office` component.
  - `packages/coding-agent/src/tools/office-activation.ts` — inactive until an Office skill loads.

## Admission
Same group admission as `office_render`: an Office skill load admits all three tools from the following step.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string` | Yes | `xls`, `xlsx`, or `ods` workbook. The source is never modified. |
| `format` | `"xlsx" \| "ods"` | Yes | Output workbook format. |
| `output` | `string` | No | Copy the result to this workspace path instead of leaving it in the conversion store. |

## Outputs
The result names the recalculated workbook's path and byte size, plus `details.format`, `details.bytes`, and `details.output` when a workspace copy was requested.

## Limits
- Recalculation needs a dedicated engine: plain conversion preserves a workbook's cached formula results, so it is not a substitute. The default engine reports `unavailable` for this operation.
- A non-workbook input is refused before the engine is called.