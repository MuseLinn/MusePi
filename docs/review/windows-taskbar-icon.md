# Windows 任务栏与窗口图标：诊断与修复

## 现象

Windows 安装版和开发版的任务栏按钮显示 Electron 的默认图标，而不是 MusePi 品牌图标。

## 证据

三处证据彼此独立，指向同一个根因：打包产物的窗口图标文件不存在。

1. **已安装应用的 `app.asar` 里根本没有 `build/` 目录。** 读取 `%LOCALAPPDATA%\Programs\MusePi\resources\app.asar` 的头部目录树，顶层只有 `dist/`、`electron/`、`vendor/`、`node_modules/`。`main.cjs` 的 `ICON_PATH` 是 `path.resolve(__dirname, "..", "build", "icon.png")`，打包后即 `app.asar/build/icon.png`，该路径必然加载失败，窗口图标退回 Electron 的默认图标——这正是用户看到的结果。
2. **exe 资源图标本身是正确的。** 用 `System.Drawing.Icon.ExtractAssociatedIcon(MusePi.exe)` 提取 32×32 图标，与 `build/icon.ico` 的 32×32 帧逐像素比较：1024 个像素 0 差异（365 个透明像素两边一致）。`build/icon.ico` 含 16/24/32/48/64/128/256 七个 PNG 帧，`build/icon.png` 是 1024×1024 RGBA。因此不需要更换 exe 图标，也不该改 `win.icon`。
3. **打包配置漏了图标文件。** `apps/desktop/package.json` 的 `build.files` 只有 `dist/**/*`、`electron/**/*`、`vendor/**/*` 与几个原生依赖；`directories.buildResources: "build"` 只负责 exe/安装器图标，electron-builder 还会把 buildResources 目录整体排除出 app 归档（`app-builder-lib/out/fileMatcher.js` 自动插入 `!build{,/**/*}`）。这两条叠加，`build/icon.png` 从未进入安装包。

## 根因

窗口图标和 exe 图标是两条独立链路：

- exe/安装器/快捷方式图标来自 `win.icon: "build/icon.ico"`，由 electron-builder 在构建期嵌入，一直是品牌图标。
- 任务栏与窗口标题栏图标来自 `BrowserWindow({ icon })` 在运行期读取的图片。该图片位于 `build/`，没有随应用归档发布，所以运行期加载为空。

`app.setAppUserModelId("com.musepi.gui")` 在模块顶层、早于所有窗口创建执行，与本次问题无关（它负责 Windows toast 归属与任务栏分组身份），保持不变。

## 修改

1. `apps/desktop/package.json`：`build.files` 增加 `build/icon.png`。该条目排在自动排除规则之后，electron-builder 的匹配器按顺序让显式包含覆盖此前的排除，因此文件进入 `app.asar`，`ICON_PATH` 在打包后解析成功。没有改变 `directories.buildResources` 的语义，也没有把整个 `build/` 打进安装包。
2. `apps/desktop/electron/main.cjs`：
   - 主窗口原有 `icon: ICON_PATH` 保留；迷你对话窗口是第二个会在任务栏露面的顶层窗口，补上同一个图标。
   - 启动时若 `ICON_PATH` 不存在，主进程输出一条 `[main] window icon missing …` 错误，避免同类打包遗漏再次无声回退。
   - pet、bubbles、tray-menu、pin、glow 五个窗口都设置 `skipTaskbar: true`（托盘弹窗、桌宠、气泡、置顶卡片与全屏光效），不会产生任务栏按钮，因此不传窗口图标；这一点写在 `ICON_PATH` 的定义注释里。
3. 新增 `apps/desktop/scripts/verify-windows-icon.mjs`（`bun run verify:taskbar-icon`）与 `apps/desktop/test/taskbar-icon.test.ts`：前者在 Windows 上校验品牌资源、exe 图标像素、`app.asar` 是否包含 `build/icon.png`；后者校验图标资源与打包配置，并在存在 `release/win-unpacked` 时自动跑一次真实产物校验。

## 开发模式（`electron .`）的边界

开发模式运行的是共享的 `electron.exe`，任务栏按钮的宿主进程是 Electron 而不是 MusePi；它不能代表安装版的任务栏身份，也不是有效的验证环境。不要用 dev 专用图标把它掩盖成“看起来对了”的结果，任务栏/窗口图标必须用打包产物验证：

```powershell
# 在 apps/desktop 目录
bun run build
bun run pack:win
bun scripts/verify-windows-icon.mjs --package release/win-unpacked --require-package
```

`--package` 指向 electron-builder 的应用目录（含 `MusePi.exe` 与 `resources/app.asar`）。不带参数时脚本会先找 `release/win-unpacked`，再找 `%LOCALAPPDATA%\Programs\MusePi`；对旧安装版运行时可能因缺少 `build/icon.png` 报 FAIL，这是预期的回退信号，重新安装新构建后应通过。

## 复核结果与未覆盖

- 已用已安装的 0.7.7 版 `MusePi.exe` 与 `app.asar` 记录修复前证据：exe 图标与 `build/icon.ico` 的 32×32 帧逐像素一致；asar 顶层没有 `build/`。
- 本轮在 Windows 上实际执行 `bun run pack:win`（electron-builder 26.15.3，Electron 45.3.4）生成 `release/win-unpacked`，再用 `node scripts/verify-windows-icon.mjs --package release/win-unpacked --require-package` 复核：exe 图标 0/1024 像素差异、`app.asar` 含 `build/icon.png`，脚本输出 `taskbar icon check: PASS`。
- 回归防护经反向验证：临时从 `build.files` 移除 `build/icon.png` 后，`taskbar-icon.test.ts` 的打包断言按预期失败；恢复该条目后三项测试全部通过。
- 窗口图标的实际绘制（任务栏按钮截图）未做视觉抓取；验证停在“图标资源有效、主/迷你窗口都传入该路径、打包产物确实携带该文件”这三层，Electron 从 asar 读取该 PNG 的行为由同一次打包产物中的文件成员与既有用法保证。