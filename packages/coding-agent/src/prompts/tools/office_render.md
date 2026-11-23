Render pages, slides, or worksheet areas of an Office document or PDF as PNG images you can view.

Use it when layout is the answer — design, charts, scans, slide composition. When you need body text or table data, use `office_convert` instead: text costs far less context than page images.

`pages` lists distinct one-based pages or slides; spreadsheets select `sheet` and optionally `range` (A1:H40) instead. `dpi` runs 24-600 (default 144).

Requires the host's Office converter. When it is unavailable the call fails; do not substitute system `soffice`, `pandoc`, or another converter.