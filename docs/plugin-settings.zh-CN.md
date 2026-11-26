---
layout: default
title: 插件自带设置
status: living
summary: 设置值归谁、插件如何拥有自己的设置行，以及新增或迁移设置项的检查清单。
scope:
  - docs
  - packages/coding-agent
  - apps/desktop
---

# 插件自带设置

[English](plugin-settings.md) | 中文

一个设置有两个归属：核心 schema 拥有它的值、类型和默认值；提供该功能的插件拥有它的设置行。两者分开，后端或功能才能自带设置界面，而不必搬动配置，也不会在插件未挂载的宿主上失效。

## 归属

- **核心 schema**（`packages/coding-agent/src/config/settings-schema.ts`）：`type`、`default`、`values`、`credential`。它们既是读取路径（`Settings.get`），也是插件缺席时的回退。
- **插件 UI**（`SettingsRegistry.registerUi`）：`ui` 元数据与显示条件。插件通过 `ctx.settings.register` 贡献设置行，注册表把它叠加到核心描述符上。
- **插件独有的设置**：核心没有该键时注册完整描述符（`register`），读取方使用 `Settings.getSettingValue`，由描述符默认值兜底。
- **条件**：写成 `{ key: "memory.backend", equals: "<id>" }`。GUI 与 TUI 求值同一个对象，不要新增宿主专属的条件名。
- **卸载**：移除插件只移除 UI 叠加层；已存值、默认值和后端行为不变。不要为了隐藏一行而删除核心描述符。

## 给后端插件新增一行

1. 核心 schema 保留 `type`/`default`/`values`/`credential`，删除该键的 `ui` 块。
2. 在领域模块（`src/<domain>/settings.ts`）声明设置行，带上声明式条件。
3. 在插件的 `apply` 中注册：`ctx.settings.register({ key, type, default, ui })`。
4. 补测试：挂载时该行出现在 `getSettingsForTab`，卸载后消失；插件缺席时 `Settings.get`/`getSettingValue` 仍返回默认值；凭据行仍被遮罩。
5. 在所属后端文档中说明该行由插件提供。

## 新增 DSH 式页面

DSH 让每个插件拥有自己的 Config schema 和 Plugins 页。MusePi 目前保留一个统一设置页：当前后端的行显示在后端页头下，其他后端的行由条件隐藏。

要让某个后端拥有独立页面：

- 增加桌面端 `settings.section` 条目（或带导航行的 `SectionId`），渲染 `SchemaTabSection` 并传入 `groups={[backendGroup]}`；
- 跨后端设置（`memory.backend`、维护、自动学习）留在共享页；
- 页面只负责展示描述符；值仍在 `Settings` 中，设置行仍归插件。

## 检查清单

- [ ] 设置键没有改变；现有配置文件继续生效。
- [ ] 插件缺席时，值与默认值仍可读，行为不变。
- [ ] 密钥行的 `credential` 仍留在核心描述符上。
- [ ] 条件是声明式的，GUI 与 TUI 都能求值。
- [ ] 测试覆盖挂载、卸载、缺席默认值和凭据遮罩。
- [ ] 所属后端文档注明这些行由插件提供。
