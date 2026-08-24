# MusePi 移动端设计规范（Mobile Companion）

> 2026-08-24 定稿。范围：`packages/mobile`（Capacitor Android 壳）+ `packages/desktop-web` 的
> `mobile.html` / `mobile.tsx` / `mobile.css` 移动入口。桌面 web（`index.html`）与本规范无关。
> 参考：openchamber `packages/mobile`（HANDOFF.md + `apps/MobileApp.tsx`）、musepi GUI 设计语言
> （`docs/gui-design.md`）、高星移动端设计惯例（Linear / Obsidian / Arc / Material3 / iOS HIG）。
> 结构：产品定位 → 信息架构 → 屏幕规格 → 组件与交互 → 视觉与动效 → 原生集成 → 无障碍 → 性能 → 验收 → 路线图。

## 1. 产品定位与设计原则

MusePi 移动端是 **桌面 agent 的"随身遥控器"**，不是桌面客户端的缩小版。用户在手机上做的事：
看桌面 agent 正在做什么、被询问时快速回应、会话结束后收通知回来继续。双手被占用的场景（手机放
支架上、单手拇指操作）占比高，因此一切交互围绕 **拇指可达 + 内容可读** 设计。

设计原则（按优先级）：

1. **内容优先** — 手机屏幕的首要价值是"看见 agent 的工作现场"（transcript / workspace 状态）。
   所有 chrome（header 按钮、面板入口）必须可折叠、可隐藏，不抢占内容空间。
2. **拇指可达** — 主要操作（发送、停止、返回）放屏幕下半区；上半区只放只读信息与次要入口。
   触控目标 ≥ 44×44 CSS px（iOS HIG 44pt / Material3 48dp 的下限取 CSS px）。
3. **一次一跳** — 任何操作最多一次导航到达；不存在超过两层的页面栈（例外：设置类全屏面，见 §3）。
4. **断线韧性** — LAN 场景 Wi-Fi 切换/daemon 重启常见。连接层必须自动重连（已有 phase 状态机），
   UI 必须明确表达 `connecting / waiting / reconnecting / ended` 四种非 live 状态，且任一状态可一键恢复。
5. **原生质感** — 壳层（键盘、状态栏、安全区、返回键、通知）走 Capacitor 原生能力；内容层复用
   musepi web 设计 token（oklch 深紫表面 + 祖母绿 accent + 弹簧动效），不引入第二套视觉语言。
6. **节能** — 移动端是观察者，不是轮询器。所有订阅走 guest 协议帧（16ms 批量合并），后台不做
   定时轮询；通知由事件驱动，非前台时由原生通知呈现。

与桌面 GUI（`gui-design.md`）的关系：同一 token 体系（`tokens.css`）、同一 i18n 契约、同一弹簧动效
语言；差异只在 **布局适配**（单栏 vs 多栏）与 **原生集成面**（Capacitor 插件）。

## 2. 参考基准（设计来源）

### 2.1 openchamber 移动端（primary parity）

| 模式 | openchamber 做法 | musepi 对应/取舍 |
|---|---|---|
| 壳层 | Capacitor 包 web 构建；`mobile.html → index.html` 免运行时重定向 | ✅ 同款（`prepare-web-assets.mjs`） |
| 键盘 | `resize: "none"` + CSS inset 变量驱动（非原生 adjustResize 动画滞后） | ✅ 同款（`--mp-keyboard-inset`） |
| 状态栏 | overlay + safe-area inset + 主题色 | ✅ 同款（`setupImmersiveSystemBars`） |
| 首帧主题 | 阻塞脚本预置 `color-scheme` + 背景色，杜绝白闪 | ✅ 同款（`mobile.html` 内联脚本） |
| 会话切换 | 手机：底部 sheet；平板：常驻左侧栏；SIZE 类而非设备检测 | ⏳ 现状：header 内 popover（`ServerSwitcher`）+ workspace 卡片；P2 评估底部 sheet |
| 工作区抽屉 | 右缘滑动 → 抽屉（Changes/Files/Terminal/Notes/MCP 多 tab） | ⏳ 现状：header 面板按钮 → 全屏 panel；P2 评估抽屉化 |
| 返回键 | 分层关闭：plan → surface → drawer → chat | ❌ 缺失（本次补，§6.3） |
| 推送 | APNs/FCM + relay + presence 抑制 | ⏳ 本架构无云端：本地通知（§6.4） |
| 深链 | `openchamber://` 意图词汇表（通知/小组件/Control Center 复用） | ⏳ 现状：hash 深链（浏览器）；P2 评估原生 scheme |
| QR 配对 | mlkit 捆绑 barcode 模型离线扫描 | ✅ 同款（`@capacitor-mlkit/barcode-scanning`） |
| 安全存储 | `@aparajita/capacitor-secure-storage` 存连接 token | ✅ 同款（`secure-store.ts`） |

