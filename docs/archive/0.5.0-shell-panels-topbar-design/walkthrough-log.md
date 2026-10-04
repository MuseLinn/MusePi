# 0.5.0 壳层批次实机走查记录（A1/A2/B1/C + 桌宠角标）

日期：2026-09-22 · 方式：CDP（MUSEPI_CDP_PORT）驱动真实 Electron 实例 + DOM 断言 + 截图 · 脚本：`packages/desktop-app/scripts/verify-shell-batches.ts`

## 结论：全部批次通过（2 个真 bug 已修，1 个脚本问题已修）

| 批次 | 验收项 | 结果 |
|------|--------|------|
| A1 顶栏三级退避 | 欢迎页 P2 工具按钮 4 个、instance 按钮凹陷 | ✅ 截图 01 |
| A2 会话头 | 实例菜单 bridge 行「浏览器桥端口 9230 · 8 个标签页」 | ✅ 截图 02 |
| A2 ctx/branch chips | 会话打开后 ctx chip 出现 | ✅ 截图 03/09（修复后 `ctx 9%`） |
| A2 tabs strip | 侧栏折叠后出现 5 个会话 tab | ✅ 截图 04 |
| B1 浏览器面板 | 地址栏 + 缩放控件 + agent 占用头 + 起始页 | ✅ 截图 05 |
| B1 视口预设 | 393 × 727 虚线框 + 尺寸标签 | ✅ 截图 06 |
| B1 缩放 | about:blank 下禁用（spec：缩放无意义） | ✅ 截图 07 |
| B1 把手拖动 | 393 × 727 → 434 × 803（+40px 宽，等比锁定） | ✅ 截图 08 |
| C 实例菜单诊断 | bridge 行内联诊断信息 | ✅ 截图 02 |

## 走查中发现并修复的 bug

1. **ctx chip 百分比泄漏原始浮点** — `ctx 9.339714050292969%` → 显示层 `Math.round`（GuiHeader.tsx）。
2. **桌宠角标语义错误（用户上报）** — 宠物窗口角标点击是一键已读，且启动即有角标。根因：角标绑定的是持久化的未读会话集合（localStorage 恢复即点亮）。修复（f805885b8）：角标改为**仅**镜像气泡窗 hidden 态（bubblesSetMode → 主进程 → pet:activity{bubbles}），点击发 `bubbles:restore` 恢复堆叠；启动时堆叠默认为 stacked，角标构造上不可能误亮；一键已读只保留在展开列表头与提醒面板。
3. **走查脚本自身的类型/健壮性问题** — CDP target 类型缺 `id`；外部导航步挂死整轮（改离线跳过 + 每步 try/catch + 8s CDP 超时 + 4min 看门狗）；会话打开步改点已有会话行并轮询右轨出现。

## 环境备忘（Windows 实机走查）

- 启动：`$env:MUSEPI_CDP_PORT='9225'; Start-Process ...\node_modules\.bin\electron . -WorkingDirectory ...\packages\desktop-app -WindowStyle Hidden`（`bun run desktop` 会重建 dist，慢）。
- **不要**用 Git Bash `&` 后台起 electron（句柄继承导致 Bash 调用挂起超时，且残留半死进程占用端口：netstat 显示 LISTENING 但属主 PID 已死，只能换端口）。
- 绝不 `taskkill //IM electron.exe`（会杀宿主 Kimi）；按 ExecutablePath 过滤 `*harness-engineering*musepi-omp*`。
- 渲染器会偶发 reload（死执行上下文表现为 evaluate 全返回 undefined）——重连 ws 或重启实例即可，非产品 bug。
- 9224 端口曾被幽灵进程占用，本轮用 9225。
