---
name: office
version: 1.0.0
description: 处理 Word/Excel/PowerPoint 文档与 PDF——读结构、按页渲染成图片、转换格式、重算工作簿。触发：用户给出 .docx/.xlsx/.pptx/.doc/.xls/.ppt/.odt/.ods/.odp/.pdf 文件并要求阅读、预览、转换、总结或校对版式。
---

# Office 文档

本技能加载后，`office_render`、`office_convert`、`office_recalculate` 才进入工具面；加载前它们不可调用。这三个工具共享主机的 Office 转换服务，自己不解析二进制格式。

## 先选操作

| 需求 | 工具 |
| --- | --- |
| 看版式、图表、扫描件、PPT 页面 | `office_render`（PNG 图片） |
| 取正文、表格数据、批量转换格式 | `office_convert` |
| 让工作簿公式结果刷新后另存 | `office_recalculate` |

读取优先用 `office_convert` 拿到 txt/csv/md：比逐页图片省上下文，也便于后续编辑。只有当版面本身是答案（设计稿、图表、签名、分页）时才用 `office_render`。

## 参数要点

- `input`：相对会话工作目录的路径；工具不改源文件。
- `office_render`：`pages` 是去重的一基页码/幻灯片号；表格用 `sheet` 加可选 `range`（A1:H40）——工具会把选区写成工作簿的打印区域再渲染，只支持 `.xlsx`；`dpi` 24–600，默认 144。
- `office_convert`：Word → pdf/docx/odt/txt/md；Excel → pdf/xlsx/ods/csv/txt/md；PowerPoint → pdf/pptx/odp/txt/md。`sheet` 只用于表格转 csv，多工作表时必须指定。`output` 把结果写进工作区；不给 `output` 时二进制结果留在转换目录，返回的是路径，需要用 shell 复制。
- `office_recalculate`：只接 xls/xlsx/ods，输出 xlsx/ods。转换不会刷新公式结果，没有重算引擎时调用直接失败。

## 失败处理

- `unavailable`：主机没有 Office 转换/光栅化/重算引擎。如实告诉用户该操作不可用；**不要**改用系统 `soffice`、`pandoc`、`npx` 或别的转换器冒充结果。
- `output-too-large`：减少页数或降低 `dpi`，或只取一个 `range`。
- PDF 渲染只需要 PDF 光栅化器；Office 格式还需要 Office 转换器。

## 交付

`office_convert`/`office_recalculate` 写出文件后，把最终文件用 `present` 声明为交付物，不要只在正文里贴路径。