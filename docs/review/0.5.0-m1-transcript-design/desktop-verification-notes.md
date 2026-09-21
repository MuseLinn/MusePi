# Desktop 实机验证 ·  harness 笔记（2026-09-21）

脚本：`packages/desktop-app/scripts/verify-desktop-scroll.mjs`
（fake provider → 隔离 daemon → dist 版 Electron → CDP 驱动 → 断言 + 截图）

## 断言（M1 桌面侧契约）

1. `.tr-turn-head` 在 desktop 渲染（desktop model prop 路径）
2. reload（会话恢复）后贴底
3. 上滚解除跟随 → `.tr-back-bottom` 出现
4. 点击回尾且按钮隐藏

## Windows / Electron 硬事实（全部实测踩出）

- **bun-on-Windows AF_UNIX sun_path ~108 字符上限**：仓库嵌套路径
  （len=109）`net.createServer().listen()` 直接失败；socket 目录必须放
  系统短临时路径（`os.tmpdir()` 下）。daemon 正常跑是因为用户
  tmpdir 路径短——纯属侥幸。
- **进程内 `process.exit()` 跳过 finally**：失败分支一律 `throw Fatal`，
  由顶层 catch 统一退出，finally 负责杀进程。
- **bun `process.kill(pid, "SIGKILL")` 杀不动任意 Windows pid**（实测
  9224 的 Electron 存活）；必须 `taskkill /F /T /PID`（hardKill）。
- **继承 socket 的僵尸监听**：进程死后端口仍 LISTENING（netstat 显示
  死 pid），`connect()` 接受但无响应。后果两条：① 端口探测必须验证
  「真实绑定」（读日志里的 bind 行 / CDP `/json/version` 带超时）；
  ② 每轮验证的端口用 `pid 派生`，避开僵尸。
- **Electron 主进程 JS `console.error` 不落 stdio**（除非
  `ELECTRON_ENABLE_LOGGING=1`）——"日志里没有 [daemon]" 不能当
  「重启没发生」的证据（Chromium 自身的 "DevTools listening" 会落）。
- **渲染器 boot 只读一次 `localStorage["musepi-gui-url"] ?? DEFAULT_URL`
  （app.tsx:301）**，默认 :8300 尝试不设超时（gui-implementation §8）
  → 必须在首连前预置；首启向导门同样是 localStorage
  （`musepi-gui-onboarding-done`，lib/onboarding.ts），临时 root 无法
  完成向导（后续步骤要真实凭据），必须预置跳过。
- **GUI 的 daemon 发现/重启路径会把 `ws.port` 覆写成它自己 spawn 的
  端口**（boot 冷启动 8300 / 版本门 restart）——诊断里 probe 返回值
  反映的是「最后一次写入」，别拿它反推环境变量是否生效。

## 当前卡点（真实产品 bug，非 harness 问题）

全新 PI_CONFIG_DIR root（无任何会话）下：

1. GUI 连接成功（`rpc open — restoring`），进入主界面流程
2. `reopen session`（空 id，首启无历史）→ daemon 侧
   `Agent "Main" was replaced during session initialization`
   （modes.list 降级告警）
3. 随后 WS `connection closed (code 1006)` → daemon 进程死亡
   （CONNECTION_RESET → REFUSED），且无 stderr 输出
4. GUI 重连循环（rpc open ×3）最终 stall 屏

对照：run 2（未预置 onboarding-done）里首启向导挡住了主界面，
连接保持稳定——即「reopen 空会话」这条路径是触发器。
修复入口：`packages/coding-agent/src/daemon/server.ts` 会话恢复
（history-session reactivation）对空/缺失 session id 的处理。

## 状态

- harness 本体可用（隔离、自清、诊断探针齐全），提交于 main
- 断言尚未跑通（被上述 bug 阻塞）；guest 侧冒烟
  （`verify-back-bottom.py`）此前已通过
