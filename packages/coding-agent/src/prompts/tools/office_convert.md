Convert a document to another format.

Word: `pdf`, `docx`, `odt`, `txt`, `md`. Excel: `pdf`, `xlsx`, `ods`, `csv`, `txt`, `md`. PowerPoint: `pdf`, `pptx`, `odp`, `txt`, `md`. `sheet` selects a worksheet and is required for `csv` on a multi-sheet workbook.

Text targets are read in-process. Binary targets go through the host's Office converter and are returned as a file path in the conversion store — copy it with the shell when you need it in the workspace, or pass `output` to place it directly.

When the converter is unavailable the call fails; do not substitute another converter.