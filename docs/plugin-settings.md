---
layout: default
title: Plugin-owned settings
status: living
summary: Where a setting's value lives, how a plugin owns its settings row, and the checklist for adding or moving one.
scope:
  - docs
  - packages/coding-agent
  - apps/desktop
---

# Plugin-owned settings

English | [中文](plugin-settings.zh-CN.md)

A setting has two owners: the core schema owns its value, type and default; the plugin that provides the feature owns its row. Keeping them separate lets a backend or feature ship its own settings surface without moving configuration or breaking a host where the plugin is not mounted.

## Ownership

- **Core schema** (`packages/coding-agent/src/config/settings-schema.ts`): `type`, `default`, `values`, `credential`. These are the read path (`Settings.get`) and the fallback when no plugin is mounted.
- **Plugin UI** (`SettingsRegistry.registerUi`): `ui` metadata and the visibility condition. A plugin contributes the row through `ctx.settings.register`; the registry overlays it on the core descriptor.
- **Plugin-only setting**: a key with no core descriptor registers a full descriptor (`register`). Its reader must use `Settings.getSettingValue`, which falls back to the descriptor default.
- **Condition**: declare `{ key: "memory.backend", equals: "<id>" }`. GUI and TUI evaluate the same object; do not add a host-specific condition name.
- **Unmount**: removing the plugin removes the UI overlay. Stored values, defaults and backend behavior stay unchanged; never delete the core descriptor to hide a row.

## Add a row to a backend plugin

1. Keep `type`/`default`/`values`/`credential` in the core schema; remove its `ui` block.
2. Declare the row in the domain module (`src/<domain>/settings.ts`) with the declarative condition.
3. Register it in the plugin's `apply`: `ctx.settings.register({ key, type, default, ui })`.
4. Add tests: the row appears in `getSettingsForTab` only while mounted; `Settings.get`/`getSettingValue` still returns the default with the plugin absent; credential rows stay masked.
5. Mention the plugin ownership on the owning backend page.

## Add a DSH-style page

DSH gives every plugin its own Config schema and a page under Plugins. MusePi keeps one settings page for now: the active backend's rows render under a backend header, and other backends' rows are hidden by their condition.

To give a backend its own page:

- add a desktop `settings.section` entry (or a `SectionId` with a nav row) that renders `SchemaTabSection` with `groups={[backendGroup]}`;
- keep cross-backend settings (`memory.backend`, maintenance, auto-learn) on the shared page;
- the page presents descriptors only; values remain in `Settings`, and the plugin still owns its rows.

## Checklist

- [ ] The setting key is unchanged; existing config files keep working.
- [ ] With the plugin absent, values/defaults remain readable and behavior is unchanged.
- [ ] `credential` stays on the core descriptor for secret rows.
- [ ] The condition is declarative and evaluates in both GUI and TUI.
- [ ] Tests cover mount, unmount, absent defaults, and credential masking.
- [ ] The owning backend page says the rows are plugin-provided.
