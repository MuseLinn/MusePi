# MusePi HarmonyOS WebView Shell

一等地壳（非兼容层）：ArkTS `Web` 组件加载 guest-client 移动 bundle（rawfile），
沉浸/相机/权限全部原生，UI 与 Android 壳共享同一份 dist。

## 构建

```bash
# 1. 构建 web bundle
cd packages/client-core && bun run build

# 2a. 无 IDE（推荐，CI/agent）：拷资源 + 调用官方 headless CLI 出 HAP
cd ../harmony && node scripts/copy-web-assets.js && node scripts/build-hap.mjs

# 2b. 或者：DevEco Studio 打开 packages/harmony，签名后运行/出包
```

`rawfile/` 已 gitignore（构建产物）。

### 工具链要求

`devecocli`（`npm i -g @deveco/deveco-cli`）驱动 hvigor/ohpm/hdc，需要一个已安装的
HarmonyOS 工具链，二者其一即可：

| 方式 | 环境变量 | 说明 |
|---|---|---|
| Command Line Tools | `DEVECO_CLI_CLT_PATH` | 无 IDE、体积最小，构建用这个就够 |
| DevEco Studio | `DEVECO_CLI_STUDIO_PATH` | 默认探测 `C:\Program Files\Huawei\DevEco Studio` |

