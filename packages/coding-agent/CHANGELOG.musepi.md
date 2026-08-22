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

## [0.4.3] - 2026-08-22

### Added

- **OTA 更新渠道切换**:GUI 与 daemon 的版本探测统一走 GitHub release 资产重定向
  (`/releases/latest/download/update-manifest.json`,bitfun parity,无 api.github.com
  限流);repo 公开前 404 优雅降级为"尚未发布公开更新源"。
- **三合一发送按钮 run 级 working**:agent 工作中按钮变为胶囊 + 点阵 bloom + 「工作中」/
  「停止」双标签;`turn_end` 不再熄灭 working(每工具批次触发),只有 `agent_end` 或权威
  state 帧才复位——修复轮间 provider 准备期按钮闪回发送箭头的问题。
- **更新提示 toast**:主进程启动 12s 后自动检查,发现新版推送右下角 `UpdateToast`(版本
  当前→最新 + 说明 + 「前往下载」/「跳过此版本」,按版本 localStorage 记忆,bitfun
  DailyAppUpdateGate parity)。
- **设置 → 检查更新人性化**:行内显示当前版本/状态 + 手动检查按钮;发现新版展开更新说明
  摘要 + 明确「前往下载」按钮(不再自动 window.open 弹浏览器)。

### Changed

- **模型设置 UI**:模型选择器即时刷新 + provider 模型能力/发现对齐 + 角色卡布局与
  project-scope 角色写入(TUI parity)+ 思考等级选项/模型切换 clamp 修正。
- **转录渲染**:tool-result 图片内联提升、diff 语言推断、async-result/advisor
  自定义消息渲染、流式 markdown 契约(见 gui-implementation.md §16)。
- **i18n**:词表按域拆分(渲染 12 域/TUI 13 域),en 侧编译级 parity;伙伴文案从
  pet.ts 拆到 companion.ts。

### Fixed

- 设置覆盖台账泄露秘密形状 key(`d0df8b77`);GuiSelect 在 roles tab 的无条件 hooks
  React #300 崩溃(`a2a95708`)。
- 子代理面板跨会话接线 + subscribe 时 hydration;预设模式 chip(vmodes.list)
  不再消失。
- 语音页只渲染 Speech 组而非整个交互 tab;语音模型下载流程加固(验证/去重/终止事件)。
