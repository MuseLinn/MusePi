---
layout: default
title: 插件生命周期与归属
status: living
summary: Cordis 插件的注册、消费、状态、依赖、销毁，以及与 native 服务的边界。
scope:
  - packages/coding-agent/src/bundled-plugins
  - packages/coding-agent/src/extensibility/plugins/runtime
  - packages/coding-agent/src/daemon/cordis-dynamic-plugins.ts
lang: zh-CN
---

# 插件生命周期与归属

[English](plugin-lifecycle.md) | 中文

MusePi 插件同时负责注册与消费。一个包如果只出现在扩展中心，而静态宿主路径仍在执行功能，就没有完成迁移。native 配置发现和核心领域服务不天然属于插件化债务。

## 归属边界

| 形态 | 含义与生命周期 |
| --- | --- |
| Cordis 插件包 | fiber 拥有注册、服务发布、状态和清理。`src/bundled-plugins` 包含第一方示例。 |
| Legacy 扩展 | 通过 `pi.*` 兼容 façade 工作，不具有 Cordis 专属原语；保留 legacy 加载语义，不获得 `pi.effect` 或 `pi.state`。 |
| Native 配置 provider | 将用户/项目配置读取成能力列表，属于发现流程，不是插件 fiber，没有独立启停生命周期。 |
| 核心领域服务 | 负责宿主运行必需的会话、模型、持久化、协议等不变量。不要只为扩大插件列表而机械包装。 |

`omp-plugins` 与 `musepi-extensions` 保持独立 provider。新的第一方可替换能力使用 `musepi-extensions`，不会仅因随应用分发就变成 `native`。

## 装载与消费

完整迁移包含四部分：

1. **声明**：包导出身份与 `apply`，有依赖时同时声明 `inject` / `provide`。
2. **注册**：`register*` 将能力接入真实注册表或插槽。
3. **消费**：prompt、UI、命令等消费者读取同一注册表，而不是平行的静态实现。
4. **销毁**：卸载同时移除注册及其可见和运行时效果。

`magic-keywords` 覆盖这四步：包贡献提示模板和渐变，`AgentSession` 通过注册表生成提示，编辑器高亮也只读注册表。注册表为空时因此没有提示，也没有高亮。`stats-pills` 通过同一插槽生命周期拥有 composer dock 组件。

## 副作用与状态

定时器、watcher、socket、AbortController 等未被 `register*` disposer 覆盖的资源使用 `pi.effect(cleanup, label?)`。卸载和回滚按逆序执行清理，一个失败不会阻断其他清理。

fiber 作用域值使用 `pi.state`，支持 `get`、`set`、`has`、`delete`、`keys`。清理期间仍可读取，销毁后清空。不要用模块变量或 `globalThis` 代替 fiber 状态：重新求值会创建新的模块实例并分裂所有权。

`pi.effect` 与 `pi.state` 只存在于 Cordis API，由 `plugins/runtime/mount.ts` 按 mounted `Extension` 绑定，不添加到 legacy façade。

## 依赖

通过 `inject` 声明所需服务，并以 `provide` 名称返回服务对象。缺少依赖时拒绝装载。消费者通过 `pi.service(name)` 获取服务，并处理 provider 运行中消失的情况。

注册表只在成功装载后发布服务，并在卸载时移除，避免消费者拿到装载失败或已经销毁的 provider。

首次装载共享进程内模块实例；显式 reload 重新求值入口及其源码图。注册状态和 fiber 状态属于 mounted `Extension`，不属于模块对象。

## 宿主与会话域

宿主级插件位于 `daemon/cordis-dynamic-plugins.ts` 的 `musepi-dynamic-plugins` 下，支持检视、独立组件 fiber、RPC 派发、启停、reload 和 unload。会话级装载使用会话扩展上下文。不要把宿主单例隐式当作会话服务。

`musepi.components` 中带 entry 的组件拥有独立 fiber，其状态可以是 `active`、`disabled`、`failed`、`unloaded`；插件禁用后声明仍可检视。

## 迁移检查

- 指明权威注册表、消费者、激活所有者和销毁所有者。
- 先让消费者读取插件注册表，再删除静态 fallback。
- 删除重复路径时保持模型可见和 UI 行为。
- 同时验证禁用/空注册表行为与已装载行为。
- 验证 reload、重复装载、provider 消失和清理失败隔离。
- API 或生命周期变化时同步 `docs/extensions-dev.md` 与本文。
