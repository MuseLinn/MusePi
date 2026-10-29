---
layout: default
title: Cordis 插件管理与更新修复设计
status: draft
summary: 修复桌面更新元数据与平台链接，并对齐内置组件、profile/bundle 和 Agent preset 的管理语义。
scope:
  - packages/desktop-app
  - packages/coding-agent/src/daemon
  - packages/coding-agent/src/extensibility/plugins
  - scripts
  - .github/workflows/gui-release.yml
lang: zh-CN
---

# Cordis 插件管理与更新修复设计

## 1. 意图

本轮解决三个已复现的问题：Windows 更新因最终安装包与 `latest.yml` 校验值不一致而失败；更新回退链接固定指向 macOS ARM64；插件与组合页展示了配置状态，却缺少清楚的有效状态与可用的 bundle 管理入口。同时保持 MusePi 与 DSH 相同的概念边界，避免把 Agent preset、应用 profile 和普通插件混成一层。

## 2. 概念契约

- **普通插件包**：由 runtime lock 记录启停，提供工具、命令、hooks 或扩展入口。
- **DSH bundle**：由包内 `dsh.bundle.patch` 声明组合行；是否进入当前应用组合由 profile 的 `musepi.profile.bundles` 有序列表决定，仅支持 `musepi.profile.bundles`，DSH 字段直接忽略。行级覆盖写入 profile 的 `cordis.patch.yml`。
- **Agent preset**：某个会话的能力组合，包含插件行、提示词、扩展白名单和设置覆盖。设置页“预设”对应这一层，不是应用 profile 选择器。
- **内置单元与组件**：父单元的设置镜像决定父能力是否开启，组件黑名单决定组件是否被单独禁用。组件配置可以在父单元关闭时保留，但不得显示为正在运行。

## 3. 目标

- Windows x64/ARM64、macOS ARM64 和 Linux 各架构获得各自的手动下载地址。
- 发布任务在上传前根据最终安装器重算 Windows feed 的 SHA-512 和大小，防止二次包装后的 exe 与旧 feed 一起发布。
- 组件行同时区分“未被组件黑名单禁用”和“随父单元实际生效”；父单元停用时保留组件配置但不让组件显示为绿色运行态。
- 组合页可以列出已安装 DSH bundle，并通过开关写回当前 profile 的 bundle 列表；行级启停仍写 profile patch。
- 查看组合不再自动创建空 `package.json` 或 `cordis.patch.yml`。
- 文档明确普通插件、profile/bundle、Agent preset 的所有权和生效范围。

## 4. 非目标与反目标

- 不把 Computer Use 改为默认开启；MusePi 与 DSH 都要求显式启用。
- 不把设置“预设”改成 profile 管理页，不合并两套持久化格式。
- 不在本轮重写完整 DSH 安装器、依赖解析、运行时 Loader 或 HMR。
- 不用隐藏组件、级联清空用户组件黑名单或伪造运行状态来消除视觉矛盾。
- 不改变现有 stable/beta 更新渠道逻辑，不覆盖工作区中无关的发布与语音改动。

## 5. 方案选择

### A. 仅修文案和截图状态

改动最小，但 bundle 开关仍不写 profile，更新仍可能发布错误校验值，不采用。

### B. 完成一轮有限的管理与发布契约对齐

采用此方案。复用现有 `BundleService`、DSH patch 组合器和 `plugins.setEnabled` 的普通插件路径，只新增 profile bundle 选择写入、组件有效状态展示和发布校验收尾。它能直接消除本轮发现的错误行为，且不需要移植整个 DSH 运行时。

### C. 全量移植 DSH 插件管理

包括完整安装状态机、profile 生命周期、Loader 和 HMR。范围大且会重复现有 MusePi 安装与扩展加载体系，本轮不采用。

## 6. 实现设计

### 6.1 更新与发布

- 发布清单保留旧 `url` 作为旧版 macOS 客户端兼容字段，新增按 `平台-架构` 索引的 `downloads`。
- `updater.cjs` 根据 `process.platform/process.arch` 选择当前安装器；缺失时回退版本发布页，不再把 macOS dmg 发给 Windows。
- 发布工作流生成所有支持目标的下载地址。
- `mergeWindowsFeeds` 在合并前读取最终 exe，重算每个 feed 文件的 SHA-512 和大小，并同步 x64 顶层 `path/sha512`；文件不存在时发布失败。
- 契约测试覆盖平台选择、旧清单回退、最终 exe 与旧哈希不同步，以及缺失资产。

### 6.2 组件有效状态

- `enabled` 继续表示组件未进入自己的黑名单，避免改变 RPC 的既有含义。
- 界面根据父条目 `state/loadError` 计算组件是否实际挂载。
- 父条目停用时，组件开关禁用，圆点熄灭，并显示“配置保留，随父插件停用”；重新启用父条目后恢复原组件选择。
- 父条目 active 时沿用现有独立组件开关。

### 6.3 profile/bundle 管理

- 删除 composition 读取路径中的示例文件写入；已有用户文件保持不动。
- profile 模块新增原子、保留其他清单字段的 bundle 列表写入函数，统一处理 `dsh` 与 `musepi` 别名；有 DSH 声明时优先更新 DSH 字段。
- `BundleService` 增加 `bundles.setEnabled`：验证已安装包确实声明 `dsh.bundle.patch`，更新当前 profile 的有序 bundle 列表，失效缓存、重新组合并触发既有扩展刷新。
- composition 返回可用 bundle 目录：名称、版本、路径、当前是否选中、声明是否可读。已选中但磁盘缺失的 bundle 也保留并标注，不能静默从管理面消失。
- 组合页先展示 bundle 管理，再展示层与组合行。无 profile 时提供清楚的说明；有可用 bundle 时即使组合为 0 行也可操作。
- 普通 `plugins.packages/plugins.setEnabled` 继续管理普通插件，不用 runtime lock 冒充 bundle 选择。

### 6.4 文档与变更记录

- 更新扩展开发文档，移除“无需 DSH patch 层”的过期表述，记录三层管理模型和各事实源。
- 更新 GUI 双语文档与 `CHANGELOG.musepi.md` 的 Unreleased 条目。
- 预设页说明补充“会话级 Agent preset”，不引入新的 profile 控件。

## 7. 验证

- 先新增并运行失败测试，再实现：更新平台 URL、最终安装器重算、profile 写入、bundle 选择回读、读取无副作用、组件父级停用展示。
- 运行 `packages/desktop-app`、`packages/coding-agent` 的相关契约测试和各自 `check`。
- 运行发布脚本相关测试、文档与 changelog 检查。
- 用真实组合 fixture 验证 bundle 启停改变组合行，普通插件启停不写 profile。
- 最终确认未修改生产 profile；测试仅使用临时 home。

## 8. 实施假设

- 用户要求“修复并对齐”授权采用第 B 种方案并连续实施，不等待额外方案确认。
- 本轮“对齐”指管理语义和真实持久化结果一致，不等于全量替换 MusePi 运行时。
- 工作区已有 stable/beta 更新改动是需要保留并兼容的前置工作，不作为本轮回退对象。