两者都要从 [下载中心](https://developer.huawei.com/consumer/cn/download/) 获取，
**需要登录华为账号**（官方安装文档明确要求），没有匿名下载通道。

`devecocli` 本身来自 npm（`npm i -g @deveco/deveco-cli`），装在 **node 自己的全局前缀**
（`C:\Users\universe\AppData\Local\Programs\node`）里，你的 shell 直接敲 `devecocli` 即可。

路径解析顺序（`scripts/build-hap.mjs`）：环境变量 → `local.properties`
（gitignore，键 `devecocli.clt.path` / `devecocli.studio.path`）→ Studio 默认路径。
所以「装了但没重启终端」不会再报找不到工具链。

本机已就位：CLT 26.0.0.865 解压到 `C:\Users\universe\deveco-clt\command-line-tools`
（SDK API 26 / hvigor 6.26.9 / ohpm 26.0.0），`DEVECO_CLI_CLT_PATH` 已写入用户环境变量，
`local.properties` 也写了同一路径作为兜底。

### 已验证 / 未验证

- ✅ 编译：`bun run build:hap` → `entry-default-unsigned.hap`（约 33 MB，rawfile 里带整份 web bundle），
  ArkTS 零 error 零 warn。
- ✅ 签名：`devecocli signature generate --type debug` 生成材料（存在 `~/.ohos/config/`，不入库），
  构建产出 `entry-default-signed.hap`。签名配置是**本机绑定**的，所以 `build-profile.json5`
  里的 `signingConfigs` 保持为空——自己出签名包前跑一次上面那条命令即可（材料会复用）。
- ✅ 模拟器（2026-11-11，API 26 / HarmonyOS 7.0.0，phone 镜像）：构建 → 签名 → 安装 → 启动 →
  connect → 会话主链路通过；`devecocli device app install <绝对路径> --device <serial>` 用绝对
  Windows 路径，相对路径会报 `install file path invalid`。
- ⛔ 真机未安装：`devecocli device list` 能看到已连接的手机，但本仓库没有往用户设备上装包；
  需要时用 `devecocli run --device <serial>` 自行确认。
- 代理注意：本机命令行工具链调用要清掉代理环境变量（`HTTP_PROXY`/`HTTPS_PROXY`），
  否则 `devecocli` 的登录与云接口会报 `Invalid proxy authorization`。

### 模拟器验证记录（2026-11-11）

- **首屏空白根因**：ArkWeb 异步渲染（surface，独立送显）叠加 Web 组件的 `expandSafeArea`
  时整页不送显——DOM 完整、CDP 能截到页面、窗口只剩背景色。去掉 `expandSafeArea`
  即可恢复，但切到原生 Tabs 后异步面又会丢帧，因此固定为 `RenderMode.SYNC_RENDER`；
  同步渲染下重新保留 `expandSafeArea`，由页面自己铺满系统条。代价是不走 DSS 合成，
  这个壳只有一个全屏 Web 组件，取舍可接受。
- **调试通道**：debug 构建在 `aboutToAppear` 里开 `setWebDebuggingAccess`，可用
  `hdc fport tcp:9222 localabstract:webview_devtools_remote_<pid>` 接 CDP 读 DOM/console。
  release 构建不开。
- **半模态**：`SheetOptions.systemMaterial`（API 26+）给出原生沉浸光感，`THICK` +
  `backgroundColor: Color.Transparent`；低于 API 26 回落实色背景。ArkUI 的键盘避让
  （`TRANSLATE_AND_SCROLL` / `RESIZE_ONLY`）对 `FIT_CONTENT` 面板不可用：前者只把聚焦输入框
  抬出键盘、按钮留在键盘后，后者把内容压缩掉。因此输入框用 `enterKeyType` + `onSubmit`
  在软键盘「完成」上直接提交，用户不必先收键盘再点按钮。
- `devecocli check arkts` 在删除遗留的 `bridge/HarmonyNative.ets`（无引用，且调用早已移除的
  `getPendingDeepLink`）之后零 error。
- 会话切换器（原生）：`bindSheet` + `Search` + `List` 在模拟器上验证——两行会话、搜索过滤
  （输入 `board` 只剩 Board cleanup）、点行切会话、footer 的「设置」跳转都通过。

### 工程结构

工程结构已从 hvigor 5 模型升到 `modelVersion: 6.0.0`（根 `oh-package.json5`、
`entry/oh-package.json5`、`hvigor/hvigor-config.json5` 三处），并补了缺失的
`entry/hvigorfile.ts`（每个 module 必须有）；`compatibleSdkVersion` 仍是 `5.0.0(12)`。
`hvigor-config.json5` 里给了 `nodeOptions.maxOldSpaceSize: 8192`——打包 32 MB rawfile 时
默认 daemon 堆会 OOM（`00306056`）。

## 桥接

页面侧 `window.harmonyNative`（javaScriptProxy，同步 JSON 字符串返回）：
`getSystemBars` / `getBadge` / `setBadgeCount` / `clearBadge` / `consumeDeepLink` /
`setBackDepth` / `openPairSheet` / `openLinkSheet` / `openSessionsSheet` / `setSessions`。

原生推送（runJavaScript）：`window.__harmonyDeepLink(uri)`（暖启动深链）、
`window.__harmonyKeyboard(vp)`（IME 高度）、`window.__harmonyBack()`（消费一次返回）、
`window.__musepiSessionAction(type, id)`（会话切换器的意图回传）。

会话切换器：页面把已本地化的行（标题／短路径／消息数／相对时间）打包成 JSON 调
`openSessionsSheet`，原生用系统 `bindSheet` + `Search` + `List` 渲染，点选后只回传
`pick|new|hosts|settings|closed` 与 id；列表变化时页面用 `setSessions` 刷新。会话数据与导航
仍归页面，原生不持有业务状态。

返回键：`Index.onBackPress()` 先收键盘（`imeHeightPx > 0`），再交给页面层栈
（`backDepth > 0` → `__harmonyBack()`），都没有则交回系统（应用退后台）。页面通过
`setBackDepth` 同步层栈深度——`onBackPress` 必须同步作答，等不了 `runJavaScript` 的往返。

深链：`musepi://connect?link=<collab link>`，EntryAbility onCreate（冷启动存
AppStorage）/ onNewWant（暖启动直推）。

## 旋转动效

ArkWeb 与 Android WebView 同为 Chromium 内核，共享 guest-client 的断点几何过渡
（shell.css breakpoint/rotation transitions：320ms spring，双向 morph）。
ArkUI 窗口旋转动画为系统级，Web 内容过渡由 CSS 承担——双层动效无冲突，壳无需额外代码。

## 取舍（P3）

- 凭证回退 localStorage（未接 `@ohos.security.asset`）
- 通知/语音/原生图标均为 P3
- 若要真原生体验，connect + 会话列表 ArkTS 重写是独立工程