### 2.2 高星项目移动端惯例（采纳项）

- **Linear mobile** — 底部 sheet 承担导航（会话/工作区），全屏面只保留"设置"类；我们的面板（board/
  scheduled/files）在手机上应保持全屏但可从 header 一键往返（现状已符合），P2 迁移到抽屉。
- **Obsidian mobile** — 安全区纪律：`env(safe-area-inset-*)` 必须兜底 + 旧 WebView 固定值降级
  （已实现 `setupSafeAreaFallback`）；内容滚动容器 `overscroll-behavior: contain` 防滚动链
  （已实现）；`-webkit-overflow-scrolling: touch` 惯性滚动（已实现）。
- **Arc / 手势优先** — 边缘滑动返回、下拉刷新属于"锦上添花"，必须有且仅有一种显式等价操作
  （back 按钮 / 重连按钮）。手势永远不承载唯一入口。
- **Material3 / iOS HIG** — 触控目标 44px、输入框 ≥16px 防 iOS 聚焦缩放、IME 合成期不误触发送
  （`shouldSubmitOnEnter` + composition guard 已实现）、系统返回键与 UI 层栈一致。

### 2.3 musepi 客户端设计语言（继承，不复制）

- token：`--bg / --bg-raised / --accent(emerald) / --ring(cyan)` 等 oklch 体系，`--spring*` 弹簧曲线；
- 交互：accent 仅存在于语义强调，表面中性暖暗色（openchamber/zcode 式）；hover 态在触屏上不承担
  功能（触屏无 hover，`tr-actions` 的 hover 显示需移动端常显或点按替代 —— §5.4）；
- i18n 契约：`TranslationKey = keyof typeof zhCN`，新增文案必须进 zh-CN 与 en-US（en 即 key 直通）。

## 3. 信息架构与导航模型

### 3.1 屏幕地图

```
Connect（连接引导）                    ← 未连接 / 退出会话
  ├─ QR 扫描（原生壳）
  ├─ 配对码 + 地址（纯 ws）
  ├─ 粘贴 /collab 链接
  └─ 最近连接列表（点按直连 / 删除）
      │
      ▼ connect
Workspace（工作区，可选）              ← 多会话 host 才出现（workspace !== null）
  ├─ 项目分组侧栏（可折叠）
  └─ 会话卡片网格（working/paused/idle + 消息数 + 相对时间）
      │
      ▼ 聚焦会话
Session（会话）
  ├─ Header：返回 / 标题 / cwd / 状态（dot·gauge·avatars）/ 面板入口 / 连接切换 / 退出
  ├─ Transcript：消息流 + 工具卡片 + 图片 + mermaid + 附件
  ├─ Composer：输入 / 发送 / 停止 / queued 计数；ask 模式（select/editor）
  └─ 覆盖层：AgentsRail（右侧抽屉）· AgentDrawer（agent 详情）· 面板（board/scheduled/files）
        · ServerSwitcher popover · Toasts · Banners
```

### 3.2 层叠模型（z-order，从底到顶）

```
0   sh-app（header + main + composer 常驻骨架）
1   sh-main 内：workspace / 面板 / transcript（互斥三态）
2   sh-rail + backdrop（agents 抽屉，≤768px 绝对定位覆盖）
3   ag-drawer + backdrop（agent 详情，全屏宽 min(440px, 92vw)）
4   sh-ended / sh-banner（连接态横幅，常驻可感知）
5   sh-toasts（瞬时，4 条封顶）
```

规则：
- 同一时刻最多一层"模态覆盖"（rail / drawer / 面板三选一在手机上互斥于 transcript 之上）；
- **返回键顺序（Android）**：AgentDrawer → AgentsRail → 面板 → workspace 聚焦返回 → 浏览器默认；
- 手机上 workspace 与 session 是**平级切换**（header 返回按钮 + workspace 内聚焦），不叠加。

### 3.3 自适应规则（SIZE 类，非设备检测）

