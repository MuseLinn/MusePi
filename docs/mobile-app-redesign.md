---
layout: default
title: 移动端完善化重构（鸿蒙优先）
status: living
summary: 鸿蒙/移动端壳层的导航、设置信息架构与内容适配重构记录，含真机诊断数值与决策依据。
scope:
  - apps/harmony
  - apps/mobile
  - packages/client-core
---

# 移动端完善化重构（鸿蒙优先）

> 2026-11-16。起因：展开态导航栏压住内容、内容被拉成通栏网页；设置只有一层、且部分与远程实例无关的项被 `client` 门禁挡住。参考实现读了 `references/dsh-go`（Flutter，`docs/design/page-design.md`、`docs/design/settings-ia.md`）、`references/bitfun`（`scripts/mobile-ui-design-system.mjs`）、`references/openchamber`（`packages/mobile`）。

## 1. 现状诊断（真机数值）

设备：HUAWEI Pura X Max 典藏版，API 26，展开态 2584×1828 px / 密度 2.75 ≈ 940×665 vp。
诊断命令：`devecocli ui layout`（`[left, top, right, bottom]`，设备 px）。

| 现象 | 证据 | 结论 |
|---|---|---|
| 侧栏压住内容、标题被裁 | `Row [22,129,176,305]` 侧栏（72vp），页面内容从 `66px` 起 | 页面没吃到左侧 72vp 让位：壳推 `__harmonyChrome` 的那次 `runJavaScript` 在页面注册处理器之前，丢了；`onPageEnd` 又只在加载时补发 |
| 展开态像通栏网页 | Web `[0,107,2584,1828]`，骨架行宽 ~850vp | 单栏 Web 布局被拉满 940vp，没有第二栏，也没有阅读列约束 |
| 状态栏区域是窗口底色 | Web 顶边 = 107px（状态栏高度），未铺满 | 中间 `Column` 未随根 Stack 展开，Web 不在 `env(safe-area-inset-top)` 覆盖区 |
| 断线弹窗盖住设置 | 无关闭按钮的 `alertdialog` 覆盖整屏 | `phase === "ended"` 时无条件渲染阻塞层，与当前目的地无关 |
| 设置只有一层 | `MobileSettings.tsx` 单文件 5 行 + 3 个条件段 | 缺子页；`管理电脑` 段要求 `client && phase && onSwitchTo && onLeave`，未连接时连"已保存的电脑"都管理不了 |

## 2. 参考实现里可复用的规则

`dsh-go/docs/design/page-design.md` 的核心：**内容做主角，界面退后一步**；所有页面归到五种骨架，同骨架的顶部、间距、分组必须一致。

| 骨架 | 结构 | MusePi 对应页面 |
|---|---|---|
| A 枢纽页 | 大标题 → 概览卡 → 分组（组标题小而淡，行带图标底色） | 设置首页、全部功能 |
| B 详情页 | 页头（图形+标题+一行状态+2–3 个数据）→ 胶囊页签 → 内容卡 | 会话详情、电脑详情、引擎 |
| C 列表页 | 大标题 → 胶囊筛选 → 列表（左 32 图形 / 主标题 / 副标题 / 右侧元信息） | 会话列表、已保存电脑、插件 |
| D 表单页 | 标题+一句话 → 分组输入 → 底部固定主按钮（贴键盘） | 配对码、远程链接、重命名电脑 |
| E 弹层 | 拖把手 → 标题行 → 内容 → 至多一个主按钮；圆角 28，左右 20 | 半模态、模型选择、主机切换 |

`settings-ia.md` 的三条可直接抄：

1. **按意图分组，不按技术模块**：AI / 能力 / 外观 / 通用 / 主机 / 帮助与关于。
2. **能进入子页的行，右侧显示当前值**（"跟随系统"/"标准"/"中文"），首页只做导航，不放放宽保护、删除、重置。
3. **首页行数有预算**：6 组 29 行；再多就折进子页。

## 3. MusePi 的信息架构

