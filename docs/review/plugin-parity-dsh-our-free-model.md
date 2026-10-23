# 插件体系对标：`dsh-our-free-model` → auth-hub 重构与客户端补齐

状态：**分析稿（未开工）** · 对标对象 `dsh-our-free-model@2.1.0`（dsh 生态，2026-10）
证据基准：`~/.dsh/profiles/desktop/node_modules/dsh-our-free-model`；本仓库 `musepi-omp@HEAD`、`musepi-auth-hub@HEAD`

---

## 0. 摘要（三个颠覆先验的事实）

先前的判断是「我们的槽位不够多、参考插件 jet-hub 不够成熟」。逐行核实后，两条都不成立：

**事实 1 — 成熟插件只用 2 个槽位。**
`client.js` 全量 grep：宿主槽位字面量**只有两个** —— `settings.section`（`client.js:6082`）
与 `settings.onboarding`（`client.js:6090`）。九页界面全是**插件自绘的内部 tab**
（`TABS` 于 `client.js:5636`），不是九个宿主槽位。注入的宿主服务也只有
`inject = ['slots', 'locale']`（`client.js:40`）。

⇒ **槽位数量不是瓶颈。** 缺的是「一个能画自己整页 UI 的座位」和两条生命周期缝。

**事实 2 — 那 13 个渠道不是它写的。**
`src/` 里**没有任何渠道代码**；渠道全在 `vendor/channel-pack/pack.js`
（68531 行 / 2.8MB），而 `vendor/channel-pack/NOTICE.md:1-12` 明确记录它是
**`dsh-codearts-auth` 的逐字副本**（Gitee `iJetLi/deepseek-harness-codearts`，
commit `345f0a07`），仅两处本地改动（`NOTICE.md:44-49`）。

⇒ 即：`dsh-our-free-model` = **薄宿主层（2373 行）+ 薄客户端层（6162 行）+
整套 jet-hub 渠道包复用 + 现代 UI/网关/看板/自更新**。它的「全面」主要来自
**复用**，而不是重写。这正是我们该学的形状。

**事实 3 — 它识别旧凭证，是因为同一份存储。**
`FileStore.bootstrapFromCredentialRefs()`（`pack.js:29671-29700`，仅在
`state.json` 缺失时触发）读 `$DSH_HOME/.credentials.yaml`，扫 `refs:` 块，
按 `^(PREFIX)_ACCOUNT_([0-9A-Fa-f]{6,})$` 反查 provider（`pack.js:29579-29586`，
前缀按长度降序以免 `QODER` 截胡 `QODERCN`）。

⇒ 所谓「之前 jet-hub 添加的凭证也基本都识别了」，**不是智能迁移，是同一个
credential store 加上同一套 ref 命名**；只有索引被把内核升级丢下了。这也解释了
用户看到的「没有账号名」——**昵称/排序/限流时间戳在代码里被明确标为不可恢复**
（`pack.js:29667-29669`）。

---

## 1. 成熟插件依赖的宿主能力面（完整清单）

宿主端（`index.js`）：

| 能力 | 用法 | 证据 |
|---|---|---|
| **`llm` 服务** | 注册 adapter、可配置 provider、模型发现 | `index.js:436,437-439,445-457` |
| **`webServer` 服务** | **注册自己的 HTTP 路由与 SSE** | `index.js:1426-1432` |
| `credentials` | 账号存取 | `pack.js:29410,30285` |
| `connection.fetch.register` | 第二条 RPC 面（`/api/channel-pack`，~45 方法） | `pack.js:60277-60279` |
| `commands` / `attachments` / `profileContext` | 可选，`ctx.get` 或嵌套 `ctx.inject` 拿 | `index.js:1048,1688,207` |
| 生命周期 | `ctx.effect` 唯一拆卸机制；`ctx.inject` 声明「服务就绪后再跑」 | `index.js:1457-1612,1426` |
| 声明 | `inject = ['llm']` —— **唯一硬依赖** | `index.js:128` |

客户端（`client.js`）：

| 能力 | 用法 | 证据 |
|---|---|---|
| `slots` | `ctx.slots.inject(id, () => ctx.slots.register({name,id,order,label,locale}, render))` | `client.js:6082-6095` |
| `locale` | `ctx.locale.bind(NS)` + `ctx.locale.register(NS, {zh,en})` | `client.js:5961-5962` |
| `ctx.effect` | 样式/SSE/字典的拆卸 | `client.js:5962-6061` |
| **宿主主题变量** | 16 个 `--dsw-alias-*`（含 `--dsw-mask-blur`） | `client.js:1274-1275,1316` |
| `react` + **`react-dom`** | `react-dom` 用于 **portal 到 `document.body`** | `client.js:26,35,5848` |
| 自有 HTTP + SSE | `api/our-free-model/*`（46 路由）+ `EventSource(/events)` | `client.js:2152,5991` |

