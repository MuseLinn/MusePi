# 能力缝索引（Capability Seams）

每个内置能力在自己的权威注册表文件头部带六字段缝声明（名称+ns / 输入 / 输出 / 生命周期 / 启停 / 冲突 + 检视入口）；本页只做锚点索引，不复制声明内容。格式定义与七域盘点：`docs/review/0.5.0-m2.4-capability-seams.md`（§3）。纪律见根 `AGENTS.md`「能力缝声明」条。

| 域 | 权威锚点 | 声明位置 |
|---|---|---|
| daemon L2 服务（RPC 面） | `packages/coding-agent/src/daemon/services/types.ts`（`DaemonService` 接口） | 各服务文件头注释（样板：`schedule-service.ts`） |
| GUI 编辑器语言智能 | `packages/coding-agent/src/daemon/services/editor-service.ts`（`EditorService`；`editor.sync` / `editor.saved` / `editor.hover` / `editor.completion` / `editor.definition` / `editor.implementation` / `editor.typeDefinition` / `editor.references` / `editor.rename`） | 同文件头部 |
| 设计体系注册表（M3 §3） | `packages/coding-agent/src/presets/design-systems.ts`（内置预设表 + 扩展注册表） | 同文件头部 |
| 内置工具 | `packages/coding-agent/src/tools/index.ts`（`BUILTIN_TOOLS` / `HIDDEN_TOOLS` / `isToolAllowed`） | 同文件头部 |
| 斜杠命令 | `packages/coding-agent/src/slash-commands/builtin-registry.ts` | 同文件头部 |
| hooks 引擎 | `packages/coding-agent/src/extensibility/hooks/types.ts`（`HookEvent` union） | 同文件头部 |
| channels（IM 通道） | `packages/coding-agent/src/channels/types.ts`（`ChannelAdapter`） | 同文件头部 |
| 扩展 API（register* 面） | `packages/coding-agent/src/extensibility/extensions/types.ts`（`ExtensionAPI`） | 同文件头部 + `docs/extensions-dev.md` |
| GUI 渲染侧（widget/插槽/节点 kind） | `packages/client-core/src/widgets/registry.ts`、`packages/collab-proto/src/extension-slots.ts` | 各文件头部 |
| Android 模拟器插件 | `packages/coding-agent/src/bundled-plugins/android-emulator/index.ts`（扩展隔离的 RPC / `android_emulator`） | 同文件头部 |
| Cordis preset 组合运行时 | `packages/coding-agent/src/extensibility/plugins/preset-runtime.ts`（`CordisPresetRuntime`） | 同文件头部 |
| Cordis 会话页 | `packages/desktop-app/src/plugins/chat-view/index.ts`（`app.chat`） | 同文件头部 |
| Cordis 能力中心 | `packages/desktop-app/src/plugins/capability-center/index.ts`（`app.capability`） | 同文件头部 |
| Cordis 文件工作区 | `packages/desktop-app/src/plugins/file-workspace/index.ts`（`panel.tab.files`） | 同文件头部 |
| 第一方子系统插件与 entry 组件 | `packages/coding-agent/src/bundled-plugins/*/package.json`、`packages/coding-agent/src/daemon/cordis-dynamic-plugins.ts`（`musepi.host` / `musepi.components` / `CordisDynamicPluginRuntime`） | 各包入口与运行时文件头部 |
| 外部产品子智能体 | `packages/coding-agent/src/task/types.ts`（`task.external-subagent` / `AgentDefinition.external`） | 同文件 `ExternalSubagentUpdate` 前六字段声明 |

存量声明按「触及时顺手补」推进，不做批量回填；新增能力无声明不得过评审。
