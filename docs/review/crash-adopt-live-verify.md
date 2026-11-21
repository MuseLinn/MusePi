# 崩溃后不重启的收敛实测（24a1c86d / 8f9b131f）

在真实 Electron 环境里验证：一条长运行工具执行到一半时强杀 daemon，不重启应用，
观察窗口里的运行状态、未完成工具标记与自动重连后的状态是否收敛。驱动脚本是
`apps/desktop/scripts/verify-crash-idle-adopt.mjs`；本记录保存当次实跑的计时、结论与环境注意事项。

## 被验证的行为

- `GuiSessionStore.adoptIdleState()`：崩溃的回合永远等不到 `agent_end`，断线时丢弃这个
  无人能结束的运行标记，停止胶囊不会永久钉住。
- `session.pendingToolCalls` 命名崩溃分支中未获结果的工具调用；GUI 渲染卡片内的
  `tools.callInterrupted`（`.tv-interrupted`）与会话级横幅 `tools.pendingToolCalls`
  （`.gui-pending-calls`）。
- `ChatView` 在自认为仍在运行时每 5 秒重读 `session.pendingToolCalls`。**本次实跑没有执行
  这条兜底路径**（见下），记录不对它作结论。

## 验证如何搭台

脚本按 `verify-desktop-scroll.mjs` 的既有冒烟模式自建整套隔离环境：

1. `fake-openai-server.mjs` 以 `FAKE_TOOL_COMMAND="sleep 45"` 启动：首个带 `tools` 的回合
   返回一条 `bash` 工具调用，后续回合（请求里已有工具结果）返回短文。不涉及真实凭据与额度。
   provider 端口每次运行派生（`FAKE_PORT`），避免与其他 checkout 的冒烟互相占用。
2. Electron 使用独立的 `MUSEPI_GUI_USER_DATA`、`PI_CONFIG_DIR`、`MUSEPI_DAEMON_DIR` 与
   `MUSEPI_GUI_DAEMON_PORT`；daemon 由应用外壳按真实首启路径自行拉起。
3. 用真实键盘事件把首条提示词打进欢迎页 composer（CodeMirror），走正常的
   `submitNewSession` 建会话并发送；脚本先断言文本确实落进编辑器。
4. 工具执行中途，按 `MUSEPI_DAEMON_DIR/managed/*.json` 里的 pid 用 `taskkill /F /T`
   强杀 daemon（不调用 `system.shutdown`，即修复针对的崩溃形态）。
5. 应用不重启；脚本等待外壳自行拉起的**新** daemon，读取 daemon 侧事实，再观察恢复后的会话。

## 实测结果（2026-11-21）

Windows 11、仓库 worktree、Bun 1.4.4，`dist` 由被测分支现场构建。最终一次干净运行
**25/25 通过**（`report.json` 中 `passed: true`）。

| 测量项 | 数值 |
| --- | --- |
| 强杀 → daemon 端口关闭 | 445 ms |
| 强杀 → 停止胶囊消失（`.gui-composer-send--working`） | **462 ms** |
| 胶囊消失那一采样的窗口状态 | `splash=true`、`composer=false`（外壳已在闪屏、输入区已卸载） |
| 强杀 → 新 daemon 注册 | 2,745 ms |
| 强杀 → 发送态重新可见（重连之后） | 8,370 ms |
| 强杀 → 会话恢复到可断言状态 | 11,207 ms |
| 恢复后的静默观察窗 | 7,545 ms，0 次幻影样本 |

恢复路径：本次重连**没有自动回到会话**（`autoReopen=false`，见"重连后的会话恢复"），
脚本按用户操作点击侧栏会话行后，发送态在 8,370 ms 出现、会话在 11,207 ms 可断言。

## 通过的关键断言

- 杀之前：停止胶囊在位、工具 spinner 在位；daemon 的 `session.pendingToolCalls` 已返回
  `bash` 且 `command = "sleep 45"`——崩溃确实落在工具执行中，而非"回复已完、工具未启"。
- 杀之后：停止胶囊在 462 ms 消失。**该采样同时记录到外壳已进入启动闪屏、composer 已卸载**
  （`capsuleClearSplash=true`、`capsuleClearComposer=false`）。断线回调
  `client.onStatus("closed")` 里 `adoptIdleState()` 与 `recoverFromDrop()` 的
  `setBooting(true)` 同一 tick 发生，`StartupSplash` 会整体替换外壳，所以这一个数字**不能**
  单独区分"stop→send 渲染"与"闪屏卸载"；"不再钉住"的结论由最终态断言承担。
- **5 秒核对本次没有执行。** `ChatView` 的 `setInterval(..., 5000)` 只在 `working===true`
  时存在；`adoptIdleState()` 在断线时先把 `working` 置 false，interval 随即清理，早于任何
  5 秒 tick。7.5 秒静默窗证明的是"没有幻影运行"，不是"5 秒兜底按设计工作"。
- 自动重连拉起的是**另一个** daemon（pid 46908 → 9528），应用没有重启。
- 崩溃会话在新 daemon 上仍存在、`working:false`，且 daemon 仍能报出那条未获结果的调用
  （`bash` / `sleep 45`）。
- 展开该轮的"活动"折叠后，卡片内出现
  `调用已中断，未记录结果。它可能已经执行过，重试前请确认当前状态。`；
  会话级横幅为
  `上次会话结束时还有 1 个工具调用没有结果：bash · command \`sleep 45\`。进程在写入结果前退出了。`
- 超过 5 秒核对周期仍无幻影：0 次停止胶囊/头部工作中样本、0 个 spinner、横幅恒为 1、
  用户消息行恒为 1。
- 重连后没有堆叠状态：`.tr-row--user` 1 条、工具卡 1 张、横幅 1 个。
- check 6 只在**新 daemon 已被确认且重连完成**之后才接受发送态（`daemonRespawned` 门），
  因此它证明的是重连后的发送态，而不是闪屏前后的任何一帧。

## 重连后的会话恢复（本次未自动完成）

本次 daemon 约 2.7 秒就重建完成，GUI 重连时 `session.open` 失败一次
（页面上出现 `session.open: not connected`），随后停在欢迎页，没有重试；会话本身完好、
在侧栏可点开，点开后横幅与中断标记正常。此前多次运行里 daemon 重建耗时 14–31 秒时，
GUI 都能自动回到会话。脚本因此记录 `autoReopen`，必要时点击侧栏会话行继续断言，
但**不把这个恢复差异算作本次修复的失败**。它是另一条客户端重连路径的问题，已另行上报
（TowerFinding：fast daemon respawn loses the post-crash session reopen）。

## 复现

```bash
# 在仓库根目录依次执行；两行都不改变当前目录
bun --cwd=apps/desktop run build          # 脚本驱动的是 apps/desktop/dist/
bun apps/desktop/scripts/verify-crash-idle-adopt.mjs
```

Bun 1.4.4 的 `--cwd` 必须写成 `--cwd=<dir>`；空格形式会把目录当成脚本名。脚本自身的头注释写的是
"Usage (repo root)"。

`MUSEPI_CRASH_VERIFY_OUT=<dir>` 可保留 `logs/`、`shots/` 与 `report.json`
（默认 `.desktop-build/verify-crash-adopt/`）。任何断言失败都以非零码退出，最后一次运行的
产物清单写在 `report.json`。

## 当次产物

- `1-before-kill.png` — 运行中、工具 spinner 在位
- `2-after-kill.png` — 闪屏/恢复过程中的窗口
- `3-after-recovery.png` — 静默窗结束后的稳定态（单横幅、单轮、发送态）
- `logs/electron.log`、`logs/fake.log`