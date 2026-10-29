---
layout: default
title: MusePi Profile 与 Preset 统一设计
status: draft
summary: 使用 MusePi 自有 profile 命名，默认启用 Computer Use，并让 bundle 中的 Agent preset 声明进入会话预设解析链。
scope:
  - packages/coding-agent/src
  - packages/desktop-app/src
  - packages/client-core/src
  - docs
lang: zh-CN
---

# MusePi Profile 与 Preset 统一设计

## 意图

根据最新产品决定，Computer Use 默认开启；MusePi 的 profile 使用自己的 `musepi.profile.bundles` 字段，不再把 DSH 命名作为默认持久化格式。DSH 的真实结构是 bundle 内声明 Agent preset，因此 MusePi 也需要让这类声明进入会话预设解析，而不是只在组合页展示。

## 目标

- 新会话默认注册 Computer Use；审批和系统权限流程不变。
- 仅支持 `musepi.profile.bundles`，DSH profile 字段直接忽略，不作为第二套配置格式。
- bundle 中的 Agent preset 声明可以转换成 `ModeDefinition`，进入 `modes.list` 和 SDK 的 `createModeResolver`。
- 文件预设保持最高优先级，profile preset 次之，扩展代码声明最后；已有用户配置不被覆盖。
- 新会话默认值保存在 profile 的 `agent-preset-registry.config.selectedDefault`，localStorage 仅作旧版回退；首轮后 preset 锁定，已有会话保留创建时的组合。
- 当前内置 `work/chat/design/creator` 全部通过结构校验；`chat` 对后续新增的 `knowledge` 工具也有明确取舍。

## 非目标

- 不把 profile 和会话 preset 变成同一个运行时作用域。
- 不要求用户迁移或删除旧 DSH 字段。
- 不用 DSH 包名替换 MusePi 自有配置契约，不移植完整 DSH persona 方言。

## 方案

采用兼容式统一，而不是再建一套预设系统：

1. profile 只读取和写入 `musepi.profile.bundles`；DSH profile 字段直接忽略，不保留第二套配置格式。
2. 新增 profile preset 投影，读取组合中的 Agent preset 行，将 `config.id/config.plugins` 转成现有 `ModeDefinition`；支持 persona 的 prefix、complete、includeRuntimeContext，以及嵌套插件行的 disabled → enabled 映射。
3. `modes.list` 按文件 → profile → 扩展顺序合并；SDK 解析使用相同优先级。
4. Computer Use schema 默认值改为 true，相关文档与测试同步。
5. `chat` 将 `knowledge` 加入 denylist，模板修订升到 7，rev6 作为字面量历史快照以升级未编辑的旧文件。

## 验证

- 新 profile 默认只写 MusePi 字段；DSH-only 配置不形成组合，双字段并存时也只使用 MusePi。
- Agent preset fixture 同时证明声明进入列表和 SDK 解析，嵌套行启停与 persona 映射正确。
- Computer Use 默认在工具集中，显式关闭仍可移除，斜杠命令仍能恢复。
- 当前所有内置预设通过 `validateMode`；`chat` 对 `BUILTIN_TOOLS` 的每个非保留工具都有显式禁用项；rev6 未编辑文件升级，编辑文件保留。
- 更新 owning docs、双语和 Unreleased changelog，运行相关包检查与生产构建。
