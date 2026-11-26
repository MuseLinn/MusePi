---
layout: default
title: Plugin-owned settings
status: living
summary: How a plugin owns a setting's key, type, default and row, and the checklist for adding or moving one.
scope:
  - docs
  - packages/coding-agent
  - apps/desktop
---

# Plugin-owned settings

English | [中文](plugin-settings.zh-CN.md)

A plugin owns its settings. Its package declares the key, type and default; the host reads those values from the settings store and renders the row from the same declaration. Core code keeps only what is not a plugin's business: the selector that names which plugin is active, and the cross-cutting maintenance knobs.

## Where a setting lives

| Piece | Owner | Where |
| --- | --- | --- |
| Key, type, default, credential | The plugin that provides the feature | `config.json` beside the package, or the `musepi.config` block |
| Stored value | The settings store | `Settings` (global config, project overrides, env for some keys) |
| Row: tab, group, label, description, condition | The same plugin | `ctx.settings.register` |
| Fallback when the plugin is not mounted | The plugin's reader | The package's own defaults table |

A plugin is a Cordis fiber: `apply(ctx, config)` receives the declared config and every registration is an effect on that fiber. Unmounting removes the row and the provider; the stored value stays, and the package's reader keeps returning its default.

## Add a setting

1. Declare the field in the package's `config.json` (key, type, default, optional `restart`), and add `"host": { "configStorage": "settings" }` to the manifest so the host stores it in `Settings`.
2. Export the default from the package's settings module and read the value through it (`settings.getExtension(key)`), so readers work before mount and after unmount.
3. Register the row in `apply`: `ctx.settings.register({ key, type, default, ui })` with a declarative condition such as `{ key: "memory.backend", equals: "mnemopi" }`.
4. Test three states: mounted (row visible, value writable), unmounted (row absent, reader returns the default), and credential masking when the key holds a secret.

## Rows inside an existing page

Not every feature gets a nav row. Two seats cover the rest:

- `settings.item.<page>.<row>` — one row on a named page, rendered after that page's own content.
- `settings.subnav.<page>` — one tab in that page's segmented subnav (a prefix seat: any page id works). An entry whose `id` names a built-in tab replaces it; any other id appends. Sessions & Memory uses `settings.subnav.session-memory`, so a backend can present its pane without a new nav row.

A whole page is `settings.section` with the page's existing id: the content becomes plugin-owned, the nav row and its deep links stay. The hooks page is the smallest example.

A page whose body ships only as a contribution keeps no host fallback: the nav row follows the contribution, so an absent or failed plugin removes the page rather than opening it blank. Declare such ids in the settings nav's plugin-owned set next to the page component. 保险库, 钩子, 命令, 快捷键, 通知与音效 and 使用统计 are owned this way today.

Use `settings.section` only when the feature is a whole page.

Register the seat in `packages/collab-proto/src/extension-slots.ts` with `slot-contracts.ts`, regenerate the catalog, and document it in `docs/extensions-dev.md`.

## Composing plugins

A plugin may itself be a bundle of sub-plugins: the manifest lists `components`, and each component is its own entry with its own fiber. A component registers its own settings, tools and rows; disabling one component removes exactly its contributions. That is how a feature family ships one package without one 20-row settings page: the parent declares the components, each child owns its settings and row.

The host shows the parent's settings only when the parent is enabled; a component that is disabled contributes nothing. Two packages never own the same key — the registry refuses a second owner.

## Checklist

- [ ] The key is declared by the owning package, not the core schema.
- [ ] Readers use `settings.getExtension` and the package's defaults table.
- [ ] With the plugin unmounted, behaviour is unchanged and the row is absent.
- [ ] Credential keys are declared as credentials where the row is registered.
- [ ] The condition is declarative and evaluates in both the terminal and the desktop surface.
- [ ] The seat is registered and documented when the row lives inside another page.
- [ ] Tests cover mounted, unmounted and masking states.
