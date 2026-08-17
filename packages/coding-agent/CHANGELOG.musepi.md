# MusePi Changelog

MusePi 定制版本的发布说明,供启动时的"新功能"面板(`changelog.startup`)与
`/changelog` 展示。上游 oh-my-pi 的变更记录在 `CHANGELOG.md`(本文件存在时
优先读取本文件)。

## [0.4.1] - 2026-08-16

### Added

- **托盘菜单用量区**:同供应商多凭据并排列(每列账户 + 进度条 + 用量/限额),最右侧
  合计列(平均占比);供应商按用量最低优先排序;窗口固定高度(440px),内容内部滚动。
- **GUI /usage 用量面板与上下文圆环配额块**:同供应商全部凭据合并为并排列 + 合计
  列,与 TUI `/usage` 同源(daemon `usage.reports` 共享聚合),活跃凭据 ● 标记。
- **slash 补全排序**:精确/前缀匹配优先,`/usage`、`/context` 等 GUI 原生命令在
  同层匹配中优先(输入 `/c` 时 `/context` 排在 `/clear`、`/compaction` 前)。
- **i18n 词表按域拆分**(渲染端 12 域、TUI 13 域),en 侧编译级 parity(缺/多 key
  编译报错),新增 `registerTranslations` 插件翻译注册 API。
- **用量磁盘缓存**:5 分钟 TTL + 失败时 last-good 快照兜底 + 并发合并,重复查看
  用量零上游请求(daemon 重启后仍生效)。

### Changed

- **/usage 与托盘用量列序修复**:凭据列改为 provider 级固定列序(跨窗口平均用量
  降序)——此前每窗口独立 worst-first 排序导致同一凭据在不同窗口"左右错位"。
- 托盘菜单文案全量接入 i18n(中文/英文随界面语言切换)。

### Fixed

- 托盘用量区同供应商多凭据重复 key 警告(React `Encountered two children with
  the same key`)。
- 上下文圆环配额弹层丢失凭据归属(各供应商限额拍平后无法区分账户)。