**关键单点**：`webServer.register({ kind: 'prefix' | 'exact', path, handler })`
（`index.js:1428,1432`）。没有它，插件只能「被宿主调用」（请求-应答），
无法：自建事件流、拥有路由前缀、服务自己的客户端资源、跑 OpenAI 兼容网关、
接 OAuth 回环回调。而这五件事恰好是这个插件的大半功能。

---

## 2. 差距表（按阻塞程度排序，均带证据）

| # | 能力 | musepi 现状 | 证据 | 补齐代价 |
|---|---|---|---|---|
| **1** | **插件自有 HTTP 路由 + SSE** | **缺**。有 `Bun.serve`（`static-web.ts:185`），但只服务静态文件 + SPA 回退 + `DAEMON_CONFIG_PATH`，**无插件注册 API** | `packages/coding-agent/src/daemon/static-web.ts:180-215` | 中。加 `server.register({kind,path,handler})` + 前缀/精确派发 + 信任围栏 |
| ~~2~~ | ~~`react-dom` 暴露（portal）~~ | **已有**（初稿判断有误，核实后撤回）。渲染端注入 `MusePiReact = { ...React, createPortal }`，portal 能力已具备，形态是 `React.createPortal` | `desktop-app/src/lib/slot-host.tsx:27`、`client-core/src/main.tsx:21` | **无需改动**。但要写进插件开发文档：这是唯一允许的 portal 入口 |
| **3** | **客户端 cordis 生命周期**（`inject` + `ctx.effect`） | **半**。`registerComponent` 是声明式注册，**组件侧无 disposer** | `client-core/.../slot-host.tsx`；`docs/plugin-extension-capability-inventory.md:217-233` | 中。重载会留重复 `<style>`、泄漏 EventSource |
| **4** | **`settings.section` 座位**（带 `{order,label,locale}` 的整节注册） | **半**。有 `settings.extensions`(list) 与 `settings.tab.<id>` | `packages/collab-proto/src/extension-slots.ts` | 小。确认 tab 能否承载整页 + 内部导航即可 |
| **5** | **命名空间 i18n** | **缺**。`registerTranslations`/`tLoose` 是**扁平全局** seam，插件 key 会撞 | `docs/plugin-extension-capability-inventory.md:226-233` | 小。加 `ctx.locale.bind(NS)` 形态 |
| **6** | **主题 token 契约** | **弱**。插件只能猜 `--color-text-faint` 之类，且宿主背景平坦 ⇒ 毛玻璃无效 | 本轮 auth-hub 面板实测 | 小。发布 token 表 + 非平坦背景层 |
| **7** | **onboarding 步骤协调** | **缺**。无该座位 | `extension-slots.ts` 无 `settings.onboarding` | 可选 |
| **8** | **凭证迁移（两份参考存储）** | **部分**。面板有「已在用 dsh-codearts-auth？」导入卡 | `ui/panel.tsx` 迁移块 | 小。加 `channel-pack/state.json` + `.credentials.yaml` 的 ref 扫描 |

**不构成差距的**（避免误修）：
- 槽位数量：`composer.*` 已 11 席、容量语义已对齐 dsh（本会话 `f406068c7`）。
- 渠道实现：我们**已有 17 个渠道原生实现 + 269 个测试**，不需要 vendored pack。

---

## 3. 方案：三阶段

### P0 — 宿主缝补齐（`musepi-omp`，先做，插件侧才谈得上重构）

| 项 | 具体做法 |
|---|---|
| **P0.1 路由注册服务** | 在 `static-web.ts` 的 `fetch` 前加一层路由表：`register({kind:'prefix'\|'exact', path, handler})`，返回 disposer；精确优先于前缀（照抄该语义，`index.js:1430-1432` 的注释解释了为何事件流必须是 exact）。**信任围栏**：只允许 loopback + 同源，参考其 `trust.js:56-107`（先 `connection.admit`，退 `requestRejection`，再退结构性回环检查）。 |
| **P0.2 `ReactDOM` 暴露** | bundle factory 增加 `ReactDOM: "window.MusePiReactDOM"`，宿主注入。让插件能用 portal（首启弹窗/对话框必须挂在 `#root` 之外）。 |
| **P0.3 客户端 cordis 生命周期** | 给插件的客户端入口一个 `ctx`：`inject=['slots','locale',...]` + `ctx.effect(disposer)`。宿主在卸载/重载时按顺序跑 disposer。这是「重载不留垃圾」的唯一正解。 |
| **P0.4 `settings.section`** | 声明该座位（`{order,label,locale}`），渲染回调收 `{t, ctx, openSection(id)}`。auth-hub 的九页都画在这一个座位里。 |
| **P0.5 命名空间 i18n** | `ctx.locale.bind(NS)` / `register(NS, {zh, en})`，与扁平 seam 并存（不破坏现有插件）。 |
| **P0.6 主题 token 表** | 在 `docs/` 发布 token 契约（至少 `--color-bg-*`、`--color-border-*`、`--color-text-*`、状态色、`--mask-blur`），并给外壳加一层**非平坦背景**（否则毛玻璃无像素可采样）。 |
| P0.7（可选） | `settings.onboarding` 座位：有序首启步骤协调，收 `{complete, openSection, explicit}`。 |

