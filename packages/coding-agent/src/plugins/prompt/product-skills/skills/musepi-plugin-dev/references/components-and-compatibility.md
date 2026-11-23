# 组件、兼容性与版本豁免

## 组件

一个插件包可以在 `package.json` 的 `musepi.components` 里声明子组件：

```json
"musepi": {
  "extensions": ["./index.ts"],
  "components": [
    { "id": "read", "entry": "./read.ts", "description": "文件读取工具族。" }
  ]
}
```

宿主为每个带 `entry` 的组件建独立子 fiber，设置页可以对单个组件启停（deny 列表落盘）。整插件重载时组件一并重建。

用于「一个包提供一族工具，但需要逐项开关」的场景。只提供单一能力的包不要声明组件——入口直接注册，避免多一层间接。

## 兼容性预检

装载插件前，宿主先做运行时与平台兼容性检查。声明不兼容时，插件详情给出归因段，用户可对整个插件授予**精确版本豁免**（写入 `<agentDir>/compatibility.json`）。

豁免只放过这一个插件与这一个运行时版本的组合；换任何一个版本都需要新的豁免。授予等同于接受崩溃与数据丢失风险，因此只在用户明确同意后进行，模型侧通过 `plugin_manager` 的 `set_version_exemption`、且需要 `acceptRisk`。

## 宿主 fiber 检视

cordis 组 fiber 下各插件与组件的加载状态，用 `plugin_manager` 的 `list_plugins` 查组合条目与状态。当前会话的动态插件用 `cordis_inspect_self`。