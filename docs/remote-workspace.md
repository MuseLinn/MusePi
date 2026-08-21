# 远程实例作为工作区（Remote Workspace）— 差距分析与实现建议

> 2026-08-07。现状：GUI ConnectDialog 是纯 UI 壳（4 步向导无连接逻辑、无 RPC、无状态）；
> 但 musepi 的 SSH 基础设施已存在（未接线）。本文对比 opencode / openchamber / bitfun 后给出实现方案。
>
> **实现状态（同日）**：M1（daemon `remote.hosts/hostAdd/connect/browse/disconnect`）+ M2（ConnectDialog
> 真实化：SSH 卡、主机列表/新增、连接状态与错误、sshfs 前置检查）已落地并 CDP 验证
> （commit `…` 起）。剩余：M3 会话远程标记与门控、Docker 后端、Windows WinFsp E2E。


## 1. 现状盘点（musepi-omp）

### 已有（未接线）
| 模块 | 能力 |
|---|---|
| `packages/coding-agent/src/ssh/connection-manager.ts` | SSH 连接管理：ControlMaster 复用、host probe（OS/shell 识别：windows/linux/macos）、密钥权限校验、host info 缓存 |
| `packages/coding-agent/src/ssh/sshfs-mount.ts` | `mountRemote(host, remotePath)` / `unmountRemote` / `hasSshfs()` / `isMounted()`；挂载点约定 `~/.musepi/remote/<host>/...`（`getRemoteDir()`） |
| `packages/coding-agent/src/ssh/file-transfer.ts` | scp 传输 |
| `packages/coding-agent/src/ssh/config-writer.ts` | SSH config 读写（原子写） |
| `packages/coding-agent/src/cli/ssh-cli.ts` + `commands/ssh.ts` | `musepi ssh add/remove/list` 管理主机 |
| `tools/read.ts` | 远程挂载路径跳过模糊匹配（防挂起） |
| `tools/glob.ts` | 明确拒绝 `ssh://`（提示用 read）——sshfs 挂载后不需要 |

### 缺失（差距）
1. **ConnectDialog 无任何逻辑**：step 0 选方法（SSH/Docker）→ step 1 配置 → step 2 spinner 永转 → step 3 "open" 无行为。无 RPC、无挂载、无目录浏览。
2. **无 daemon remote.\* RPC**：连接/测试/挂载/浏览/断开全部缺失。
3. **无会话绑定**：远程工作区无法成为会话 cwd（侧栏/会话无远程标记）。
4. **条件判断不完善**：sshfs 可用性（`hasSshfs` 未接入 UI）、挂载状态、认证失败/连接失败的错误路径、Windows 上 sshfs（WinFsp）检测、断开时会话清理、重连策略——全部没有。
5. **Docker 方法卡**：纯占位（无容器发现/exec）。

## 2. 参考仓库方案对比

| | opencode | openchamber | bitfun |
|---|---|---|---|
| 传输 | **HTTP**：远程实例本身是 opencode server，桌面 app 连 HTTP；SSH 只是类型标记（无 SSH 传输实现）；Windows 有 WSL sidecar（wsl.exe 装 opencode + localhost HTTP） | **SSH + 端口转发**（Electron `ssh-manager.mjs`）：SSH 会话把远程 OpenChamber UI 端口转发到本地，切换主机 = **新 Electron 窗口加载远程 UI**；E2EE relay 备用 | **SSH 直连执行**（Rust 后端 ssh-remote crate）：连接 → `openWorkspace(path)` → `WorkspaceKind.Remote`，会话携带 `remote_connection_id`/`remote_ssh_host` |
| 生命周期状态机 | server health ping（timeout/retry） | 完整阶段：`config_resolved → auth_check → master_connecting → remote_probe → installing/updating → server_detecting → server_starting → forwarding → ready/degraded/error` | 连接测试分阶段（`ConnectionTestStage/Report`）+ 重连 deadline 策略（`remoteWorkspaceReconnect.ts`） |
| 远程目录选择 | 服务端 directory picker（`directoryPickerKind('server')`） | —（远程 UI 自己选） | `RemoteFileBrowser.tsx`（连接后浏览远程 FS 选路径） |
| UI 门控 | `server-scope.ts`：非 local 连接按 `ssh:<host>` scope 命名空间隔离项目/会话 | 桌面专属；mobile 走 direct/relay | `isRemoteWorkspace()` + `connectionId` + `sshHost`：禁用本地专属动作（file reveal/watching）、限制无关功能、会话按远程路径限定 |
| 认证 | —（HTTP 密码） | managed/external 模式 + 密钥/口令 | `SSHAuthPromptDialog`：password / private key / agent / keyboard-interactive 四选 |

