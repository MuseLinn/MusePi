# @musepi/gui

MusePi desktop GUI — an Electron shell around a React SPA that speaks the
musepi daemon's JSON-RPC protocol (`@musepi/sdk`). The shell manages windows,
tray, daemon lifecycle and the managed in-app browser; the renderer is the
MusePi chat/board experience you see on desktop.

## Layout

```
packages/gui/
  electron/        Electron main process (main.cjs, preload, tray, updater, …)
  *.html + *-main.tsx   Renderer entries — one SPA per window type
  src/styles/      Tailwind CSS source (build:tailwind emits tailwind.out.css)
```

### Renderer entries

| Entry | Window |
| --- | --- |
| `index.html` → `main.tsx` | Main chat window |
| `pet.html` → `pet-main.tsx` | Desktop pet window |
| `bubble.html` → `bubble-main.tsx` | Content bubble (permission/status overlay) |
| `pin.html` → `pin-main.tsx` | Pinned board card window |
| `tray-menu.html` → `tray-menu-main.tsx` | Tray menu renderer |

### Electron main process (`electron/`)

| File | Purpose |
| --- | --- |
| `main.cjs` | Window management — hiddenInset title bar keeps native traffic lights, full-bleed window, spawns the highlight worker |
| `preload.cjs` | Exposes the daemon lifecycle bridge as `window.electronAPI` (renderer detects the desktop shell by its presence) |
| `daemon.cjs` | Daemon probe/spawn lifecycle — reads the `ws.port` file next to `daemon.sock`, resolves `musepi serve`, polls until ready |
| `tray.cjs` | Menu-bar/tray controller with a live activity indicator (idle / busy / unseen) — openchamber tray parity |
| `updater.cjs` | OTA updater — checks a version manifest and hands the renderer the download URL |
| `managed-browser.cjs` | Managed in-app browser — the SAME instance the agent drives (persistent partition, login state survives) |
| `highlight-worker.cjs` | Tree-sitter syntax highlighting in a forked process (keeps the main loop responsive on large code blocks) |
| `glow-preload.cjs` | Minimal preload for the computer-use glow overlay (isolated from main-window controls) |

## Commands

| Command | What it does |
| --- | --- |
| `bun run dev` | Vite dev server (port 5173, strict) |
| `bun run build` | Tailwind → bundle all entries → pdf worker / dist fixes / haptics |
| `bun run desktop` | Build + relaunch GUI + `electron .` |
| `bun run desktop:dev` | Dev-mode desktop (watched build + Electron) |
| `bun run pack` | `electron-builder --mac dir` + codesign (unsigned ad-hoc) |

## Docs

The GUI follows its own living specs — keep them in sync with every GUI
behavior change:

- `docs/gui-design.md` — design/interaction standards (dialogs, keyboard,
  model identity `provider/id`, i18n, CSS-only interactions)
- `docs/gui-implementation.md` — daemon RPC contracts, gotchas, verification
  workflow
