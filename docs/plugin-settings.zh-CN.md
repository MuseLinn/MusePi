---
layout: default
title: 插件自带设置
status: living
summary: 插件如何拥有设置的键、类型、默认值与设置行，以及新增或迁移设置项的检查清单。
scope:
  - docs
  - packages/coding-agent
  - apps/desktop
---

# 插件自带设置

[English](plugin-settings.md) | 中文

设置归插件所有。插件包声明键、类型和默认值；宿主从设置存储读取这些值，并用同一份声明渲染设置行。核心代码只保留不属于单个插件的内容：标识当前启用哪个后端的选择器，以及跨后端的维护开关。

## 设置的存放位置

| 内容 | 归属 | 位置 |
| --- | --- | --- |
| 键、类型、默认值、凭据标记 | 提供该功能的插件 | 包旁的 `config.json`，或 `musepi.config` 块 |
| 已存值 | 设置存储 | `Settings`（全局配置、项目覆盖，部分键还有环境变量） |
| 设置行：tab、分组、标签、说明、显示条件 | 同一个插件 | `ctx.settings.register` |
| 插件未挂载时的回退 | 插件自己的读取函数 | 包内的默认值表 |

插件是一个 Cordis fiber：`apply(ctx, config)` 收到声明的配置，每次注册都是该 fiber 上的 effect。卸载会移除设置行与 provider；已存值保留，包内读取函数继续返回默认值。

## 新增一个设置项

1. 在包的 `config.json` 声明字段（键、类型、默认值、可选 `restart`），并在清单里加 `"host": { "configStorage": "settings" }`，让宿主把值存进 `Settings`。
2. 在包的 settings 模块导出默认值，并统一通过它读取（`settings.getExtension(key)`），使读取在挂载前后都成立。
3. 在 `apply` 里注册设置行：`ctx.settings.register({ key, type, default, ui })`，条件写成声明式对象，如 `{ key: "memory.backend", equals: "mnemopi" }`。
4. 测三种状态：已挂载（行可见、值可写）、未挂载（行消失、读取返回默认值）、密钥键的遮罩。

## 位于既有页面内的设置行

不是每个功能都需要一个导航页。另有两个席位：

- `settings.item.<page>.<row>` —— 命名页面上的一行，渲染在该页自身内容之后。
- `settings.subnav.<page>` —— 该页分段子导航中的一个标签（前缀席位，任意页面 id 均可）。`id` 命中内置标签即替换，其余追加。“会话与记忆”使用 `settings.subnav.session-memory`，后端因此无需新增导航页即可展示自己的面板。

整页使用 `settings.section` 并沿用该页既有 id：内容归插件，导航行与深链保留。“钩子”页是最小的例子。

内容只由插件提供的整页不保留宿主回退：导航行随贡献出现，插件缺席或编译失败时该页消失，而不是打开一个空页。这类页的 id 要与页面组件一同登记在设置导航的“插件独占”集合里。目前保险库、钩子、命令、快捷键、通知与音效、使用统计六页按此方式归属。

只有当功能本身是一整页时才用 `settings.section`。

整页的包名是 `settings-<page>`（`musepi-settings-<page>`）：域在前、它拥有的那一页在后，目录列表因此把设置页聚在一起。一页一包。

新增席位需在 `packages/collab-proto/src/extension-slots.ts` 与 `slot-contracts.ts` 登记，重新生成目录，并在 `docs/extensions-dev.md` 说明。

## 插件的嵌套组合

一个插件本身可以是子插件的集合：清单里的 `components` 逐项声明入口，每个组件有自己的 fiber。组件各自注册自己的设置、工具与设置行；停用某个组件只移除它的贡献。功能族因此可以只发一个包，而不必把二十行设置堆在同一页：父包声明组件，子项各自拥有设置与设置行。

父插件启用时宿主才显示它的设置；被停用的组件不贡献任何内容。两个包不能拥有同一个键——注册表会拒绝第二个所有者。

## 检查清单

- [ ] 键由所属插件包声明，而不是核心 schema。
- [ ] 读取统一走 `settings.getExtension` 与包内默认值表。
- [ ] 插件未挂载时行为不变，设置行不出现。
- [ ] 密钥键在注册设置行时声明为凭据。
- [ ] 条件是声明式的，终端与桌面两种界面都能求值。
- [ ] 设置行位于其他页面时，席位已登记并写入文档。
- [ ] 测试覆盖已挂载、未挂载与遮罩三种状态。
