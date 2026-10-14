# ADR 0002：computer use 非抢占式体验升级（second-cursor overlay + 输入租约 + pacing）

- 状态：已接受：WP1–WP4 实施完毕待合入，分支 `feat/cu-nonpreemptive-wp1`。WP1（光标恢复 + pacing + 路径上限 + Esc 中断 + `Cancelled`）；WP2（`Local` 命名 mutex 租约 + `InputBusy`，Background 免租）；WP3（第二光标 overlay：分层穿透窗口 + DIB/GDI 渲染 + UI 线程 + 生命周期铁律）；WP4（接管横幅 + 派发契约文档）。另见本文件附录 A 的推断声明（光标恢复未实证）。
- 背景：KimiCU 0.3.6 逆向实证（见附录 A） + 现有实现盘点（见附录 B）
- 目标：Windows 下达到"不抢用户、可预期、可中断"的同等体验；Background-first 架构不变

## 决定

分 4 个工作包顺序落地。WP1+WP2 可独立发版（无 UI）；WP3 是用户可见的大胜；WP4 是文档与告知。

### WP1 — 光标恢复 + pacing + Esc 中断（只动 `win32/input.rs`，半天）

1. **CursorGuard**：仿现有 `ForegroundGuard`（`input.rs:589-617`，只恢复前台窗口）。进 foreground 动作前 `GetCursorPos` 保存，Drop 时 `SetCursorPos` 恢复（best-effort，失败吞掉）。
2. **`InputTiming` 放 `backend.rs`**：`move_settle_ms / press_ms / step_ms / after_ms`，纯数据结构，全平台可单测（仿 `delivery.rs` 的 host 测试纪律）。默认值抄 KimiCU 验证过的时序（`api.md:238-254`）：click 取 40/25/-/60，drag 取 0/12/8/12。在 `foreground::pointer`（`input.rs:679-720`）与 `global_pointer`（`input.rs:80-139`）的 move→down→steps→up 四处加 `thread::sleep`（worker 线程上睡无妨，本来串行）。napi 面暂不动（`PointerOptions` 不加字段，可调参数后移到 WP3 跟进）。
3. **Esc 中断**：paced 循环每步前 `GetAsyncKeyState(VK_ESCAPE)`（不装钩子，纯轮询）。命中则松开已按下的键/按钮、恢复光标、返回 cancelled 错误。
4. **手势上限**：drag path 上限 1024 点（抄它），在 `Worker::process` 统一 enforcement（`backend::check_drag_len` + `MAX_DRAG_POINTS`，全平台生效），超限直接拒绝。

### WP2 — 跨会话输入租约（新 `desktop/lease.rs` + win32 几十行，半天）

现状缺口：`Mutex<Lifecycle>`（`mod.rs:616`）只串行化**本**会话，两个会话同时驱动仍打架——这正是 KimiCU `computer_use_busy`（`SKILL.md:82`）解决的问题。

1. `lease.rs` 写纯状态机（Acquire / Release / Busy{owner}），host 可单测，不含 Windows import（仿 `delivery.rs:1-4` 的纪律）。
2. Win32 落地：命名 mutex `Local\musepi-omp-cu-input`（`CreateMutexW`；用 `Local` 而不用 `Global`——后者建 mutex 需要 SeCreateGlobalPrivilege，普通用户进程会失败；同一登录 session 内互斥已够用）。实现为 `Win32Lease` RAII guard，随 `Win32Backend` 释放（`Request::Close` 与 Drop 路径自动覆盖）。被占返回新错误码 `DESKTOP_INPUT_BUSY`（"real input owned by another session; retry after its turn"）。
3. **Background（PostMessage）路径不参与租约**：它不碰全局输入，无需互斥。KimiCU 没有这层区分（全租），这是我们 Background-first 架构的红利，保留。

### WP3 — 第二光标 overlay（新 `win32/overlay.rs`，2–4 天）

对标物：`kimi-cu.exe` 字符串实证 `KimiCUSecondCursorOverlay` / `KimiCU Overlay` / `KimiCU Display Overlay` / `OverlayCommand::{Hide,Through,Drag,Point}` + D2D/DWrite 渲染。

1. 独立 UI 线程 + 一个虚拟桌面尺寸的分层窗口：`WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE`，类名如 `MusepiSecondCursorOverlay`。Worker 经 mpsc 发绘制命令：`CursorMove / ClickPill / DragPolyline / HighlightRect / NoticeBanner / Hide`。
2. 渲染先用 GDI（`UpdateLayeredWindow` + 32 位 DIB，**零新依赖**；`windows-sys` 已在用）。D2D 动效（pill shimmer 之类）以后再说，初期静态 pill 足够。
3. 生命周期铁律（防"鬼光标"，这是 overlay 唯一的严重失败模式）：每次 pointer 请求结束（after_ms 后）自动 Hide；`Close`/Drop 强制 Hide + join 线程；在现有 `catch_unwind`（`mod.rs:651`）之后加 overlay cleanup，保证 panic 也不留鬼。
4. DPI：窗口按虚拟屏物理像素建，坐标复用现有 `capture::logical_to_physical`；多屏（含负原点）一次覆盖。
5. `DesktopCapabilities`（`types.rs:62-76`，`#[napi(object)]` 加字段向后兼容）加 `overlay: bool`，客户端可自适应。

### WP4 — 升级告知 + dispatch 契约（半天）

1. 每次从 Background 升级到 Foreground/全局输入前，先经 overlay 打"即将接管鼠标"横幅。**不改 napi 回包**（`Response::Unit` 不动），比改 wire 便宜。
2. 把这句写进 skill/文档："input 返回 = 已派发，不是对方已接受；重要动作后重截图验证"。现有 `invalid_coordinate_frame` 文案（`mod.rs:256-264`）和 frame resize 守卫（`frame.rs:141-146`）已经在讲同一件事，agent 侧配一句 prompt 即可。