| 断点 | 布局 |
|---|---|
| > 1024px | 桌面 web 全功能（本规范不覆盖） |
| 600–1024px | 平板/折叠屏展开：connect 卡片 480px 封顶；workspace 侧栏保留桌面形态；面板全屏 |
| ≤ 640px | 手机：header 收窄、chips/度量隐藏、按钮标签隐藏、输入 16px、触控目标 44px |
| ≤ 520px | 手机窄：header 装饰控件（accent/language/avatars/dot）折叠，只留核心控制 |
| ≤ 420px | 小屏：connect 卡片全宽、配对行纵向堆叠 |

断点由 CSS `@media (max-width)` 驱动；`--safe-top/--safe-bottom/--mp-keyboard-inset` 由 JS/插件
注入（§6.1）。未来 foldable 形态（展开/折叠运行中切换）由容器查询或 SIZE 类承担，不做设备 UA 判断。

## 4. 屏幕规格

### 4.1 Connect（连接引导）

目标：**3 秒内到达最近会话**。层级：最近连接（一键）> QR / 配对码（日常）> 粘贴链接（兜底）。

- 头部：品牌 lockup + 主题/accent/语言切换（与桌面一致，`--order` 语义化排序）；
- 最近连接：`secure-store` 优先、localStorage 镜像（防隐私模式空转）；删除即 `✕`，无需确认
  （可随时重连恢复）；
- 方法卡片：QR（仅原生壳，懒加载 mlkit 保 bundle 体积）→ 配对码（纯 ws 常可用）→ 粘贴链接；
  手风琴 `useCollapseHeight` 保持挂载可动画（aria-hidden + inert 折叠态）；
- 配对流程：6 位码 + 电脑地址 → `pair.resolve`（6s 超时，友好错误文案）→ 记住地址（secure）；
- 跳过态：`sh-connect-card--empty` 空态 + "connect to a computer" 返回引导；`SKIP_KEY` 持久化；
- 错误：`localError ?? error` 单行展示，`key={shown}` 触发重渲染动画。

验收：断网时打开配对码 → 6s 内出"cannot reach the computer — same Wi-Fi?"；QR 权限拒绝 →
"scan failed — use the pair code instead"；跳过态重启后仍跳过。

### 4.2 Workspace（工作区）

- 顶部：标题 + 副文案"tap one to watch it live"；
- 卡片：标题 / working(旋转) · paused · idle 状态徽标 / 相对时间 / 消息数 / cwd（shortenPath）/ history chip；
- 项目分组侧栏：≤768px 转横向顶部限高 220px 可折叠条（`.sh-ws-sidebar`）；
- 空态："no sessions yet"。
- 交互：点卡片 → `selectWorkspaceSession(id)` 聚焦；header 返回键 → `selectWorkspaceSession(null)`。

### 4.3 Session（会话）

#### Header（移动端收敛）

桌面 header 的元素在 ≤640px 的取舍矩阵：

| 元素 | ≤640px | ≤520px | 理由 |
|---|---|---|---|
| 返回（面板/workspace） | ✅ 常显 | ✅ | 导航必需 |
| 标题 + cwd | 标题 ✅ / cwd ❌ | 标题 ✅ | cwd 冗余（卡片已示） |
| read-only / model / thinking chips | ❌ | ❌ | 只读有 banner 兜底 |
| context gauge | 只显示百分比数字（track 隐藏） | 百分比 ❌ | 数字即信息 |
| avatars / dot | ✅ | ❌ | 会话状态已由 banner/dot 表达，窄屏删 |
| 面板按钮（board/scheduled/files） | ✅ | ✅ | 核心功能入口 |
| theme / accent / language 切换 | ✅ | ❌ | 装饰性；connect 屏仍可达 |
| server switcher / rail / leave | ✅ | ✅ | 会话级操作，保留 |

触控目标：`sh-btn-icon` ≤640px 时 `min-width/min-height: 44px`（§5.3）。

#### Transcript（移动端）

- 消息行：≤640px 转纵向 flex（`.tr-row` 现有规则），gutter 上移为行首小字；
- 用户消息图片走共享叠卡（craft-agents 式）；assistant 消息无图片块（wire 类型限制）；
- **hover-only 操作（`.tr-actions`）在触屏上不可达** → 移动端常显（opacity 1）或长按菜单；
  TTS 播放按钮（`.tr-action--speaking`）恒显，不受影响；
