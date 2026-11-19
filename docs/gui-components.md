---
layout: default
title: Component catalog
status: living
summary: Index of the reusable GUI components, their ownership, and the token families they consume.
scope:
  - apps/desktop
  - packages/client-core
---

# MusePi component catalog

[中文](gui-components.zh-CN.md) | English

> This is an **index**, not a new contract: each component's rules still live in `docs/gui-design.md` (intent and standards), `docs/gui-widget-spec.md`, `docs/gui-dialog-spec.md`, and the code itself. This file only answers "does it already exist, where, and when should I use it".

## How to use this catalog

1. **Check here before writing a component.** `AGENTS.md` requires convergence: the same interaction in a second place is a signal, a third is a defect, and a fourth copy must be preceded by extracting a named primitive. If it is listed, use it.
2. **Ownership decides how you change it.** `client-core` components are shared by desktop and mobile, so both need verifying; `desktop` components serve the desktop shell only.
3. **No styles inside components.** Geometry, colour and motion read from `tokens.css`; a component file carries structure and behaviour only.

## Tokens (single source of truth)

`packages/client-core/src/styles/tokens.css` is the only authority for design variables — roughly 500+ declarations. Families and what they are for:

| Family | Purpose | Notes |
| --- | --- | --- |
| `--bg-*` / `--fg-*` | Theme surface and foreground | Derived from the active theme; all 18 presets and both schemes follow |
| `--border-*` / `--glass-hairline*` | Dividers, card hairlines | One ladder for the glass system; do not invent another |
| `--glass-*` | L1 cards / L2 floats / L3 interaction states | See `gui-glass.css`; loaded last, single authority |
| `--accent-*` | Accent family | Theme hue or an explicit override |
| `--radius-*` | Six-step radius ladder | **Literals are banned**; enforced by `scripts/check-radius-tokens.ts` |
| `--space-*` | 4px spacing rhythm | |
| `--spring-*` / `--gui-motion-*` | Motion curves and durations | Both `prefers-reduced-motion` and the motion toggle must switch off together |
| `--ease-appear` / `--ease-dismiss` / `--ease-one-take`, `--duration-one-take`, `--one-take-offset`, `--one-take-exit`, `--one-take-enter` | Arrival/exit fades and shared-surface (one-take) timing | `::view-transition-group` takes `--ease-one-take` + `--duration-one-take` (280ms); its old/new snapshots take `--one-take-exit` (120ms) / `--one-take-enter` (180ms) with the appear/dismiss pair and `--one-take-offset`. WAAPI flights read the same pair through `oneTakeMotion()` |
| `--z-*` | Stacking levels | Floats, modals and tips have their own tiers |
| `--gui-grip-*` | Splitter grip geometry and three states | See `SplitterGrip` below |

## Desktop shell (`apps/desktop/src/components/`)

| Component | Purpose | When to use |
| --- | --- | --- |
| `GuiSelect` | Frosted dropdown | Any enum choice; renders as the segmented control when there are two options |
| `ContextMenu` | The unified floating menu | **Every** floating menu; never invent another menu style |
| `SplitterGrip` | The pill for a resizable seam | Any new splitter; **never hand-write `<span className="gui-split-grip">`** |
| `WorkspacePageHeader` | Page-level title header (icon/title/description/actions) | Board, task center, capability center and similar pages |
| `RightRail` | The 44px right-edge icon column | The entry point to the right panel; **must render even while the panel is collapsed** |
| `ContextPanel` | The right panel itself (tabs, split, maximize) | The only container for right-panel content |
| Host bands for `SplitterGrip` | `.gui-resize-x--side` / `.gui-pane-resize-x` / `.gui-dock-handle` | The positioning layer for each of the three seams |

## Shared components (`packages/client-core/src/components/`)

Shared by desktop and mobile; changes must be verified on both.

| Group | Component | Purpose |
| --- | --- | --- |
| `shell/` | `Segmented` | Segmented control (one thumb); **every** multi-way choice uses it |
| `shell/` | `Composer` | Composer input, shared by desktop and mobile |
| `shell/` | `HeaderBar` / `MobileTabBar` / `MobileSettings` | Shell navigation |
| `shell/` | `ConfirmDialog` / `Banners` / `Toasts` / `ApprovalCard` | Confirmation, banners, toasts, approvals |
| `shell/` | `DotMatrixMark` / `MatrixLoader` / `ShinyText` / `BlurText` | Brand and loading motion |
| `common/` | `FoldRegion` | Collapsible region |
| `common/` | `SearchField` | One search field for every list filter (`field` 34px / `compact` 28px / `touch` 44px); surface from `--control-*` tokens |
| `panels/` | `BoardPanel` / `FilePanel` / `ScheduledPanel` / `VoicePanel` / `WorkspacePanel` | Right-panel surfaces |
| `agents/` | `AgentsPanel` / `AgentDrawer` | Subagent HUD and detail |
| `marketplace/` | `MarketplaceGrid` / `MarketplaceCard` / `MarketplacePanel` | Marketplace grid (the capability page re-skins it, never copies it) |
| `charts/` | `BarChart` / `LineChart` / `Donut` / `Gauge` / `KLine` / `Sparkline` | Charts |
| `progress/` | `ProgressMeter` | Progress |
| — | `image-lightbox` / `image-morph` / `image-zoom` | Image viewing |

## Dialogs and boards

- Every dialog goes through `DialogFrame`; rules in `docs/gui-dialog-spec.md` (size tiers, scroll container, focus, modifier specificity).
- Board and inline card geometry, registration parity and source text rules are in `docs/gui-widget-spec.md`.

## Known gaps (recorded, not resolved)

Building this catalog surfaced two places that are still not converged. Keep them in mind when changing things:

1. **Interaction-state naming is not unified.** `--glass-hover*` covers generic hover, while component-specific three-state sets like `--gui-grip-*` are newer; a new component must decide whether to reuse the former or open a family by the naming rule.
2. **CSS contract tests cover only radius and the grip.** Outside `scripts/check-radius-tokens.ts` and `test/splitter-grip.test.ts`, most component styles have no guard.

When adding a component, update its row here and record the contract it follows in `docs/gui-design.md`.

## Guards (code beats prose)

A prose rule is advisory; a check is a contract. Where a standard can be verified mechanically, it has a guard wired into `bun run check:tools`, so breaking it fails CI rather than review:

| Guard | Enforces |
| --- | --- |
| `scripts/check-radius-tokens.ts` | No literal `border-radius`; every `--radius-*` is defined |
| `scripts/check-disabled-hover.ts` | A class with a `:disabled` rule excludes the pointer in `:hover` (`:hover:not(:disabled)`) or resets it (`:disabled:hover`); generated asset bundles are exempt |
| `scripts/check-splitter-grip.ts` | Only `SplitterGrip.tsx` may emit the grip class; the drag state keys off the pill's own `data-resizing`, never the global `body.gui-resizing`; the retired `.gui-resize-grip` stays gone |
| `test/splitter-grip.test.ts` | The grip primitive's tokens, three states, and seam geometry |

A new guard must be proven to fail on the unfixed tree before it is trusted (see `.agents/rules/testing.md`: a guard that passes both ways guards nothing).
