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
- ⛔ 真机/模拟器未验证：`devecocli device list` 无设备；模拟器要求固件开启虚拟化
  （本机 `VirtualizationFirmwareEnabled = False`），所以没下载镜像。
  接一台开了 USB 调试的鸿蒙手机后：`devecocli run` 直接装机启动。
- 注意：本机命令行工具链调用要清掉代理环境变量（`HTTP_PROXY`/`HTTPS_PROXY`），
  否则 `devecocli` 的登录与云接口会报 `Invalid proxy authorization`。

### 工程结构

工程结构已从 hvigor 5 模型升到 `modelVersion: 6.0.0`（根 `oh-package.json5`、
`entry/oh-package.json5`、`hvigor/hvigor-config.json5` 三处），并补了缺失的
`entry/hvigorfile.ts`（每个 module 必须有）；`compatibleSdkVersion` 仍是 `5.0.0(12)`。
`hvigor-config.json5` 里给了 `nodeOptions.maxOldSpaceSize: 8192`——打包 32 MB rawfile 时
默认 daemon 堆会 OOM（`00306056`）。

## 桥接

页面侧 `window.harmonyNative`（javaScriptProxy，同步 JSON 字符串返回）：
`getSystemBars` / `getBadge` / `setBadgeCount` / `clearBadge` / `consumeDeepLink` /
`setBackDepth`。

原生推送（runJavaScript）：`window.__harmonyDeepLink(uri)`（暖启动深链）、
`window.__harmonyKeyboard(vp)`（IME 高度）、`window.__harmonyBack()`（消费一次返回）。

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