### P1 — auth-hub 重构（对齐「薄宿主 + 薄客户端 + 自有 HTTP」形状）

当前 auth-hub 是**单体 `index.ts`（3300+ 行）**，面板走 `ext.call` 请求-应答。目标形状：

1. **宿主层拆分**（`index.ts` → `src/host/`）：渠道注册、凭据、探针、签到各归其位；`index.ts` 退回装配。
2. **自有 HTTP 面**（P0.1 落地后）：`/api/auth-hub/*` —— 账号列表、余额、签到、登录轮询、**事件流 SSE**。面板从 40+ 次 `ext.call` 轮询改为**一次 SSE + 按需 HTTP**。
   - 收益直接可测：现在 3 秒一次的 `session.contextUsage` 与 120 秒的徽标轮询都是 `ext.call`；迁到 SSE 后是推送。
3. **网关 + 看板 + 日志**（参考实现有、我们没有）：本地 OpenAI 兼容网关、用量看板、请求日志环形缓冲。
4. **UI 重构**：单页多 tab（渠道 / 账号池 / 聚合 / 用量 / 网关 / 日志），自绘、自带 CSS（不再依赖猜宿主 class）。

**明确不做**：不引入 vendored 渠道包。我们的 17 个原生渠道 + 269 测试是资产，重写等于丢掉它们。

### P2 — 凭证迁移（用户最直接的痛点）

用户实测：「旧凭证基本都识别了，只是部分过期且没有账号名」。我们要做的是**读同一份存储**：

1. 扫描 `$DSH_HOME/.credentials.yaml` 的 `refs:` 块，按
   `^(CODEARTS|BUDDY|WORKBUDDY|LOBSTERAI|QODER|QODERCN|TRAE|CLINE|LOOMY|RACCOON|MINIMAX|ZCODE|GEMINI)_ACCOUNT_([0-9A-Fa-f]{6,})$`
   匹配（前缀按长度降序，避免 `QODER` 截胡 `QODERCN`）。
2. 同时读 `$DSH_HOME/channel-pack/state.json`（`dsh-our-free-model` 的索引）与
   `dsh-codearts-auth` 的旧索引，取并集。
3. **如实告知不可恢复项**：昵称、排序、限流时间戳在参考实现里就是不可恢复的
   （`pack.js:29667-29669`）。导入后账号名只能用 ref 后缀（`#a1b2c3`），
   并把「可改名」做成显式动作，而不是假装恢复了。

---

## 4. 建议执行顺序与验收

| 阶段 | 交付 | 验收方式 |
|---|---|---|
| **P0.2 + P0.6** | `ReactDOM` 暴露 + token 表 | 插件能 portal；毛玻璃在宿主背景上可见 |
| **P0.1** | 路由注册服务 + 信任围栏 | 插件注册 `/api/<ns>/*` + SSE，loopback 外被拒 |
| **P0.3 + P0.4 + P0.5** | 客户端 ctx（inject/effect）+ `settings.section` + 命名空间 i18n | 重载两次后 `<style>` 仍只有一份、无泄漏连接 |
| **P1.1-P1.2** | auth-hub 自有 HTTP + SSE，面板迁过去 | 面板零轮询；事件驱动刷新 |
| **P1.3-P1.4** | 网关 + 看板 + 日志 + 单页多 tab | 与参考实现功能对齐清单逐条核对 |
| **P2** | 两份参考存储的凭证导入 | 用真实 `.credentials.yaml` 跑一遍，报告识别数 / 过期数 / 无名数 |

**每一步都必须有可运行证据**，不接受「已实现」的自我声明。

---

## 5. 附：本次核实用到的方法（可复现）

```bash
# 槽位用量（事实 1）
rg -o "settings\.section|settings\.onboarding|conversation\.|panel\.|composer\.|rail\." \
   ~/.dsh/profiles/desktop/node_modules/dsh-our-free-model/client.js | sort | uniq -c

# 渠道是否自研（事实 2）
ls ~/.dsh/profiles/desktop/node_modules/dsh-our-free-model/src/   # 无渠道文件
sed -n '1,12p' .../vendor/channel-pack/NOTICE.md                  # 记录为逐字副本

# 宿主能力面（§1）
rg -o "ctx\.[a-zA-Z_]+" .../index.js | sort | uniq -c
rg "ctx.inject\(\['webServer'\]" -A6 .../index.js
```