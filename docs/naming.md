# Naming Convention

> Status: Active (2026-09-15). Applies to all user-facing surfaces (GUI, mobile, TUI, i18n strings).
> 中文版：[naming.zh-CN.md](./naming.zh-CN.md)

## Three layers, three rules

| Layer | Terms | Rule |
|---|---|---|
| Architecture / protocol | `host`, `guest`, collab frames, write tokens | Internal names are fine. Never surface them in UI copy. |
| Packages / directories | `packages/guest-client`, `collab-proto`, entry `mobile.tsx` | Renames are breaking changes (imports, deep links, Capacitor ids). Do NOT rename casually; batch with a dedicated RFC. |
| Product surface | Buttons, labels, placeholders, device names, transcript badges | Product language only. **`host` / `guest` are banned.** |

## Product-surface rules

1. **No internal roles in copy.** The user never reads "guest", "访客", "宿主代理", "host agent".
   - Composer placeholder uses the desktop parity string: `ask anything, / for commands, @ for context…` (zh: `问任何事，/ 命令，@ 上下文…`).
   - Device-name default / placeholder on the connect screen: `my phone` (zh: `我的手机`).
   - Transcript badge fallback for an unattributed collab prompt: `unnamed device` (zh: `未命名设备`).
2. **One brand green.** `--accent` is `oklch(0.773 0.1538 163)` = `#34d399`, matching the TUI theme (`musepi.json`), the web export palette and `--brand-mark-gradient`. The old `oklch(0.72 0.16 162)` (`#00C385`) was a conversion bug and is retired everywhere (`guest-client`, `desktop-app`, `stats`, `web-palette`).
3. **Parity before invention.** When a control exists on desktop GUI (e.g. `ModelSelector`, thinking ladder), mirror its structure, tokens and copy. Do not hand-draw sizes or invent labels.
4. **i18n keys are global.** A key may live in exactly one domain file (`i18n/zh-CN/<domain>.ts`); duplicating it across domains throws at barrel load. en files must `as const satisfies Record<ZhKey, string>`.

## Provenance

Prompt-level audit 2026-09-15: removed `t("guest")` leaks in `ConnectScreen.tsx` (device name ×4) and `Transcript.tsx` (badge fallback), replaced the composer placeholder, unified the accent token across 6 files.
