# GUI 迁移蓝图 — openchamber 基底

> 状态:规划完成,待实施。决策日期 2026-08-02,决策人:用户。
> 上游源码:`/Users/muselinn/harness-engineering/openchamber`(MIT,commit 见其 git log)
> 动效参考:`/tmp/border-beam`、`/tmp/thinking-orbs`(MIT,npm: border-beam / thinking-orbs)

> ## ⚠️ 现状更新(2026-08-04):迁移已实施,本文档为历史蓝图
>
> 本蓝图已按实际情况执行完毕,主要偏差:
> - **桌面壳是 Electron 不是 Tauri**(`packages/gui/electron/main.cjs`,加载 `dist/index.html`);Tauri 计划未实施。
> - Phase A-D(骨架/数据层/workbench/设置)已落地:`packages/gui` 现有 shell、会话流、审批卡、设置面板(openchamber 1.18 样式移植,含本地化/界面/代码/模型/供应商等页面)。
> - 主题体系沿用正交轴方案(`data-theme` × `data-accent`),并新增第三轴 `data-ui-theme`(浅色/深色主题独立选择)。
> - 当前设置面板与主题/磨砂玻璃的设计参考见 **`docs/gui-settings.md`**(与实现同步)。
> - 未实施:RemoteInstancesPage/QR 远程、Phase E 动效音效、Phase F 清理(按现状重新评估)。


## 1. 决策(用户拍板)

| 维度 | 决策 | 理由 |
|---|---|---|
| 基底 | **openchamber**(React 19 + Vite + Tailwind v4 + shadcn new-york) | 与现有 React 栈同构,组件可直接搬;不选 opencode app(SolidJS+Effect 生态,整体换栈) |
| 传输层 | **重写数据层**(不要 HTTP 适配层) | 做自己的 GUI,不追 openchamber 上游;上游只吸收底层优化(cherry-pick) |
| 主题 | **正交体系映射**(保留 data-theme/data-color-scheme 4 预设,映射到 openchamber CSS 变量) | 我们已完成的主题体系是资产,openchamber 用 CSSVariableGenerator,两者都是 CSS var,映射一层变量名 |
| 远程中继 | **collab-proto 为主** | 复用已有 QR/relay/加密成果(77+12 回归),openchamber 的 RemoteInstancesPage 做 UI 壳 |
| 桌面壳 | **Tauri 2(现有,不动)** | 已验证启动即用 + 自动 spawn daemon;不换 Electron |

## 2. 上游技术事实(已侦查)

- **规模**:`packages/ui/src` = 325 tsx + 710 ts,22MB。components/(302 tsx,核心 UI)、lib/(243 ts,工具)、sync/(80 ts,数据订阅)、stores/(82 ts,状态)。
- **传输接缝**:全局 `__OPENCHAMBER_API_BASE_URL__`/`__OPENCHAMBER_CLIENT_TOKEN__` 注入 + 统一 `runtimeFetch`(runtime-fetch.ts)/`openRuntimeWebSocket`(relay/runtime-socket.ts)/SSE。**所有 API 走这层** → 重写数据层的接缝清晰。
- **sdk 耦合**:176 文件 import `@opencode-ai/sdk`,集中在 sync(43)/stores(15)/lib(11)/chat(13)/sidebar(13)——UI 组件层(JSX/CSS)基本不含 sdk,数据获取集中在 sync/stores,替换范围明确。
- **数据层**:`packages/web/src/api/*`(HTTP API 工厂)+ `packages/ui/src/sync/*`(sync-context/session-message-loader/permissionStore,useAllLiveSessions 等 hooks)——与我们的 useSyncExternalStore 订阅同构。
- **核心组件**:chat/(ChatContainer/MessageList/MarkdownRenderer/ChatInput/PermissionCard/QuestionCard + message/parts + markdown)、session/(SessionSidebar/SessionDialogs + sidebar/)、sections/(设置页)。
- **主题**:ThemeSystemContext + CSSVariableGenerator,CSS-variable 驱动,shadcn new-york + Tailwind。不用 data-theme。
- **性能**:@tanstack/react-virtual 已用于 MessageList/会话列表/JSON 树/代码块(virtua 未用)。React 19 负载可控,照抄 opencode 性能配方已具备。
- **QR 远程已内置**:RemoteInstancesPage.tsx(E2EE 配对 QR,1024px)+ TunnelSettings.tsx(tunnel connectUrl QR,256px)= ZCode 手机图标弹窗完整实现,迁移是移植不是新建。
- **依赖链**:@codemirror 全套、@pierre/diffs、@tanstack/react-virtual、@dnd-kit、@base-ui/react、@simplewebauthn、@xenova/transformers、@zumer/snapdom、beautiful-mermaid、capacitor 系列(移动端用,桌面可裁)。

## 3. 目标结构(musepi-omp/packages/gui)

