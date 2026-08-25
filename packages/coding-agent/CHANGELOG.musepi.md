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
## [0.4.4] - 2026-08-24

### Added

- **Windows 安装器升级(NSIS assisted)**:安装可选目录(默认 `%LOCALAPPDATA%\Programs`,
  逐用户免管理员);升级检测复用已装路径并预填;桌面/开始菜单快捷方式 + 卸载项中文名;
  卸载保留用户数据(`deleteAppDataOnUninstall=false`);electron-updater 增量更新兼容。
- **GUI 长文本粘贴门控**:粘贴 >100 行或 >4000 字符时弹选择菜单(直接粘贴 / 包裹为
  代码块 / 附加为工作区文件),TUI large-paste 菜单 parity。
- **TUI 粘贴附件芯片**(upstream v18.0.x 吸收):粘贴文本变 chips 带、图片变
  `🖼 img-1` 原子 token(折叠/compact/shift),`setCollapsedText` 恢复草稿原文。
- **右侧面板 Phase 1**:surface 分组(primary/secondary/tertiary)+ rail 溢出菜单
  (diff/pr 折叠)+ 宽度上限 560→900。
- **OTA 重启更新(electron-updater)**:`下载更新 → 进度条 → 立即重启`,daemon
  sidecar 先杀再 `quitAndInstall`;下载失败回退「前往下载」;CI 发布各平台
  `latest*.yml`(下一版本起 OTA 自动生效)。
- **Beta 版本通道**:tag 含 `-beta`(如 `v0.4.5-beta.1`)的发布自动标记为 GitHub
  prerelease,并以 `beta` channel 打包(`beta.yml` / `beta-mac.yml` /
  `beta-linux*.yml`,安装版内嵌 app-update.yml `channel: beta`)——beta 安装版
  OTA 只跟 beta 通道,正式用户继续走 `latest*.yml` 互不干扰;正式版发布后
  beta 用户经 electron-updater 的 latest.yml 回退自动升级到稳定版。

### Changed

- **文件面板重构**(bitfun/VS Code 规范):
  - 预览接管模式——打开文件时预览占满整个面板(原左右分栏 + 拖拽比例已移除),
    顶部返回按钮回树;窄面板下树/预览互斥,不再互相挤压。
  - 路径压缩——单子目录链(`src/components`)合并为一行显示,点开直接展开到
    链内文件(bitfun lazyCompressFileTree parity)。
  - 工具栏新增「新建文件/新建文件夹」按钮(原仅右键可达)。
  - 面板宽度上限 1200px(代码预览可读宽度,openchamber 380–1400 适配)。
- **openchamber 目录选择对话框参考**:保持右面板 context/files/git/notes/browser
  布局(与 openchamber 一致),文件树不迁移左侧。
- **清理历史遗留 tags**:删除上游 oh-my-pi 遗留 tags(~900 本地 / ~290 远程,
  v0.5.x–v18.x),仅保留 musepi 版本线(v0.2.x + v0.4.x)。
- **v0.4.3 release body 补全**:全平台下载表格(macOS/Windows/Linux x64/arm64)。

### Fixed

- `bun.lock` 未提交 electron-updater 条目导致 CI `--frozen-lockfile` 失败。
- **macOS OTA 缺 `.zip` 工件**(源码级核实):MacUpdater 硬性要求 zip
  (`findFile(files, "zip", ["pkg","dmg"])`,无 zip 抛
  `ERR_UPDATER_ZIP_FILE_NOT_FOUND`)——mac target 补 `zip`,CI 上传/发布清单
  同步收录 `*.zip`。
### Added (0.4.4 追加,2026-08-25)

- **移动端 MusePi(mobile)**:Capacitor Android 壳(compileSdk 36 / minSdk 24),
  连接局域网 daemon 的远程会话伴侣——三合一发送控件(点阵 bloom 反馈)、盲文
  点阵工作指示器、会话归档(localStorage,桌面 GUI parity)、PWA 离线壳 +
  连接码复制优化、旋转/断点几何过渡、时间感知问候与轮换提示、空态建议 chips、
  jsQR 扫码加入、沉浸式 edge-to-edge 布局。
- **collab 远程会话管理**(dsh-mobile-remote parity):guest 可创建/删除/重命名
  会话;agent 主动分享(collab tool,分级审批);`session.abort` 允许 guest
  停止远端正在运行的 turn。
- **GUI /btw 分支提升**(TUI b-branch + openchamber promote parity):/btw 提问
  后「分支」按钮把当前会话切到新会话,问答可见,侧栏出现新分支会话 + 树路径
  transcript 脉冲。
- **撤回语义重构**(TUI navigateTree parity):撤回改为 branchAt 树跳转——
  旧回复保留为 sibling 分支、树上随时跳回;撤回悬浮卡片带 Reveal 折叠/展开
  动画;daemon 侧 revert RPC 全套移除(-1176 行)。
- **plan 批准并压缩上下文**:GUI plan 面板第二 primary 按钮,approve 后自动
  compact(TUI "Approve and compact context" parity)。
- **浮层定位规范**:全翻转+位移、btw Esc 关闭、菜单 clamp 进视口(不截断);
  AskCard 选择取消按钮、设计语言卡片(floating ask/inspector)。
- **实例切换器**:连接远程 daemon(openchamber DesktopHostSwitcher parity)。
- **HarmonyOS NEXT WebView 壳**(ArkTS Web + harmonyNative bridge)脚手架。
- **Nix 发布修复**:恢复 rust-toolchain.toml、清理 collab-web/robomp-web 死
  路径映射——OMP Nix flake 评估恢复通过。

### Changed (0.4.4 追加)

- 会话列表按最后活动日期分组(不再按创建时间);agent-activity 行转瞬态
  (agent 完成即清);breadcrumb 仅分支导航时显示。
- SessionTreeCanvas 可读总览 + 正确有向流;canvas 聚焦/跳转/搜索交互 +
  轨迹分支车道。
- rail 溢出菜单弹出动画(浏览器菜单 parity)。

### Fixed (0.4.4 追加)

- 会话列表日期分组与 canvas 地图语义修正;daemon fork 激活(title-slot 头)+
  message-tree 父级 walk-up;view-key/branch-at 测试清理损坏会话目录。
- i18n general/settings 域 `active` key 冲突(去重)。

