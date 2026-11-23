# 去哪里查代码与文档

**本表只在 MusePi 仓库 clone 内有效。** 发行包不带 `docs/`；在仓库外开发时改用运行时可观测的事实：`settings.schema` 的字段、`plugin_manager` 的 `list_plugins`、`~/.musepi/` 下的实际文件、`--help`。不要按这些路径去找文件，也不要声称读过读不到的文件。

| 任务 | 位置 |
| --- | --- |
| 插件 API 全貌、事件名、命令上下文 | `docs/extensions.md` |
| 插件入口规范与 conformance 校验 | `packages/coding-agent/test/first-party-plugin-conformance.test.ts` |
| 能力缝（provider / service / slot 所有权） | `docs/capability-seams.md` |
| 工具所有权（哪个组件拥有哪个内建工具） | `packages/coding-agent/src/tools/tool-ownership.ts` |
| 插件配置（manifest config 与资源卡） | `docs/extensions-dev.md` |
| 加载机制细节（发现顺序、路径解析、禁用） | `docs/extension-loading.md` |
| 自定义工具（模型直接调用） | `docs/custom-tools.md` |
| Hook（pre/post 脚本、可突变什么） | `docs/hooks.md` |
| 加 LLM provider | `docs/adding-a-provider.md`，参照 `packages/ai/src/registry/` 现有写法 |
| MCP server / 工具 | `docs/mcp-config.md`、`docs/mcp-server-tool-authoring.md` |
| 插件市场与安装器 | `docs/marketplace.md`、`docs/plugin-manager-installer-plumbing.md` |
| 设置项 | `docs/settings.md` 与 `src/config/settings-schema.ts`（单一权威） |
| 斜杠命令实现 | `docs/slash-command-internals.md` |
| 系统提示词与技能注入 | `docs/context-files.md`、`docs/skills.md` |
| GUI 侧（daemon RPC / Electron） | `docs/gui-implementation.md` |
| 内置插件目录 | `packages/coding-agent/src/plugins/<domain>/<pkg>/` |