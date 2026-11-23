Recalculate a workbook's formulas and save the refreshed workbook.

Accepts `xls`, `xlsx`, or `ods` and outputs `xlsx` or `ods`. Plain conversion keeps a workbook's cached formula results and is not a substitute; when no recalculation engine is configured the call fails as unavailable.