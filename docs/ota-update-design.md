# OTA 重启更新方案（electron-updater）

> 替代当前「检测更新 → 跳转 GitHub 下载」的手动流程，实现下载 → 校验 → 安装 → 重启。
> 参考 opencode / openchamber / proma / bitfun（2026-08-24 调研，见 handoff scout 报告）。

- **状态**: 实现中
- **日期**: 2026-08-24

---

## 1. 机制选择

**electron-updater v6.4.1 + GitHub provider**（opencode/openchamber/proma 三项目一致）。

- electron-builder 构建时生成平台 `latest.yml`（含 sha512/大小/releaseDate），CI 上传到 GitHub releases
- electron-updater 检查 feed（GitHub releases latest → latest.yml）、下载、校验（Windows 签名校验 / sha512）、安装（NSIS 静默 / dmg 替换 / AppImage 替换）
- 不重造轮子：参考项目全部走 electron-updater（bitfun 是 Tauri 特例，用 tauri-plugin-updater + minisign，不适配 Electron）

## 2. 配置

### electron-builder（packages/gui/package.json build 段）

```json
"publish": {
  "provider": "github",
  "owner": "MuseLinn",
  "repo": "MusePi",
  "channel": "latest"
}
```

构建时自动生成：`latest.yml`（win）、`latest-mac.yml`（mac）、`latest-linux.yml`（linux）。

### CI（gui-release.yml）

- **upload-artifact** 增加 `packages/gui/release/latest*.yml`（三平台）
- **publish job** 的 softprops files 增加 `dist/latest*.yml`
- 保留 `update-manifest.json`（daemon changelog RPC 兼容）

### updater.cjs → electron-updater

```js
const { autoUpdater } = require("electron-updater");
autoUpdater.autoDownload = false;          // 用户发起下载
autoUpdater.autoInstallOnAppQuit = false;  // 显式重启
autoUpdater.allowPrerelease = false;
```

## 3. IPC 契约

| 通道 | 方向 | 说明 |
|---|---|---|
| `updater-check` | renderer → main | 检查更新（复用现有） |
| `updater-download` | renderer → main | 下载更新（首次点击） |
| `updater-install` | renderer → main | 杀 daemon + quitAndInstall |
| `updater-state` | main → renderer | 状态推送：checking/downloading(percent)/downloaded/error |
| `update-available` | main → renderer | 启动静默检查发现新版本（复用现有） |

## 4. 渲染端流程（UpdateToast 改造）

```
[有新版本 vX → vY]  →  [下载更新] → 进度条 % →  [立即重启] → quitAndInstall
                                        (后台下载，可继续使用)
```

- 下载中显示进度（`download-progress` 事件 percent/transferred/total）
- 下载完成 → 按钮变「立即重启」；点按 → IPC updater-install → main 杀 daemon → `autoUpdater.quitAndInstall()`
- 错误 → toast 显示原因，回退「前往下载」（openExternal）

## 5. Daemon sidecar 处理

- **install 前必须杀 daemon**（openchamber killSidecar / proma hasActiveAgents 同款）：`daemon.cjs` 已有 `kill(port)`（SIGTERM→3s→SIGKILL）
- `updater-install` IPC：`await kill(daemonPort)` → `setImmediate(() => autoUpdater.quitAndInstall())`（setImmediate 确保 IPC reply 先 flush，openchamber 经验）
- daemon 随 GUI 包内 vendored，app 更新后新版 daemon 一并生效

## 6. 平台注意

- **Windows**: 未签名 NSIS 安装器 → electron-updater 校验会走 SmartScreen 提示，用户可点「仍要运行」。正式方案需代码签名（Windows 证书）。当前接受「点击确认」体验。
- **macOS**: 未签名 dmg（ad-hoc）→ electron-updater 校验失败会回退「前往下载」。Developer ID 签名后可自动替换。
- **Linux**: AppImage 替换无需签名，体验最顺。
- **优雅降级**: 校验失败 / 平台无 feed → `update-available` 仍推「前往下载」URL，不丢失现有能力。

## 7. 实施清单

- [x] 安装 electron-updater@6.4.1
- [x] electron-builder publish 配置
- [ ] updater.cjs 重写为 electron-updater
- [ ] main.cjs：updater-download / updater-install / updater-state IPC
- [ ] preload.cjs：暴露 downloadUpdate / installUpdate / onUpdateState
- [ ] electron.ts：类型扩展
- [ ] UpdateToast.tsx：下载进度 + 重启流程
- [ ] CI：latest*.yml 上传
- [ ] 验证：本地 mock feed + 手工流程

## 8. 参考

- opencode: `packages/desktop/src/main/updater.ts`（autoDownload=false + 状态机 + stop→quitAndInstall）
- openchamber: `packages/electron/main.mjs`（404→no-update + setImmediate 延迟 + macOS /Applications 检查）
- proma: `apps/electron/src/main/lib/updater/auto-updater.ts`（autoDownload=true + idle 调度）
- bitfun: `tauri-plugin-updater` + minisign（Tauri 特例，仅借鉴签名/镜像纪律）