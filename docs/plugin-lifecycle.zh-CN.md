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

`magic-keywords` 覆盖这四步：包贡献提示模板和渐变，`AgentSession` 通过注册表生成提示，编辑器高亮也只读注册表。注册表为空时因此没有提示，也没有高亮。`stats-pills` 通过同一插槽生命周期拥有 composer dock 组件。`android-emulator` 让 RPC 命名空间、右侧面板组件和 Agent 工具共享一个 ADB 服务；销毁时等待在途截图，并且只终止该插件实例启动的模拟器进程。

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

Cordis 插件化不代表每个内置条目都可停用。声明 `readonly: true` 的内置条目仍可检视，但没有启停控制：GUI 与 TUI 不提供开关，`extensions.setEnabled` 会拒绝禁用请求，而不是写入无效标记。

`musepi.components` 中带 entry 的组件拥有独立 fiber，其状态可以是 `active`、`disabled`、`failed`、`unloaded`；插件禁用后声明仍可检视。

preset 组合使用 `CordisPresetRuntime`，不以 legacy 扩展装载器作为生命周期所有者。每行通过 `scope.plugin()` 挂载，`isolate` 映射为 `Context.isolate(name)`；provider 与消费者只有位于同一默认 Context 或隔离 group 中才能看到同一个服务对象。`Extension` 只是工具/UI 桥消费的注册记录。切换 preset 会移除旧工具并销毁旧 fiber，会话销毁也遵循同一顺序。

会话顾问由 `session/advisor-lifecycle-plugin.ts` 中的会话级 Cordis 插件持有。插件在首轮可能结束之前同步构造 `SessionAdvisors` 并订阅主回合完成事件。fiber effect 负责取消订阅、停止全部顾问运行时并等待记录器关闭。`SessionAdvisors` 继续作为模型、上下文、transcript、投递、配置和统计策略的 helper，这些策略不在生命周期插件中复制。用户中断会暂停主循环和在途顾问工作，并等待双方收敛。顾问触发的修正回合结束本次审查周期，不会再次回喂顾问形成循环。

插件自有 skill 放在插件目录内，并在 `apply` 中通过 `registerSkill` 声明，不再走独立的 bundled-skill 安装器。禁用插件会同时移除它的 skill、工具、组件和 effect；用户独立安装的文件 skill 不受影响。

## 宿主拥有的易变 context

易变 context 由会话提示词宿主与宿主提示词构建器分担。六个只读核心提示词包（`delegation`、`file-tools`、`browser`、`computer`、`lsp`、`host-integrations`）在所有会话加载路径挂载到会话 `PromptHost`——去重与按会话隔离的保证见 `docs/extensions-dev.md` §20。项目上下文 snapshot 区块由会话自己注册：`project:context`（AGENTS 文件与工作区树）与 `project:active-repo`（嵌套仓库）归同一 owner，custom prompt 布局仍在自己的模板中渲染 context 文件。`host-integrations` 插件拥有 `host:runtime-context` 区块，渲染记忆指令、auto-learn 指南、已挂载 MCP 路由指引、MCP 服务器说明（按名称排序、4000 字符截断由宿主施加）与默认用户 append。

扩展贡献走另一条通道：`registerContext` 贡献每轮以隐藏的 `prompt-context:<name>` custom 消息在同一传输上投递——`required` context 每轮重发，其余按历史（活动、resume 或 branch 后）中最近一条已投递副本去重，并支持为设备携带的文本声明 `interpolate: false`。会话收集不推进宿主独立的投递台账，因此压缩或装配中止后，只要旧副本已不在历史中，后续投递就不会被抑制。plan/goal/vibe 保留各自的既有 customType，不并入该通道。

`buildSystemPrompt` 仍拥有日期、cwd、skills/rules、工具清单与 persona/预设数据；这些未插件化。plan/goal/vibe 运行时上下文继续由 `AgentSession` 以 custom 消息持久化：流式 steer 投递、模式退出 marker 与 resume/branch 去重依赖该消息传输，因此不迁为 system 区块。最近一次已投递副本内容相同时不再注入，流式进入模式经 steer 持久化的上下文不会在下一轮变成第二份。

## 迁移检查

- 指明权威注册表、消费者、激活所有者和销毁所有者。
- 先让消费者读取插件注册表，再删除静态 fallback。
- 删除重复路径时保持模型可见和 UI 行为。
- 同时验证禁用/空注册表行为与已装载行为。
- 验证 reload、重复装载、provider 消失和清理失败隔离。
- API 或生命周期变化时同步 `docs/extensions-dev.md` 与本文。