- 滚动：`.sh-transcript` 为滚动容器，`overscroll-behavior: contain` + 惯性滚动（已实现）；
- 时间戳锚定工作计时器（`use-working-now`）以 `message.timestamp` 为准，切会话不重置（已有约束）。

#### Composer（移动端）

- 布局：输入框 + 发送/停止按钮；≤640px 隐藏文字标签（`sh-btn-label`），纯图标 44px 热区；
- 键盘：`--mp-keyboard-inset` 垫底（§6.1），输入框 16px 防 iOS 聚焦缩放（已实现）；
- IME：Enter 提交必须经过 composition guard（已实现），中文输入法候选确认不触发发送；
- ask 模式：`select` 选项大按钮（≥44px）、`editor` 预填输入框 —— 是移动端"被询问时快速回应"
  的核心路径，选项按钮必须全宽可点；
- queued 计数：`×N` 徽标（标签在 ≤640px 隐藏，数字保留）。

### 4.4 面板（board / scheduled / files）

移动端全屏（`sh-panel`），header 返回按钮（MessageSquare 图标）回 transcript；与 rail 互斥。
面板内滚动与键盘处理同 transcript 契约。P2 迁入工作区抽屉（§10）。

### 4.5 覆盖层

- **AgentsRail**：≤768px 右侧绝对定位抽屉（280px / 85vw）+ backdrop；子代理首次出现自动展开
  （autoOpenedRef，已有）；
- **AgentDrawer**：`min(440px, 92vw)` 右滑入（`ag-drawer-in` 150ms）；含 agent 名/生命周期/进度；
- **Banners**：connecting/waiting/reconnecting 横幅 + ended 全屏卡片（Rejoin / New link）；
- **Toasts**：右上堆叠，info 4s / warning 8s / error 常驻可关，4 条封顶。

## 5. 组件与交互规范

### 5.1 手势清单

| 手势 | 行为 | 等价显式操作 | 状态 |
|---|---|---|---|
| 点按 | 全部分发 | — | ✅ |
| 返回（系统键） | 分层关闭（§3.2） | header 返回按钮 | 本次补 |
| 边缘滑动（左/右） | 会话/工作区抽屉 | header 按钮 | P2 |
| 下拉刷新 | 重连/重新拉快照 | Rejoin 按钮 | P2 |
| 长按 | （预留）复制/操作菜单 | 行内按钮 | P2 |

原则：手势从不承载唯一入口（Arc 惯例）。

### 5.2 触觉反馈（haptics）

原生壳内关键动作轻震（`navigator.vibrate`，Android WebView 支持；桌面/浏览器静默跳过）：

| 动作 | 时长 |
|---|---|
| 连接成功（QR/配对/链接） | 12ms |
| 发送消息 | 8ms |
| 停止 turn | 15ms |
| 配对失败/连接错误 | 双脉冲 30ms |

`prefers-reduced-motion` 或非原生壳 → 全部跳过。WebView 无权限 API，包 try/catch 静默。

### 5.3 触控目标与间距

- 图标按钮（header / composer 动作）≤640px：`min-width/height: 44px`；`sh-btn` 保持视觉 22px 内边距，
  热区扩展不改变视觉；
- 选项按钮（ask select / connect method / workspace 卡片）：min-height 44px（已有 connect-method）；
- 输入框：16px 字体（已有），`caret-color` 跟随 accent；
- 行距：消息行 ≥ 8px 垂直间距（已有），群组按钮间 ≥ 4px 缝隙防误触。

### 5.4 触屏无 hover 的处理

- `.tr-actions`（消息操作行）在 `(hover: none)` 设备上 `opacity: 1` 常显；
- 所有"hover 提示"信息必须同时有 `title` 属性（长按可读）；
- 卡片 hover 上浮（translateY）在触屏为 no-op，不承担功能。

## 6. 原生集成（Capacitor）

### 6.1 键盘（Keyboard）

- 配置：`resize: "none"` + `resizeOnFullScreen: true` + `autoBackdropColor: "dom"`（capacitor.config.ts）；
- 事件：`keyboardWillShow/Hide` → `--mp-keyboard-inset`（mobile.tsx `setupCapacitorKeyboardInset`）；
- 兜底：无插件壳（浏览器/旧 WebView）→ `visualViewport` 差值（>60px 才生效，`setupVisualViewportKeyboardFallback`）；
- 消费方：`.sh-composer` padding-bottom、`.sh-connect` padding（IME 顶起输入框 + connect 内
  `scrollIntoView({ block: "center" })` 提升聚焦输入）；
