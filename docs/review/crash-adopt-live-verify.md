# 崩溃后不重启的收敛实测（24a1c86d / 8f9b131f）

在真实 Electron 环境里验证：一条长运行工具执行到一半时强杀 daemon，不重启应用，
观察窗口里的运行状态、未完成工具标记与自动重连后的状态是否收敛。驱动脚本是
`apps/desktop/scripts/verify-crash-idle-adopt.mjs`；本记录保存当次实跑的计时、结论与环境注意事项。

## 被验证的行为

- `GuiSessionStore.adoptIdleState()`：崩溃的回合永远等不到 `agent_end`，断线时就地丢弃
  这个无人能结束的运行标记，停止胶囊不会永久钉住。
- `ChatView` 在自认为仍在运行时每 5 秒重读 `session.pendingToolCalls`，采信 daemon 的
  `working:false`。
- `session.pendingToolCalls` 命名崩溃分支中未获结果的工具调用；GUI 同时渲染卡片内的
  `tools.callInterrupted`（`.tv-interrupted`）与会话级横幅 `tools.pendingToolCalls`
  （`.gui-pending-calls`）。

## 验证如何搭台

脚本按 `verify-desktop-scroll.mjs` 的既有冒烟模式自建整套隔离环境：

1. `fake-openai-server.mjs` 以 `FAKE_TOOL_COMMAND="sleep 45"` 启动：首个带 `tools` 的回合
   返回一条 `bash` 工具调用，后续回合（请求里已有工具结果）返回短文。不涉及真实凭据与额度。
2. Electron 使用独立的 `MUSEPI_GUI_USER_DATA`、`PI_CONFIG_DIR`、`MUSEPI_DAEMON_DIR` 与
   `MUSEPI_GUI_DAEMON_PORT`；daemon 由应用外壳按真实首启路径自行拉起。
3. 用真实键盘事件把首条提示词打进欢迎页 composer，走正常的 `submitNewSession` 建会话并发送。
4. 工具执行中途，按 `MUSEPI_DAEMON_DIR/managed/*.json` 里的 pid 用 `taskkill /F /T` 强杀
   daemon（不调用 `system.shutdown`，即修复针对的崩溃形态）。
5. 应用不重启；脚本等待外壳自行拉起的**新** daemon，并观察恢复后的会话。

## 实测结果（2026-11-21）

Windows 11、仓库 worktree、Bun 1.4.4，`dist` 由被测分支现场构建。最终一次干净运行
24/24 通过（`report.json` 中 `passed: true`）。

| 测量项 | 数值 |
| --- | --- |
| 强杀 → daemon 端口关闭 | 928 ms |
| 强杀 → 停止胶囊消失（`.gui-composer-send--working`） | **932 ms** |
| 强杀 → 发送态重新可见（重连之后） | 13,906 ms |
| 强杀 → 新 daemon 注册 | 14,381 ms |
| 强杀 → 会话恢复并稳定（中断标记 + 横幅） | 15,326 ms |
| 恢复后的静默观察窗 | 7,856 ms，0 次幻影样本 |

通过的关键断言：

- 杀之前：停止胶囊在位、工具 spinner 在位；daemon 的 `session.pendingToolCalls` 已返回
  `bash` 且 `summary.command = "sleep 45"`——崩溃确实落在工具执行中，而非"回复已完、工具未启"。
- 杀之后：停止胶囊在 1 秒内消失，走的是断线即收路径，**不需要** 5 秒核对兜底。
- 自动重连拉起的是**另一个** daemon（pid 17236 → 28960），应用没有重启。
- 崩溃会话在新 daemon 上仍存在、`working:false`，且 daemon 仍能报出那条未获结果的调用。
- 展开该轮的"活动"折叠后，卡片内出现
  `调用已中断，未记录结果。它可能已经执行过，重试前请确认当前状态。`；
  会话级横幅为
  `上次会话结束时还有 1 个工具调用没有结果：bash · command \`sleep 45\`。进程在写入结果前退出了。`
- 超过 5 秒核对周期仍无幻影：0 次停止胶囊/头部工作中样本、0 个 spinner、横幅恒为 1、
  用户消息行恒为 1。
- 重连后没有堆叠状态：`.tr-row--user` 1 条、工具卡 1 张、横幅 1 个。

## 需要注意

- **"数秒"只对停止态成立，不等于整体恢复时间。** 停止胶囊约 1 秒内消失；但
  `recoverFromDrop` 会执行完整的 `boot()` 并显示启动闪屏，外壳拉起新 daemon 后 composer
  才回来。该 daemon 冷启动在本机测得 14–31 秒（高负载时曾到 90 秒），所以"发送态重新可见"
  落在 14–16 秒（热机）。恢复后的输入区是发送态，绝不会回到钉住的停止态。
- 多轮实跑的一致值：停止胶囊 819 / 932 / 1172 / 1323 ms；发送态 13.9 / 14.8 / 16.2 s
  （daemon respawn 14.4 / 15.1 / 16.6 s）。差异全部来自 daemon 启动耗时。
- 卡片内的"调用已中断"说明只在"活动"折叠展开时渲染（关闭态只显示回复文本）；用户不点开时
  看到的是会话级横幅，脚本先展开折叠再断言卡片内说明。
- 本使命没有改动 `adoptIdleState`、5 秒核对语义或 daemon 的 pending 检测，实测证明三者按提交时
  的设计工作。

## 复现

```bash
cd apps/desktop && bun run build           # 脚本驱的是 dist/
bun apps/desktop/scripts/verify-crash-idle-adopt.mjs
```

`MUSEPI_CRASH_VERIFY_OUT=<dir>` 可保留 `logs/`、`shots/` 与 `report.json`
（默认 `.desktop-build/verify-crash-adopt/`）。任何断言失败都以非零码退出，最后一次运行的
产物清单写在 `report.json`。

## 当次产物

- `1-before-kill.png` — 运行中、工具 spinner 在位
- `2-after-kill.png` — 恢复后的会话与未完成调用横幅
- `3-after-recovery.png` — 静默窗结束后的稳定态
- `logs/electron.log`、`logs/fake.log`