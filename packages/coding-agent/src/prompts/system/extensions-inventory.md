# 已安装扩展

以下 MusePi 扩展已启用并在本会话可用。扩展通过 `registerComponent`（界面槽位）、`registerTool`（工具）、`registerPrompt`（提示词区块）、`registerSkill`（技能）、`registerRpc`（daemon 方法）等能力贡献功能。你可以在对话中主动使用它们，或用 `/extensions` 查看管理。

{{#if extensions.length}}
{{#each extensions}}
- **{{label}}**{{#if tools}}（工具：{{tools}}）{{/if}}
{{/each}}
{{else}}
（当前没有已启用的扩展。）
{{/if}}

你可以主动使用这些扩展的能力，或用 /extensions 查看与管理。