```
连接（未连接时的主页，骨架 A/D）
├─ 已保存的电脑（骨架 C，可进入电脑详情 B）
├─ 扫码 / 配对码 / 远程链接（骨架 D，鸿蒙为原生半模态 E）
└─ 跳过，直接进会话

会话（骨架 B，宽屏为「列表 + 对话」两栏）
├─ 会话列表栏（宽窗口常驻 280vp，手机为半模态 E）
└─ 对话：transcript + composer 留在 WebView

设置（骨架 A，全部本地可用，不依赖连接）
├─ 外观：主题 / 强调色 / 字号 / 语言 / 动效
├─ 底栏：材质、显示页签（鸿蒙）
├─ 通知：本地通知开关、免打扰
├─ 语音：识别模式、播报音色
├─ 电脑：已保存电脑（增删改）、中继说明      ← 去掉 client 门禁
├─ 存储与隐私：缓存占用、清除本地数据
└─ 帮助与关于：版本、许可、诊断日志、连接排障
```

**解耦规则**：设置里的每一行都标注影响面（本机 / 当前电脑 / 当前会话）。只有"当前电脑"的行需要连接；其余一律可用。首屏没有连接时，设置仍然完整。

## 4. 鸿蒙原生实现（优先）

### 4.1 组件树

```
Index (根 Stack)
├─ Web            // 只负责 transcript / composer / 渲染型内容
├─ SidePanel      // 宽窗口常驻：会话列表 + 三个目的地（替换 72vp 图标栏）
├─ BottomTabs     // 手机：悬浮 Tabs
├─ SettingsStack  // 原生设置：hub → 子页（Navigation + NavDestination）
└─ Sheets         // 连接表单、会话切换、确认类（半模态）
```

设置从 WebView 迁到原生，是这次重构的核心：它是纯列表/表单，没有渲染型内容，留在 WebView 只会继承网页端的间距与控件语言。

### 4.2 状态与桥

设置项目前存在 Web 的 `localStorage`。改为**单一真相在原生**（`Preferences`），Web 只读：

| 方向 | 方法 | 说明 |
|---|---|---|
| Web → 原生 | `getPrefs()` / `setPref(key, value)` | 迁移期 Web 仍可写；原生写入后推 `__musepiPref(key,value)` |
| 原生 → Web | `__musepiPref(key, value)` / `__musepiTheme()` | 页面收到后套用到 `data-theme` / `--accent` / `--gui-font-scale` |
| 原生读页面 | `getWindowForm()` / `getSystemBars()` / `getChromeLayout()` | 已有 |

`AppStorage` 存运行时窗口态；`Preferences` 存用户设置（跨启动）。

### 4.3 视觉规范（落到 ArkTS 常量）

| 项 | 值 |
|---|---|
| 卡片圆角 / 弹层圆角 | 18 / 28 |
| 行高（设置行 / 列表行） | 58 / 72 |
| 分组标题 | 13fp、600、`fg` 60%、下距 10 |
| 行标题 / 说明 | 16fp / 13fp，说明 `fg` 55% |
| 内容左右边距 | 手机 16，宽窗口按阅读列（760–880）居中 |
| 强调色 | 由页面 `--accent` 同步（`setAccentColor`），不再各自硬编码 |
| 触控目标 | ≥44vp，行内控件 44×44 |

## 4.4 已知缺陷（2026-11-16 第二轮真机）

| 现象 | 根因 | 下一步 |
|---|---|---|
| 原生设置改成浅色后，图标栏/列表栏仍是深色玻璃，重启后又变回深色 | **主题有两个持久化方**：网页 `localStorage` 与原生 `Preferences`。启动时网页先按自己的 `localStorage` 推 `setThemeColor(true)`，把原生的 light 覆盖回 dark | 让壳成为唯一写入方：页面启动时若 `getPrefs()` 非空则不推 `setThemeColor`；网页侧写入改为只走 `setPref` |
| 材质遮罩用的是系统明暗而不是页面明暗 | `backgroundBlurStyle({colorMode: SYSTEM})` | 已改为按 `themeDark` 传 `DARK`/`LIGHT`（仍需上一条修完才可见） |

## 4.5 分栏归属（2026-11-16 第三轮，模拟器验证）

**布局归壳，内容归页**：WebView 由壳按 `railWidth + listPaneWidth + insets.left` 内缩（`width: calc(100% - Xvp)` + `margin-left`），页面不再用 `--harmony-rail` 自己算躲避量。原因：折叠屏内屏只有 680vp，页面靠 CSS 变量算出的内边距与卡片 `max-width` 交互后会把连接卡片推到列表栏下面（实测 `ui layout` 里卡片从 457px 起、被 220vp 列表遮住左半）。

