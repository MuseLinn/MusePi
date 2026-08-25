# MusePi HarmonyOS WebView Shell

一等地壳（非兼容层）：ArkTS `Web` 组件加载 desktop-web 移动 bundle（rawfile），
沉浸/相机/权限全部原生，UI 与 Android 壳共享同一份 dist。

## 构建

```bash
# 1. 构建 web bundle
cd packages/desktop-web && bun run build

# 2. 拷贝进 rawfile（mobile.html → index.html）
cd ../harmony && node scripts/copy-web-assets.js

# 3. DevEco Studio 打开 packages/harmony，签名后运行/出包
```

`rawfile/` 已 gitignore（构建产物）。

## 桥接

页面侧 `window.harmonyNative`（javaScriptProxy，同步 JSON 字符串返回）：
`getSystemBars` / `getBadge` / `setBadgeCount` / `clearBadge` / `consumeDeepLink`。

原生推送（runJavaScript）：`window.__harmonyDeepLink(uri)`（暖启动深链）、
`window.__harmonyKeyboard(vp)`（IME 高度）。

深链：`musepi://connect?link=<collab link>`，EntryAbility onCreate（冷启动存
AppStorage）/ onNewWant（暖启动直推）。

## 旋转动效

ArkWeb 与 Android WebView 同为 Chromium 内核，共享 desktop-web 的断点几何过渡
（shell.css breakpoint/rotation transitions：320ms spring，双向 morph）。
ArkUI 窗口旋转动画为系统级，Web 内容过渡由 CSS 承担——双层动效无冲突，壳无需额外代码。

## 取舍（P3）

- 凭证回退 localStorage（未接 `@ohos.security.asset`）
- 通知/语音/原生图标均为 P3
- 若要真原生体验，connect + 会话列表 ArkTS 重写是独立工程