- 桌面 web 不加载 mobile.tsx，`--mp-keyboard-inset` 恒 0。

### 6.2 状态栏与安全区

- `StatusBar.setOverlaysWebView({ overlay: true })` + `setStyle`（跟随 `data-theme`）+ 透明背景
  （`setupImmersiveSystemBars`，boot 即执行，覆盖所有 Android 版本/ROM 的首帧闪色）；
- `--safe-top/--safe-bottom`：`env(safe-area-inset-*)` 原生支持时由 CSS 承担；旧 WebView
  （卓易通类兼容层）无 env → JS 固定 24/12px 降级 + StatusBar.getInfo().height() 精确覆盖；
- 消费方：header `padding-top`、composer/connect `padding-bottom`。

### 6.3 返回键分层导航（Android back）

- 壳：`@capacitor/app` 的 `backButton` 事件在原生壳内拦截（`mobile.tsx`）；
- 分发：`window.dispatchEvent(new CustomEvent("musepi:back"))` → Session 响应，按层栈关闭
  （AgentDrawer → rail → 面板 → workspace 返回 → 允许默认退出）；
- 桌面 web 不加载该监听，浏览器历史不受影响；
- 边界：无任何层打开时 `preventDefault` 不调用，走系统退出/最小化。

### 6.4 本地通知（无云端架构的推送等价）

- 触发：会话后台（`document.hidden`）+ 新 assistant 消息落定（timestamp 去重）；
- 内容：标题"musepi session update" + 正文 `msgText` 截 140 字符；`smallIcon: ic_stat_musepi`；
- 权限：**Android 13+ 必须先 requestPermissions，否则 schedule 静默丢弃** —— 首次连接成功即请求
  （原生壳内），拒绝后不再打扰；浏览器/桌面静默跳过；
- 前台抑制：`!document.hidden` 直接 return（转写本身即通知）；等价 openchamber presence 抑制的本地实现；
- 边界：`@capacitor/local-notifications` 懒加载（`import()`），非原生 bundle 不含插件代码。

### 6.5 QR 配对

- `@capacitor-mlkit/barcode-scanning`，barcode 模型捆绑进 APK（离线可用，无 Google Play 依赖）；
- `CAMERA` 权限 manifest 声明（`uses-permission` + 可选 `uses-feature`）；
- 结果 `displayValue` 即 collab 链接 → 直接 connect；异常 → 友好错误 + 配对码兜底。

### 6.6 深链

- 浏览器：hash 深链（`window.location.hash = link`，加载时自动连接，已有）；
- 原生：P2 —— `musepi://` scheme + 冷启动 intent stash（openchamber `deepLinks.ts` 模式），
  用于通知点击跳回对应会话。

## 7. 无障碍

| 项 | 标准 | 现状 |
|---|---|---|
| 触控目标 | ≥44px（≤640px） | 本次补 |
| 对比度 | 文本 ≥ 4.5:1（token 体系已满足，验证 `--fg-muted` on `--bg`） | ✅ |
| 焦点可见 | `--ring` cyan 焦点环（键盘导航） | ✅ |
| 语义 | `role="alert/status/alertdialog/menu"`、`aria-label`、`aria-hidden + inert` 折叠区 | ✅ |
| 动效 | `prefers-reduced-motion` 全量覆盖（sh-fade-in / drawer / reveal） | ✅ |
| 触屏无 hover | 操作行常显（§5.4） | 本次补 |
| IME | composition guard 防误提交 | ✅ |
| 缩放 | 输入 16px 防 iOS 聚焦缩放；`maximum-scale=1` 禁双击缩放（移动壳） | ✅ |
| 读屏 | 消息文本即内容（无 canvas 化 transcript） | ✅ |

## 8. 性能预算