分档：

| 窗口 | chrome | 会话列表 | 设置 |
|---|---|---|---|
| sm / 折叠合拢 332vp | 底部悬浮胶囊 | 无 | 单栏（列表 → 详情） |
| md / 折叠展开 680vp | 底部悬浮胶囊 | 220vp（可拖 180–360+），列表与内容并列 | 双栏（一级列表 + 二级详情） |
| lg / xl ≥840vp | 底部悬浮胶囊 | 260vp | 双栏 |

模拟器注意事项：`emulator create --device-type foldable` 可建折叠实例，`emulator fold open|close|half-open --target <name>` 切形态；**模拟器必须用 `RenderMode.ASYNC_RENDER`**（真机仍用 `SYNC_RENDER`），否则页面白屏——用 `deviceInfo.productModel` 含 `emulator` 区分。`half-open` 在模拟器上不改变窗口尺寸（无折痕带），悬停态的落位只能真机验。

## 5. 分期

| 期 | 内容 | 验收 |
|---|---|---|
| **P0** | ① 展开/折叠让位可靠性：页面在 `resize`/`orientationchange` 主动同步 chrome ✅ ② 断线不再劫持非会话页 ✅ ③ 原生设置：hub（通用/关于）+ 外观（主题/强调色/字号）+ 语言 + 底栏材质；`PrefsStore`（Preferences）与页面双向镜像 ✅ | 真机已验：展开态侧栏不压内容；原生设置改强调色后页签/半模态按钮同步变蓝；关闭设置回到原页签 |
| **P1** | ① 宽窗口三栏 ✅ ② 材质+描边 ✅ ③ 设置停靠+动效 ✅ ④ 拖拽分栏 ✅ ⑤ 设置补全：电脑/诊断二级 ✅ ⑥ 会话搜索 ✅ ⑦ 更新弹窗 ✅ ⑧ 电脑列表离线可管理 ✅ ⑨ 沉浸光感全局化（`systemMaterial` 覆盖卡片/分段/按钮，厚度跟「界面材质」偏好，API<26 回退）✅ ⑩ 设置改「一级列表+二级内容」双栏（md+ 均生效）✅ ⑪ 折叠态设置去模态：底栏保留、无 ✕ ✅ ⑫ 导航统一回底部悬浮胶囊（无图标栏）✅ ⑬ 底栏外部区域沉浸一体：Tabs 容器透明、设置页背景铺满到屏幕底、展开态设置页底栏不被盖住 ✅ | 模拟器已验：折叠态设置页底部悬浮 tab 可见、右上无 ✕；展开态设置双栏（一级列表/二级详情），点一级 tab 右侧内容切换正常；主界面/设置页/折叠态底部均无独立色带，胶囊悬浮于页面之上 |
| **P2** | ① 连接页原生化：tab 0 改为原生 ArkTS 连接页（品牌锁标/设置入口、离线提示、已保存电脑玻璃卡片、扫码/配对/链接三方法行、错误与跳过；配对与链接复用原生半模态表单，扫码仍走 WebView 的 getUserMedia+jsQR；凭据不镜像原生——`setHosts` 只收公开元数据、点击行把 id 交回页面解析连接）✅ ② 设置剩余子页（通知/语音/存储与隐私）③ 安卓与网页同步五骨架 token；页内菜单「设置」入口收敛 | 真机已验（Pura X Max 典藏版）：连接页渲染/配对码 sheet/跳过↔返回/设置入口双栏/扫码（系统权限→QrScanner 全屏、底栏隐藏）/设置分隔条拖动；智感握姿真机生效 |

## 6. 与网页端的分工

- **留在 Web**：transcript、composer、Markdown/工具卡、diff、文件预览——这些是渲染密集且与桌面共享的内容。
- **迁到原生**：导航（页签/侧栏/列表栏）、设置、连接表单、主机管理、确认类弹层。
- **共享的只有数据**：原生不复制业务状态，页面对原生只暴露已本地化的字符串与意图（`pick|new|hosts|settings|closed`）。