**结论**：bitfun 的"远程目录 = 工作区"模型最贴合 musepi（会话 cwd 即远程路径，工具直接工作）；
opencode/openchamber 都是"远程跑一个 agent server"模式（远程部署成本高，不适合轻量 SSH 直连场景）。

## 3. 建议实现方案（sshfs 挂载路线）

利用 musepi 已存在的 SSH 基建，**远程目录挂载为本地路径** → 会话 cwd = 挂载路径 →
**所有工具（read/bash/glob/write/grep）零改动可用**（它们只认本地 FS）。

```
GUI ConnectDialog ──remote.* RPC──▶ daemon
                                      ├─ remote.hosts       （列出 musepi ssh 保存的主机）
                                      ├─ remote.connect     （测试连接 + probe OS + 挂载 sshfs）
                                      ├─ remote.browse      （挂载后列远程目录，选工作区路径）
                                      ├─ remote.openWorkspace（绑定会话 cwd = 挂载路径，会话标 remote）
                                      └─ remote.disconnect  （卸载 + 会话清理）
```

### M1 daemon RPC（基础）
- `remote.hosts`：读 `musepi ssh list` 的主机配置（name/host/user/key/port）
- `remote.connect {host}`：`ensureHostInfo`（OS/shell 探测）→ `hasSshfs()` 检查（无 sshfs 返回明确错误，Windows 提示装 WinFsp）→ `mountRemote` → 返回挂载点 + 远程 OS
- `remote.disconnect {host}`：`unmountRemote` + 关闭关联会话

### M2 ConnectDialog 真实化
- step 0：SSH（现有）+ Docker 卡（**先标"规划中"禁用**，或移除——无容器后端）
- step 1：主机下拉（remote.hosts）+ 新增主机入口（调 `musepi ssh add` 的 RPC 包装）
- step 2：真实连接（分阶段状态：probe → sshfs 检查 → 挂载 → 成功/失败原因展示）
- step 3：**远程目录浏览**（remote.browse 列表，选目录 → openWorkspace）
- 失败路径：认证失败、ControlMaster 拒绝、sshfs 缺失、挂载失败——各自明确文案

### M3 会话绑定与门控
- 会话 snapshot 加 `remote: { host, mountPath }`（wire 协议扩展）
- 侧栏/header 显示远程徽标（`ssh:<host>` 风格）
- 会话级门控：远程会话禁用本地专属操作（如 git 面板默认隐藏？——git 走挂载路径仍可用；notes/plans 按 cwd 存本地 OK）
- 断开时：关联会话提示/关闭（bitfun 重连策略参考：断线重连 deadline）

### M4 条件判断清单（当前缺失的）
| 条件 | 现状 | 要求 |
|---|---|---|
| sshfs 可用 | `hasSshfs()` 存在未用 | connect 前置检查；缺失给出平台安装指引（macOS FUSE / Windows WinFsp+sshfs-win） |
| 主机 OS | `ensureHostInfo` 探测 | 驱动 shell 差异（cmd/powershell vs bash）与路径风格 |
| 挂载状态 | `isMounted()` 存在未用 | connect 幂等（已挂载直接返回）、UI 显示挂载中 |
| 密钥权限 | 校验存在 | 错误路径提示 `chmod 600` |
| 认证交互 | 无 | M2 用已保存密钥；交互式口令后续（bitfun auth 四选） |
| 断开清理 | 无 | unmount + 会话处理 |

## 4. 验证计划（Windows 目标机可用）
- 目标机（magicbookpro16）装 WinFsp + sshfs-win → `hasSshfs()` 在 Windows 上应为 true
- 远程连接测试：从 Windows GUI 连回 macOS 开发机（或 NAS）→ 挂载 → 开工作区 → 会话工具跑远程目录
- 条件分支验证：无 sshfs 机器、错误口令、断线重连

## 5. 参考文件索引
- bitfun：`src/web-ui/src/features/ssh-remote/`（SSHRemoteProvider/SSHConnectionDialog/RemoteFileBrowser/sshApi/remoteWorkspaceReconnect）、`src/apps/cli/src/agent/runtime_client.rs`（remote 字段）、`src/apps/cli/src/peer_host/workspace_dto.rs`
- openchamber：`packages/electron/ssh-manager.mjs`（生命周期状态机）、`packages/ui/src/lib/desktopSsh.ts`、`packages/ui/src/components/sections/remote-instances/RemoteInstancesPage.tsx`
- opencode：`packages/app/src/context/server.tsx`（ServerConnection 类型）、`packages/desktop/src/main/wsl/sidecar.ts`（WSL sidecar）、`packages/app/src/utils/server-scope.ts`
- musepi：`packages/coding-agent/src/ssh/*`、`packages/gui/src/components/ConnectDialog.tsx`