| 指标 | 预算 | 实现手段 |
|---|---|---|
| 冷启动首帧（原生） | < 1.2s（中端 Android） | 无外部资源依赖；bundled 静态资源；阻塞脚本只做主题预置 |
| 首屏交互（connect） | < 1s | 无网络依赖，纯本地状态 |
| 连接后 transcript 首帧 | < 300ms（快照 10k 消息） | 快照分块 + 进度超时（30s）；行渲染 memo |
| 流式帧 | ≤ 16ms 批量（BATCH_WINDOW_MS） | guest 协议帧合并；message 平面隔离（TranscriptPane 独占订阅） |
| 后台（通知） | 零轮询 | 事件驱动；`document.hidden` 前台抑制 |
| 包体 | 原生插件全部懒加载（mlkit / notifications / status-bar / keyboard） | `import()` 动态导入，桌面 bundle 不含 |
| 内存 | transcript 封顶（MAX_NOTICES=50 等） | 已有 caps |

## 9. 验收标准（回归清单）

**构建**
- [ ] `bun run check:types`（desktop-web）零错误；`bun run build` 产出 `mobile.html` 入口
- [ ] `bunx cap sync` 后 Android 工程 `assembleDebug` 通过；APK 内 `index.html` = mobile 入口

**连接**
- [ ] 手机浏览器打开 `mobile.html`：配对码路径可用；QR 按钮不显示（非原生壳）
- [ ] 原生壳：QR 扫描 → 连接成功（振动 12ms）；配对码 6s 超时错误；粘贴链接提交
- [ ] 最近连接：连接一次 → 列表出现；删除即消失；重启应用仍在（secure-store）

**会话**
- [ ] transcript 流式渲染；中文输入法 Enter 确认合成、不误发消息
- [ ] 停止按钮中断 turn；queued 计数显示
- [ ] 面板往返、rail 展开/收起、agent 详情 drawer 关闭路径全部可达（含系统返回键）
- [ ] 断网 → reconnecting 横幅 → 恢复网络 → live（自动重连）；ended → Rejoin 生效

**原生**
- [ ] Android 13+ 首次连接弹通知权限；拒绝后无崩溃、无重复请求；授权后后台消息触发本地通知
- [ ] 系统返回键：drawer → rail → 面板 → workspace 逐层关闭，最后退出
- [ ] 键盘弹出时 composer 上移不遮挡；输入 16px 无聚焦缩放；状态栏图标随主题变色
- [ ] 窄屏 header 无溢出（390px 基准）；44px 触控目标热区

## 10. 路线图

### P0（现状基线，本规范固化）
connect / workspace / session / 面板 / rail / drawer / toasts / banners 全链路 + 键盘/状态栏/
安全区/QR/本地通知 + 断线状态机。

### P1（本次打磨）
通知权限请求（§6.4）、系统返回键分层导航（§6.3）、44px 触控目标 + 窄屏 header 收敛（§4.3）、
触觉反馈（§5.2）、hover-only 操作触屏常显（§5.4）、README 补设计文档入口。

### P2（2026-08-25 全部落地）
- 底部 sheet 会话切换 ✅（`SessionsSheet`，iOS 26 / 鸿蒙 6.1 悬浮毛玻璃圆角卡片，
  header 标题触发，见 §11.1）；
- `musepi://` 原生深链 + 通知点击跳会话 ✅（intent filter + `appUrlOpen`/`getLaunchUrl`
  双通道 + 冷启动 stash；通知 `extra.link` 经 `localNotificationActionPerformed` 路由，见 §11.3）；
- 应用图标角标（未读会话数）✅（`@capawesome/capacitor-badge` ShortcutBadger，小米/华为/OPPO
  启动器支持；前台恢复自动清零；`Capacitor.Plugins.Badge` 直取，规避 bundle 动态 import 解析）；
- 平板/折叠屏布局 ✅（≥768px rail 常驻为左侧栏，transcript 全宽，见 §11.4）；
- PWA 清单 ✅（`mobile.webmanifest` + mobile.html manifest link，可安装 standalone）。

### P3（后续）
- 工作区抽屉多 tab（Changes/Files/…，右缘滑动 + header 入口双通道）；
- 边缘滑动返回手势 + 下拉刷新（§5.1）；
- PWA service worker（离线缓存 connect 壳 + 前台推送抑制）。
## 11. 模拟器验证记录（2026-08-24，API 35 / Pixel 6 AVD / WHPX）

全链路真机验证（独立 collab host 桩 + local-relay，E2E 密封帧）通过项：connect 屏三种方式、
会话视图（header/transcript/composer）、≤520px header 折叠（`:has()` 生效）、44×44 触控目标、
返回键分层（面板/rail 逐层关闭，无层退出）、通知权限请求（首次连接自动触发）、后台推送 →
本地通知呈现。

