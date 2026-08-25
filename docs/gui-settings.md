# MusePi GUI Settings Panel & Theme Design (Current-State Reference)

English | [中文](gui-settings.zh-CN.md)

> Status: In sync with the current implementation of `packages/gui` / `packages/desktop-web` (2026-08-04).
> Earlier planning drafts (gui-architecture / gui-migration / gui-prototype) have been deleted — the implementation has shipped. Together with **`docs/gui-design.md`** (design spec) and **`docs/gui-implementation.md`** (implementation notes), this document is one of the three current references (split into two docs on 2026-08-06).

## 1. Desktop Shell & Entry Point

- **Electron** (`packages/gui/electron/main.cjs`, loads `packages/gui/dist/index.html`) — not Tauri as planned by the early documents.
- Launch: `bun run desktop` = `bun run build && electron .`; `bun run desktop:run` only starts Electron (**no rebuild**, so after changing code you must manually run `bun run build`).
- The renderer connects to the daemon (`musepi serve --port`) via `RpcClient` (JSON-RPC over WebSocket).

## 2. Settings Panel Layout

`SettingsView` (`packages/gui/src/components/SettingsView.tsx`) replaces the workspace full-window, in three parts:

```
gui-settings-view          ← flex:1 fills the shell (flex ROW); size does not follow tab content
├─ gui-settings-drag       ← 28px window drag bar
└─ flex row
   ├─ nav column (w-64)    ← grouped navigation (Basics / AGENT capabilities / Data & stats) + bottom guidance
   └─ gui-settings-main    ← flex:1
      └─ gui-settings-surface ← rounded floating card (same style as gui-chat-surface:
           m-2 + rounded-2xl + var(--color-surface) + 0 4px 24px shadow)
         └─ gui-settings-content ← centered column width:100% / max-width:840px /
              margin-inline:auto (openchamber SettingsPageLayout parity)
```

- **Rounded card**: a rounded, shadowed card consistent with the main chat area, separated from the left navigation over the frosted-glass background. The earlier "flat, no card" experiment was rejected by the user; the card was restored.
- **Content column**: 840px centered, symmetric side margins; padding `calc(32px * density)` / `calc(48px * density)`.
- **Sections**: `.gui-settings-section` (1px border-t divider, no divider on the first section) + title/description; field rows `.gui-settings-field` (224px label-column grid, right-aligned controls); toggle rows `.gui-settings-row`.
- Sidebar nav items, group titles, and dropdown controls were all ported following openchamber 1.18 styling.

## 3. Theme System (Three Orthogonal Axes)

`packages/desktop-web/src/lib/theme.ts` + `packages/desktop-web/src/styles/tokens.css`:

| Axis | DOM attribute | Values | Storage key |
|---|---|---|---|
| Color scheme | `data-theme` / `data-color-scheme` | `light` / `dark` (always resolved explicitly, no system) | `omp-collab-theme` |
| Accent color | `data-accent` | `brand` / `mono` / `ocean` / `jade` / `custom` | `omp-collab-accent` (+ `omp-collab-accent-custom`) |
| UI theme | `data-ui-theme` | Light: `default` / `warm` / `cool`; Dark: `default` / `midnight` / `graphite` | `omp-collab-ui-theme-light` / `-dark` |

- **Resolution rule**: `data-ui-theme` takes the light-theme choice when the scheme is light, and the dark-theme choice when dark; tokens.css scopes presets as `[data-theme="light"][data-ui-theme="warm"]`, so light presets never leak into the dark scheme.
- **Custom accent**: after the user picks a color in settings, `applyAccent()` writes the whole `--accent` family inline (`--accent-fg` dark/light per WCAG luminance, `--accent-muted` at 18% opacity, `--accent-hover` brightened for dark scheme / darkened for light scheme, `--accent-bd` at 35%, `--brand-mark-gradient` gradient); switching back to a preset clears the inline variables and restores the tokens.css preset blocks.
- The top-bar `AccentToggle` only cycles through the 4 presets; custom colors are managed in the settings panel.
- **Module init pitfall**: `initThemeModule()` must be called at the end of the file (all preceding `let` stores must already be initialized); `applyResolvedTheme` triggers `applyUiTheme` + `applyAccent`, and wrong ordering crashes with TDZ errors.