## 边界（不做什么）

1. napi 输入面不变：`PointerOptions`（`types.rs:109-116`）、`Backend` trait（`backend.rs:82-103`）零改动；WP3 只给 `DesktopCapabilities` 加一个 bool 字段。
2. Background-first 默认不变（`DeliveryMode::parse` 默认 Background，`backend.rs:18-26`）；denylist 矩阵（`delivery.rs:64-88`）只增不改。
3. 不学它的剪贴板粘贴：我们 foreground 用 `KEYEVENTF_UNICODE` 逐字送（`input.rs:801-812`），不碰剪贴板，比它干净，保持。
4. 不引入新 crate（overlay 用 GDI + `windows-sys`）；macOS/Linux 后端不动（WP1–WP3 均为 `win32/` 内新增或修改；pacing 常量以后可移植）。
5. 超时沿用现有 `OPERATION_TIMEOUT` / `CLOSE_TIMEOUT`（`mod.rs:671-705`），不抄它的 660s（那是它宿主的数）。
6. **只复刻行为，不复制代码**：KimiCU 插件为专有许可（`kimi.plugin.json:12`），附录 A 均为行为级事实（架构、时序参数、窗口类名），实现全部自写。

## 理由

- 用户投诉排序：光标被搬走 > 双会话打架 > 动作太快应用跟不上 > 看不见 agent 在干什么。WP1+WP2 覆盖前三，WP3 覆盖第四。
- 可回滚：WP1 是纯加法（guard + sleep）；WP2 租约失败只影响新并发场景，旧单会话路径不变；WP3 以 `capabilities.overlay` 开关，关掉即回当前形态。
- 可测试：`InputTiming` 与 `lease.rs` 状态机进 host 单测（仿 `delivery.rs`）；overlay 走 Windows 真机矩阵（见"验证"）。
- KimiCU 实证结论："独立"是观感而非隔离（它自己文档承认输入会接管鼠标键盘，`kimi.plugin.json:18`）。我们 Background-first 的起点更高，不需要、也不应该为了"像它"而放弃定向投递。

## 影响

- 新增错误码 `DESKTOP_INPUT_BUSY`（`DESKTOP_*` 前缀沿用 `docs/computer-use.md:256-270` 表）。
- `docs/computer-use.md` 需补：租约语义、overlay 说明、`DESKTOP_INPUT_BUSY` 行、Windows 行从"未远程验证"更新。
- 验证矩阵（WP3 落地时执行）：记事本（Win32 原生）、Chrome（Chromium 必须升级）、一个 WPF 应用、150% 缩放副屏；ghost 检查：kill worker 后屏幕无残留 overlay。

## 附录 A — KimiCU 证据索引（行为级）

- 注册：`C:\Users\unive\.claude.json:591-598`（`kimi-cu.exe mcp` stdio）；`kimi.plugin.json:45-62`（code-mode 三工具 + `toolTimeoutMs: 660000`）。
- 租约：`trusted-service/service.mjs:199-207`（nonce lease），`:313-327`（cell 结束 `action:"end"`）；`SKILL.md:82`（`computer_use_busy`）；`README.md:117-118`（EOF 清租约）。
- Overlay：`kimi-cu.exe` 字符串 `KimiCUSecondCursorOverlay`、`KimiCU Overlay`、`KimiCU Display Overlay`、`OverlayCommand::{Hide,Through,Drag,Point}`、`composition pill shimmer/accent`；渲染 `D2D1/DWrite/DwmExtendFrameIntoClientArea`；`SKILL.md:90-91`（cell 边界清 overlay，物理 Esc 中断）；`repl.md:163-165`（leases/overlays 止于 cell 边界）。
- 输入：`SendInput`、`SetCursorPos`+`GetCursorPos`、`AttachThreadInput`、`PostMessageW` 在列；`ViGEm/vmulti/Interception/HidD/BlockInput/SetWindowsHookEx` **不在列**（无 vHID 驱动、无钩子、无锁定）；`api.md:175`（index click 走真鼠标）、`:199`（粘贴留剪贴板）、`:238-254`（四段时序默认值）、`:202-229`（scroll/drag/set_value）。
  - 推断（非实证）："动作前后恢复光标位置"是从它同时导入 Get/SetCursorPos 推断的，未在二进制中找到直接证据；WP1 的 `CursorGuard` 按此推断实现，若评审不认同可整体删去（独立 guard，不影响 pacing）。
- 观察：`BitBlt/PrintWindow/GetWindowDC` + "screen DC for overlay"；UIA 由 "failed to read UIA toggle state" 等报错字符串实证。

## 附录 B — 现有实现锚点

- 会话：`SessionCore` 单 worker 线程串行 `Request`（`desktop/mod.rs:645-661`）；`frames: HashMap<String, FrameGeometry>`（`:228`，capture 存帧 `:330`，无帧拒输入 `:256-264`）；`map_point`（`:266-280`）；close/Drop（`:682-716`）。
- 投递：`win32/input.rs` 三档（global enigo `:80-139` / background PostMessage `:293-347` / foreground SendInput `:679-720`）；`ForegroundGuard`（`:589-617`）；`DeliveryMode` 默认 Background（`backend.rs:18-26`）；denylist（`delivery.rs:64-88`）。
- 坐标：`frame.rs` 截图锚定 + resize 守卫（`:141-146`）+ move 重锚（`:273-276` 测试）。
- 文档：background 默认与升级语义（`docs/computer-use.md:87`）、frame 规则（`:114-138`）、生命周期（`:225-240`）、错误表（`:256-270`）。