模拟器调试发现并修复的真机专属 bug（桌面浏览器无法暴露）：

1. **`window.Capacitor.plugins`（小写）在真机 WebView 上恒为 undefined** —— 真实注册表是
   `window.Capacitor.Plugins`（大写），且只含 JS 模块已 import 的插件。`setupAndroidBackHandler`
   因此从未注册（返回键直接退应用）。修复：改 `await import("@capacitor/app")`（与 StatusBar/
   LocalNotifications 同模式），desktop-web 与 mobile 各补 `@capacitor/app` 依赖。
2. **同类隐患**：`setupCapacitorKeyboardInset` 原用 `window.Capacitor?.plugins?.Keyboard`，真机上
   键盘事件从不触发，`--mp-keyboard-inset` 只靠 visualViewport 兜底（精度差）。已改模块 import
   （`@capacitor/keyboard`）。

验证遗留（未修，记录在案）：

- `SecureStorage.then() is not implemented on android` —— `@aparajita/capacitor-secure-storage`
  的调用形状与插件 API 不匹配，Android 上 secure 存储静默失败；localStorage 镜像兜底可用。
- 通知调度降级 inexact alarm（无 SCHEDULE_EXACT_ALARM）——对"会话更新"通知无影响。
- 触觉反馈 `navigator.vibrate` 在模拟器无震动硬件，真机可测。

验证工具（保留，供回归）：

- `scripts/collab-host-stub.ts`（desktop-web）—— 固定 key 的 collab host 桩（E2E 密封），8s 后
  推送后台通知触发消息；配合 `scripts/local-relay.ts` 使用。
- 驱动方式：`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` → CDP 直接操作
  WebView DOM（uiautomator 无法读 WebView 内容）。

### 11.1 P2 底部 sheet（SessionsSheet，2026-08-24）

iOS 26 / 鸿蒙 6.1 悬浮毛玻璃圆角卡片。多会话工作区（本次 stub 扩展为 2 个 session）时，header 标题
变为触发按钮；点开浮动底部卡片：`blur(24px) saturate(150%)`（`--blur-3xl`）毛玻璃 + 24px 大圆角 +
顶部高光细边 + grabber 指示条 + 弹性上滑入场。实机验证通过：列表（2 items，状态 dot + cwd +
相对时间 + 消息数）、当前会话 accent 高亮 + check、点选聚焦（"Joining session…"）、点遮罩关闭、
拖拽向下 >120px 关闭。`prefers-reduced-motion` 跳过动效。

真机调试备忘：Capacitor Android 的 `androidScheme: "https"` 下，WebView 会按 mixed-content 拦截
`ws://`（LAN 明文）——但本项目实际验证 ws 可达，说明 `allowMixedContent: true` 生效；真正拦住的
是跨域 fetch（CORS，非 ws）。ws 握手在本机经 `10.0.2.2` 可达，**前提是 relay 绑定 IPv4**
（`Bun.serve` 默认可能在 Windows 绑 IPv6-only `[::]`，模拟器 IPv4 不可达——local-relay.ts 加
`hostname: "0.0.0.0"` 修复）。另修 `ROOM_PATH_RE`：collab 链接路径是 `/r/<roomId>.<key>`，原正则
`[A-Za-z0-9_-]{10,64}` 不含 `.` 导致 room key 含点时 upgrade 404/1006——扩为
`(?:[.][A-Za-z0-9_-]+)?$`，`match[1]` 仍为 roomId（E2E 密钥不参与 relay 路由）。
### 11.2 SecureStorage 修复（2026-08-25）

`@aparajita/capacitor-secure-storage` v8 导出的 `SecureStorage` 是 Capacitor 插件 Proxy：其 get
trap 拦截**所有**属性访问（含 `then`）并路由到桥接层。原 `secure-store.ts` 的 `nativeStore()` 直接
返回该 Proxy，调用方 `await nativeStore()` → `Promise.resolve(proxy)` 读取 `proxy.then` →
`createPluginMethodWrapper("then")` → 抛 `"SecureStorage.then() is not implemented on android"`
（每次启动 logcat 报错，secure 层静默回退 localStorage 镜像）。修复：`nativeStore()` 把三个
`internal*` 方法绑定进普通对象返回，调用方永远不会 await 到 Proxy 本体。真机验证：Keystore
写/读/重启持久化/删除全链路通过（`internalSetItem` → `internalGetItem` 返回原值，force-stop 后仍在）。