## 5. Frosted Glass

- Glass recipe: `color-mix(in oklab, var(--bg-overlay) var(--gui-glass-overlay, calc(N% * var(--gui-glass-alpha, 1))), transparent)` (N = 40/55/88).
- `--gui-glass-alpha` = transparency slider (30–90%, `musepi-gui-glass`).
- **Window transparency toggle** (`musepi-gui-glass-enabled`): when off, sets `--gui-glass-overlay: 100%` so all glass surfaces become opaque and hides the slider; when on, removes that variable.
- **Native window glass** (2026-08-04): the desktop window uses `vibrancy: "under-window"` + `backgroundColor: "#00000000"` (no need for `transparent: true`), letting the desktop wallpaper show through the window; base.css's `body { background: var(--bg) }` is overridden to transparent by gui.css's `html body` rule (browser visitors unaffected); `.gui-shell` is transparent, while the sidebar/nav rail/detail panels use `color-mix(…, transparent)` semi-transparent overlays, and the chat card/settings card stay opaque. The toggle also calls `setVibrancy`/`setBackgroundColor` through the `gui-vibrancy` IPC channel (`BrowserWindow.fromWebContents(event.sender)` — you cannot use `event.sender` directly; that is a WebContents).
- Desktop runtime: **Electron 43.2.0** (Node 24.18; upgraded from 37 on 2026-08-04; 37 is EOL). The natives loader's `import.meta.dir ?? import.meta.dirname` fallback is unnecessary under Node 24 but harmless.

## 5. Appearance Page Sections

- **Localization**: language / time format / first day of week.
- **UI settings**: UI theme (system/light/dark), light theme, dark theme (independent choices), UI font size, UI font family, spacing density (`--gui-density` unitless factor, 1=100%; calc multiplication must use numbers, not percentages), accent color (4 presets + custom), window transparency toggle + frosted glass opacity, background tint.
- **Code settings**: light/dark code themes (GitHub/One/Solarized etc., orthogonal to the UI theme), show line numbers, wrap long lines, code font size, code font family, terminal font size.
- **Code preview**: two CodePreviewCard instances side by side; the currently active scheme carries an "active" badge.
- **Effects**: avatar toggles, etc.

## 6. Code Highlighting (added 2026-08-04)

- Highlights chat code blocks and settings previews on desktop by reusing the **same Rust tree-sitter as the TUI** (`@musepi/pi-natives` `highlightCode` → ANSI lines).
- The renderer is sandboxed, so native modules load in the main process: `main.cjs` `gui-highlight` IPC handler → `preload.cjs` exposes `electronAPI.highlightCode` → `packages/gui/src/lib/highlight.ts` (`nativeHighlight`/`useChatHighlight`, GitHub-style token palettes per light/dark scheme).
- Pure conversion functions live in desktop-web `transcript/highlight.ts` (`ansiLineToHtml`/`highlightToCodeHtml`); `Markdown` receives them via the `CodeHighlightProvider` context; browser visitors have no bridge → plain-text fallback.
- Markdown code blocks carry `data-hl-hash` (FNV-1a); an effect caches async highlights by hash, so streaming re-renders do not re-invoke the bridge.
- Known pitfall: Electron 37 / Node 26 lacks `import.meta.dir`; the natives loader needs the `?? import.meta.dirname` fallback (fixed, 2026-08-04).

## 7. Key Gotchas

- CSS calc multiplication: `calc(28px * var(--gui-density, 1))` is valid; `var(--gui-density, 100%)` (a percentage operand) is invalid — the entire declaration silently fails (padding becomes 0, no error reported).
- Self-referencing custom properties are forbidden in tokens.css (`--border: var(--border)` turns the token guaranteed-invalid and every border in the app disappears).
- Reference implementation: openchamber has been upgraded to **v1.18.0** (local checkout at `/Users/muselinn/harness-engineering/openchamber`, tag `v1.18.0`).
