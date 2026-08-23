# @musepi/gui

MusePi 桌面 GUI —— 包裹在 React SPA 外的 Electron 壳，SPA 通过 musepi daemon
的 JSON-RPC 协议（`@musepi/sdk`）通信。壳负责窗口、托盘、daemon 生命周期与受管
内置浏览器；渲染端就是桌面上看到的 MusePi 对话/看板体验。

## 结构

```
packages/gui/
  electron/        Electron 主进程（main.cjs、preload、tray、updater…）
  *.html + *-main.tsx   渲染端入口——每种窗口类型一个 SPA
  src/styles/      Tailwind CSS 源（build:tailwind 产出 tailwind.out.css）
```

### 渲染端入口

| 入口 | 窗口 |
| --- | --- |
| `index.html` → `main.tsx` | 主对话窗口 |
| `pet.html` → `pet-main.tsx` | 桌面宠物窗口 |
| `bubble.html` → `bubble-main.tsx` | 内容气泡（权限/状态悬浮层） |
| `pin.html` → `pin-main.tsx` | 看板卡片 pin 窗口 |
| `tray-menu.html` → `tray-menu-main.tsx` | 托盘菜单渲染器 |

### Electron 主进程（`electron/`）

| 文件 | 职责 |
| --- | --- |
| `main.cjs` | 窗口管理——hiddenInset 标题栏保留原生红绿灯、窗口全出血，spawn 高亮 worker |
| `preload.cjs` | 以 `window.electronAPI` 暴露 daemon 生命周期桥（渲染端据此识别桌面壳） |
| `daemon.cjs` | daemon 探测/拉起生命周期——读 `daemon.sock` 旁的 `ws.port` 文件、解析 `musepi serve`、轮询就绪 |
| `tray.cjs` | 菜单栏/托盘控制器，带活动指示（idle / busy / unseen）——openchamber tray 对齐 |
| `updater.cjs` | OTA 更新——检查版本 manifest，把下载 URL 交给渲染端 |
| `managed-browser.cjs` | 受管内置浏览器——与 agent 驱动的是同一个实例（持久 partition，登录态不丢） |
| `highlight-worker.cjs` | fork 进程里跑 tree-sitter 语法高亮（大代码块不卡主循环） |
| `glow-preload.cjs` | computer-use 光晕浮层的极简 preload（与主窗口控件隔离） |

## 命令

| 命令 | 作用 |
| --- | --- |
| `bun run dev` | Vite dev server（端口 5173，严格占用） |
| `bun run build` | Tailwind → 打包全部入口 → pdf worker / dist 修复 / 触感 |
| `bun run desktop` | 构建 + 重启 GUI + `electron .` |
| `bun run desktop:dev` | 开发模式桌面（监听构建 + Electron） |
| `bun run pack` | `electron-builder --mac dir` + 签名（ad-hoc 未签名） |

## 文档

GUI 遵循自己的活体规范——每次 GUI 行为变更都要同步：

- `docs/gui-design.md` —— 设计/交互标准（对话框、键盘、模型标识 `provider/id`、
  i18n、CSS-only 交互）
- `docs/gui-implementation.md` —— daemon RPC 契约、踩坑、验证工作流
