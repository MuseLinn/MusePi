# 能力缝索引（Capability Seams）

每个内置能力在自己的权威注册表文件头部带六字段缝声明（名称+ns / 输入 / 输出 / 生命周期 / 启停 / 冲突 + 检视入口）；本页只做锚点索引，不复制声明内容。格式定义与七域盘点：`docs/review/0.5.0-m2.4-capability-seams.md`（§3）。纪律见根 `AGENTS.md`「能力缝声明」条。

| 域 | 权威锚点 | 声明位置 |
|---|---|---|
| daemon L2 服务（RPC 面） | `packages/coding-agent/src/daemon/services/types.ts`（`DaemonService` 接口） | 各服务文件头注释（样板：`schedule-service.ts`） |
| 内置工具 | `packages/coding-agent/src/tools/index.ts`（`BUILTIN_TOOLS` / `HIDDEN_TOOLS` / `isToolAllowed`） | 同文件头部 |
| 斜杠命令 | `packages/coding-agent/src/slash-commands/builtin-registry.ts` | 同文件头部 |
| hooks 引擎 | `packages/coding-agent/src/extensibility/hooks/types.ts`（`HookEvent` union） | 同文件头部 |
| channels（IM 通道） | `packages/coding-agent/src/channels/types.ts`（`ChannelAdapter`） | 同文件头部 |
| 扩展 API（register* 面） | `packages/coding-agent/src/extensibility/extensions/types.ts`（`ExtensionAPI`） | 同文件头部 + `docs/extensions-dev.md` |
| GUI 渲染侧（widget/插槽/节点 kind） | `packages/client-core/src/widgets/registry.ts`、`packages/collab-proto/src/extension-slots.ts` | 各文件头部 |

存量声明按「触及时顺手补」推进，不做批量回填；新增能力无声明不得过评审。
