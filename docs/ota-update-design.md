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

- **upload-artifact** 增加 `packages/gui/release/*.yml`（三平台，含 beta 通道的
  `beta*.yml`）与 `*.zip`（macOS OTA 必需，见 §9）
- **publish job** 的 softprops files 增加 `dist/*.yml` 与 `dist/*.zip`
- 保留 `update-manifest.json`（daemon changelog RPC 兼容）

### updater.cjs → electron-updater

```js
const { autoUpdater } = require("electron-updater");
autoUpdater.autoDownload = false;          // 用户发起下载
autoUpdater.autoInstallOnAppQuit = false;  // 显式重启
// 注意：不要手动设 allowPrerelease。electron-updater 6.4.1 按当前版本号自动推导：
// 版本含 prerelease 段（如 0.4.5-beta.1）→ true（跟 beta/alpha 通道），
// 稳定版本号 → false（只看 GitHub /releases/latest，天然隔离 prerelease）。
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
## 9. Beta 通道与三平台安装机制核对（2026-08-24）

### 9.1 Beta/release 通道区分

**约定**：tag 含 `-beta`（如 `v0.4.5-beta.1`）→ prerelease 发布 + `beta` 打包通道；
正式 tag → 行为与此前完全一致。

| tag 形态 | GitHub release | electron-builder publish | 上传的 update feed |
|---|---|---|---|
| `v0.4.5` | 正式 release | channel `latest`（默认，不改） | `latest.yml` / `latest-mac.yml` / `latest-linux*.yml` |
| `v0.4.5-beta.1` | **prerelease** | `-c.publish.channel=beta` | `beta.yml` / `beta-mac.yml` / `beta-linux*.yml` |

CI 实现（gui-release.yml）：

- Package 步骤：`GITHUB_REF_NAME` 含 `-beta` → 追加 `-c.publish.channel=beta`。
  electron-builder 26.15.3 据此把 feed 文件命名为 `{channel}{平台后缀}.yml`
  （win 无后缀、mac `-mac`、linux `-linux[-arch]`），并把 `channel: beta` 写进
  安装包内嵌的 app-update.yml——安装版从此固定跟该通道。
- publish 步骤：softprops action 加 `prerelease: ${{ contains(github.ref_name, '-beta') }}`。
- upload-artifact / gh-release 的 yml 通配从 `latest*.yml` 放宽为 `*.yml`
  （否则 beta 构建的 feed 文件根本不会被上传——这是本次核对抓到的关键缺口）。

### 9.2 electron-updater 6.4.1 通道语义（源码级核实，非文档转述）

`GitHubProvider.getLatestVersion()`：

- **稳定版安装**（版本号无 prerelease → `allowPrerelease=false`）：tag 取自 GitHub
  `/releases/latest` API（**排除 prerelease**），读 `latest*.yml`。beta release 对
  稳定用户完全不可见。
- **beta 安装**（如 `0.4.5-beta.1` → 自动 `allowPrerelease=true`，currentChannel=`"beta"`）：
  扫描 releases atom feed，跳过 alpha 与未知通道，取最新一个正式版或 beta 版 tag；
  该 tag 是 beta → 读其 `beta*.yml`；是正式版 → 先试 `beta*.yml`（404）→ **回退
  `latest.yml`**。即 beta 用户在正式版发布后会自动升级到稳定版。
- 双保险：即使 beta 安装的 app-update.yml 被改回 latest，prerelease release 也因
  `/releases/latest` 排除 prerelease 而不会推给稳定版。

### 9.3 三平台安装/更新核对结果

**Windows（NSIS assisted，v0.4.4 起）** —— package.json `build.win/nsis` 静态核对通过：

- `oneClick:false` + `perMachine:false`（HKCU，免管理员）+ `allowToChangeInstallationDirectory:true`；
  升级时 NSIS 读已装注册表项预填原安装路径。
- 卸载入口两处齐备：开始菜单「Uninstall MusePi」（assisted 安装器随快捷方式生成卸载
  快捷方式）+ 设置→应用列表（`uninstallDisplayName: "MusePi ${version}"` 写入 HKCU
  Uninstall 注册表）。
- `deleteAppDataOnUninstall:false` 卸载保留 `%APPDATA%` 数据；
  `installerLanguages: ["zh_CN","en_US"]` + `language:"2052"` 中文优先。
- OTA：NsisUpdater 读 `latest.yml`/`beta.yml`，静默换装。

**macOS**：dmg 手动拖装不变。OTA 有一个硬性修复：MacUpdater 要求工件里有 `.zip`
（源码 `findFile(files, "zip", ["pkg","dmg"])`，无 zip 抛
`ERR_UPDATER_ZIP_FILE_NOT_FOUND`）——原 `mac.target:["dmg","dir"]` 下 mac 自动更新
必然失败。已补 `"zip"` target 并在 CI 上传/发布清单收录 `*.zip`（附带获得 blockmap
差量下载）。未签名（ad-hoc）下校验失败仍按既有降级走「前往下载」。

**Linux**：AppImage/deb 手动安装；AppImageUpdater 替换自身文件无需签名，
读 `latest-linux[-arm64].yml`。

**update-manifest.json（daemon 兼容链路）不受影响**：它经
`releases/latest/download/` 重定向分发，GitHub 该端点同样排除 prerelease——
beta release 不会劫持 daemon 的版本探测。

### 9.4 验证方式

静态核对：package.json build 配置 ↔ gui-release.yml 步骤 ↔ electron-builder 26.15.3 /
electron-updater 6.4.1 node_modules 源码三方一致性。未本地跑 electron-builder
（网络/时长约束）；首个 beta tag 建议发布后人工验证一次「beta 安装收到 beta 推送、
稳定安装无感知」。
