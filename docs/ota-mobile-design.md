# 安卓 OTA 更新方案(@capgo Web-layer OTA)

> 面向 `packages/mobile`(Capacitor 8 壳,web 代码在 desktop-web,v0.4.4,Android versionCode 2 / versionName 0.4.4)。
> 2026-08-26 调研(见 `/tmp/android-ota-research.md`)后立项。桌面端 OTA 见 `docs/ota-update-design.md`(electron-updater),本文件仅覆盖移动端。

- **状态**: 方案文档(待实现)
- **日期**: 2026-08-26

## 1. 机制选择

**@capgo/capacitor-updater(web-layer OTA,主路径)**:

- 只更新 WebView bundle(HTML/CSS/JS/assets),**不改原生层**——不动 capacitor.config/native 插件时无需重新打包 APK。
- 免商店、免未知来源授权;Android 上无需安装权限。
- 回滚语义完整:原生启动失败自动回退上一成功 bundle;可手动 reset()。
- 中国市场:默认 api.capgo.app 与 *.r2.cloudflarestorage.com 可能不可达 → **自托管 bundle**(任意 HTTPS 静态主机,GitHub release asset 亦可),CLI `--external <url>` 只存下载链接。

**兜底(非主路径)**:GitHub release + APK 手动下载安装——`update-manifest.json`(version + notes 双语)作为桌面/移动兼容的"版本公告"格式,移动端读取它做 changelog 展示;实际更新由 Capgo 驱动。

**排除**:Play Store 分发(上架/国内不可用)、应用内 APK 安装(Android 12+ 未知来源授权 + FileProvider + 签名校验,复杂度高且恶意面大)。

## 2. 配置

### 安装(待实现步骤)

```bash
cd packages/mobile
npm install @capgo/capacitor-updater
npx cap sync
```

### capacitor.config(建议)

```ts
const config: CapacitorConfig = {
  // 自行控制检查/下载/应用时机(不自动拉流)
  plugins: {
    CapacitorUpdater: {
      autoUpdate: "off",
    },
  },
};
```

### 上传/托管

- 自托管:构建 web bundle → 上传静态站(或 GitHub release asset)→ `npx @capgo/cli@latest bundle upload --external <url>` 只登记下载链接(规避 api.capgo.app)。
- 版本公告:`packages/gui/update-manifest.json` 维持 `{ version, url, notes: { zh, en } }`;移动端启动时读取用于 changelog 展示(不驱动更新)。

## 3. 更新流程(热插拔可管理)

1. **检查**:启动/resume 时 `CapacitorUpdater.getLatest()`(或手动"检查更新")。
2. **下载**:静默 `download()`(后台,不阻塞 UI)。
3. **应用**:用户确认或按策略 `set()` → `notifyAppReady()`;`set()` 后 WebView 换 bundle 无需重启原生。
4. **回退策略(可管理,不自动回退)**:`notifyAppReady()` 成功才保留新 bundle;失败/异常由用户或策略决定 `reset()` 回上一版本——**不强制自动回退**(用户可配置:失败时保留旧版本、展示恢复入口)。
5. **时机**:appStateChange 变后台时应用,切换前 SplashScreen.show()(防白屏)。

## 4. 安全与边界

- 自托管 URL 必须 HTTPS(Android 7+ cleartext 限制)。
- bundle 校验:Capgo 托管不强制签名;自托管可加校验(下载后 hash 检查)。
- 只能改 web 层:改 capacitor.config/native 插件必须重发原生版 APK。
- iOS 18.4 simulator 已知 Capgo 不稳定(本产品暂只出 Android,记录备查)。
- 大 bundle:开 Capgo delta 上传(路径不能含空格、不能有 0 字节文件)。

## 5. 实现清单

- [ ] `packages/mobile` 安装 @capgo/capacitor-updater + cap sync
- [ ] capacitor.config 配 autoUpdate off
- [ ] 打包脚本输出可上传的 bundle(web assets)+ 文档命令(上传自托管)
- [ ] 移动端启动检查 + "检查更新"入口(若存在设置界面)(GAP:移动端当前无应用内设置 UI,先在启动时静默 check + 系统通知/横幅提示)
- [ ] update-manifest.json 保持 version+notes 双语(已存在,复用)
- [ ] 真机 Android 验证:下载/应用/回退闭环

## 6. 参考

- 桌面 OTA:docs/ota-update-design.md(electron-updater v6.4.1 + GitHub provider)
- 调研报告:2026-08-26 scout(方案对比 + Capgo API 要点,见 commit 说明)
