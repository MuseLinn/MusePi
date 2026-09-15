# 命名规范

> 状态：生效（2026-09-15）。适用于所有用户可见界面（GUI、移动端、TUI、i18n 文案）。
> English: [naming.md](./naming.md)

## 三层三规则

| 层 | 术语 | 规则 |
|---|---|---|
| 架构 / 协议 | `host`、`guest`、collab 帧、write token | 内部命名随意用，但**绝不能漏到 UI 文案**。 |
| 包 / 目录 | `packages/guest-client`、`collab-proto`、入口 `mobile.tsx` | 改名是破坏性变更（import、深链、Capacitor id），不要顺手改；要走专门的 RFC。 |
| 产品表层 | 按钮、标签、placeholder、设备名、transcript 徽标 | 只用产品语言。**禁用 `host` / `guest`。** |

## 产品表层规则

1. **文案不出现内部角色。** 用户永远不该读到 "guest"、"访客"、"宿主代理"、"host agent"。
   - 输入框 placeholder 与桌面端对齐：`ask anything, / for commands, @ for context…`（zh：`问任何事，/ 命令，@ 上下文…`）。
   - 连接屏设备名默认值 / placeholder：`my phone`（zh：`我的手机`）。
   - transcript 中无署名 collab 消息的徽标兜底：`unnamed device`（zh：`未命名设备`）。
2. **品牌绿只有一个。** `--accent` = `oklch(0.773 0.1538 163)` = `#34d399`，与 TUI 主题（`musepi.json`）、web 导出调色板、`--brand-mark-gradient` 一致。旧的 `oklch(0.72 0.16 162)`（`#00C385`）是换算错误，已在全部包退役（`guest-client`、`desktop-app`、`stats`、`web-palette`）。
3. **先复用再发明。** 控件在桌面 GUI 已存在（如 `ModelSelector`、思考档位），必须镜像其结构、token 和文案，不许手绘尺寸或自造叫法。
4. **i18n key 全局唯一。** 一个 key 只能存在于一个域文件（`i18n/zh-CN/<domain>.ts`）；跨域重复会在 barrel 加载时抛错。en 文件必须 `as const satisfies Record<ZhKey, string>`。

## 来源

2026-09-15 文案审计：清除 `ConnectScreen.tsx` 的 `t("guest")` 泄漏（设备名 ×4）与 `Transcript.tsx` 徽标兜底，替换 composer placeholder，accent token 在 6 个文件统一。