### 11.3 深链 + 通知点击跳转 + 角标（2026-08-25）

- `musepi://connect?link=<url-encoded collab link>` intent filter（AndroidManifest）→
  `@capacitor/app` `appUrlOpen`（热启动）+ `getLaunchUrl`（冷启动，启动画面延迟 React 挂载时事件
  已先到）→ 模块级 stash + `DEEP_LINK_EVENT`。冷启动实测：`am start -a VIEW -d musepi://...`
  直接进 Session/工作区（跳过 connect 屏），stub 收到 guest hello。
- 通知 `extra.link` 经 `localNotificationActionPerformed` → 同一 DEEP_LINK_EVENT 路由（冷启动
  通知点击跳回对应会话）。
- 角标：`@capawesome/capacitor-badge`（ShortcutBadger），后台通知时 `incrementBadge()`，
  `visibilitychange` 前台恢复 `clearBadge()`。**注意**：`await import("@capawesome/...")` 在 bundle
  运行时解析失败（bundler 未建 chunk 映射），必须走 `window.Capacitor.Plugins.Badge`（大写 Plugins，
  与既有 `setupAndroidBackHandler` 教训一致）。Pixel launcher 不支持 badge（ShortcutBadger
  `supported=false`），API 本身验证通过（set 3 → get 3 → clear 0）；小米/华为/OPPO 启动器可用。

### 11.4 平板布局 + PWA（2026-08-25）

- ≥768px：agents rail 从全屏覆盖层变为常驻左侧列（`position: static; width: 300px`，backdrop 隐藏），
  transcript 保持全宽 —— 两栏工作布局（内容 + rail），面板/工作区仍全屏（内容密集场景）。
- PWA：`public/mobile.webmanifest`（MusePi 品牌，standalone，4 尺寸图标）+ mobile.html
  `<link rel="manifest">`——安卓 Chrome 可"添加到主屏幕"。
### 11.5 引导界面重做 + 真机专属 bug 修复（2026-08-25）

用户真机反馈：扫码不可用、收起态按钮不自适应宽度、语言切换不即时、"像打开网页"。

根因与修复（模拟器 API 35 CDP 实测验收）：

1. **扫码不可用 = 缺 CAMERA 权限**：AndroidManifest 此前只有 INTERNET。补
   `<uses-permission android:name="android.permission.CAMERA" />` + scanQr 内先
   `BarcodeScanner.requestPermissions()`（拒绝则显示友好错误）。实测点击扫码 →
   系统 GrantPermissionsActivity 弹出。注意 mlkit 依赖 Google Play Services，无 GMS
   的国产 ROM（华为等）后续需加 JS 解码兜底。
2. **收起态按钮半宽竖排 = 容器布局 bug**：accordion 容器 div 复用 `.sh-connect-method`
   （flex ROW），收起时 height:0 的 collapse 体仍占 flex 位，把头部按钮挤成半宽；且容器
   与按钮双层卡面。修复：`.sh-connect-card div.sh-connect-method` 容器仅布局
   （column、透明、padding 0），头部按钮（收起）或整个容器（展开）单面承载卡面。
3. **语言切换不即时 = ConnectScreen 未订阅 locale**：t() 非响应式读取 store，切语言只
   重渲染 LanguageToggle 自身。补 `useLocale()`。实测点 toggle 后副标题
   "Connect to a computer…" 立即变 "连接同一网络的电脑"，localStorage 写入 zh-CN。
4. **质感重做（桌面语言 + 原生材质）**：背景加第三层 accent 洗光 + MusePi dot-matrix
   纹理（`radial-gradient` 22px 网格）；卡片 blur 18→28px saturate 160%、圆角 14→20px、
   24px→400px 宽、双层阴影 + 顶部高光；brand mark 16→22px；method 磁贴图标 34→40px
   squircle、圆角 10→14px、`:active` scale(0.98) 按压反馈、hover 抬升阴影、scan 磁贴
   渐变 accent 面 + 辉光；新增 accordion chevron（"›" 收起→旋转 90° 展开）；pair-row
   自适应宽度（96px 码位 + host 弹性吸收 + 按钮整行换行）；提交按钮 44px 主按钮 +
   accent 辉光；错误提示升级为玻璃警示条。实测几何：闭合态三磁贴全宽 339px、图标左置
   水平布局；展开态表单 319px 全宽在 ring 内。