```
packages/gui/
  src/
    app.tsx                 ← 现有入口,改为渲染新 workbench
    vendor/                 ← openchamber 组件(复制,改造)
      components/chat/        ← 消息流/composer/审批
      components/session/     ← 会话树/会话列表
      components/sections/    ← 设置页
      components/…            ← 其余可复用 UI
      lib/                    ← 上游工具(复制)
      sync/                   ← 重写:接 daemon JSON-RPC
      styles/ index.css       ← Tailwind v4 + 主题变量映射
    lib/                    ← 现有:RpcClient(JSON-RPC)/session-store/主题
    styles/                 ← 现有:gui.css → 迁移为 Tailwind + 正交主题变量
  src-tauri/                ← 现有壳,不动
```

## 4. 实施阶段(每个阶段独立可验证)

### Phase A — 骨架与主题映射
- 复制 openchamber `index.css`(Tailwind v4 配置)+ shadcn 基础 tokens
- 正交体系映射:在 tokens.css 生成 openchamber 需要的 CSS 变量名(变量值来自 data-theme/data-color-scheme 解析)
- 验收:空 workbench 用新主题渲染,深浅双轴 + 4 accent 切换生效

### Phase B — 数据层重写
- `lib/daemon/` :RpcClient 扩展为 openchamber API 形状(request<JSON-RPC> 映射 system.meta/session.*/workspace.*/tool.*)
- 重写 `sync/` :useAllLiveSessions/useSessionMessages/usePermissions → 接 RpcClient 订阅
- 验收:会话树 + 消息流从真实 daemon 拉数据渲染

### Phase C — 核心 workbench
- 移植 ChatContainer/MessageList/MarkdownRenderer/ChatInput
- 移植 SessionSidebar + 会话树(现有 SessionTree 可并)
- 移植 PermissionCard/QuestionCard(审批内联卡升级)
- 验收:完整会话工作流(选会话→看消息→发消息→审批)在 daemon 上跑通

### Phase D — 设置与远程
- 移植 sections/ 设置页(通用/外观/模型/服务器)
- RemoteInstancesPage → 接 collab-proto relay(QR 复用)
- 验收:设置改主题/语言生效;手机扫码连接

### Phase E — 动效音效增强
- thinking-orbs:思考状态动画(自动检测 data-theme,兼容)
- cuelume:交互音效(hover/press/toggle,Web Audio 2KB)
- aicss:对话流组件补充(thinking/tool-call/streaming-text)
- border-beam:点缀动画边框
- 验收:工作台动效/音效流畅,Performance 无卡顿(合成层动画)

### Phase F — 清理
- 删现有 gui.css 残留、未迁移组件、冗余依赖
- 全量回归(daemon/collab/gui)+ Tauri 实机

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 176 处 sdk import 替换量大 | 集中在 sync/stores,先重写这两层,组件层 import 自然消解 |
| openchamber 依赖链重(codemirror/capacitor 等) | 只装 workbench 实际用的;capacitor(移动端)裁剪 |
| 上游更新难以吸收 | 决策已定:只 cherry-pick 底层优化,不整体同步 |
| Tailwind v4 与现有 gui.css 冲突 | Phase A 先做主题映射验证,不混用类名 |
| 迁移中途会话中断 | 本文档是接续契约,每 Phase 独立可验证 |

## 6. 验收总纲

- `bun run build` + `bun run check:types` + biome 全绿
- daemon/collab/gui 回归全过(现 162/79/0 + 新组件测试)
- Tauri 实机:启动即用(自动 spawn)→ workbench 渲染 → 主题/审批/远程可用
- 动效流畅:滚动 60fps、动画走合成层、无长任务卡顿

## 7. 数据层接口契约(Phase B 实现依据,2026-08-02 确认)

现有 `packages/gui/src/lib/session-store.ts` 的 `GuiSessionStore` 已是
openchamber sync 层的等价物,无需重写,只需暴露/补充:

| openchamber hook | 来源 | 现状 |
|---|---|---|
| `useAllLiveSessions` | `session.tree` RPC | GUI 已有 `refreshSessions`→`setTree` |
| `useSessionMessages` | `session.subscribe` 流 → `GuiSessionStore.apply` | ✅ 已有(entries/state/cursor) |
| `useSessionPermissions` | 审批事件 → `#approvals` | ✅ 已有(ApprovalCard 数据源) |
| `useSessionQuestions` | ask 事件 | ⚠️ 待扩展(Phase 5) |

**契约**:openchamber vendor 组件消费的是「sessionId → 会话快照 + 订阅流」,
现有 `GuiSessionStore` + `RpcClient` 就是这个接口。Phase B 只需:
1. 在 vendor 组件外层包一个 React context(以 `useSyncExternalStore` 订阅
   `GuiSessionStore`,和现有 `useStore` 一致)
2. 把 vendor 组件的 sdk import 替换为这个 context 的 hook
3. 不需要碰 RpcClient/ws-transport(JSON-RPC 层已稳定)

**主题变量映射已落地**(commit f4e2460):tokens.css 的 shadcn 兼容层
(`--background`/`--card`/`--primary`/`--muted`/`--sidebar`/`--ring`/`--chart-*`)
由正交主题驱动;shadcn 的 secondary `--accent` 暴露为 `--oc-accent`(避免
与 legacy 品牌主色 `--accent` 冲突,base.css focus/caret 依赖后者)。
