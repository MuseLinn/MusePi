# 会话内动态插件（`cordis_*`）

不写盘就能验证一个插件想法：定义、运行、检视、停止、撤销都在当前会话内完成。

## 工具

| 工具 | 作用 |
| --- | --- |
| `cordis_define` | 定义一个不可变版本；只定义不运行 |
| `cordis_run` | 用 `mode=run\|update` 激活并返回 `runId` |
| `cordis_stop` | 停止运行 |
| `cordis_undefine` | 撤销定义 |
| `cordis_inspect_list` | Host/Client provider 与只读方法目录 |
| `cordis_inspect_query` | 按 platform/provider/method/input 精确查询 |
| `cordis_inspect_self` | 当前会话的 plugin/package/version/source/diagnostics |

## 工作流

1. `cordis_inspect_list` / `cordis_inspect_query` 查可用 API 与精确契约，不要凭记忆写方法名。
2. `cordis_inspect_self` 看现有插件：修改已有插件时用它读源码。
3. `cordis_define` 定义不可变版本。
4. `cordis_run` 激活并自检。
5. 失败时用**同一个 `pluginId`** 追加修正版本，不要另建替换插件。

## 契约边界

动态插件的 `hostCode` 是**沙箱函数体**：只有 `defineTool`、定时器与 `console`，命名空间是 `extdyn__`。它拿不到插件包入口的 `PluginAPI`。

因此原型验证的是交互与工具语义，不是完整能力。要访问 RPC、座位、提示词区块这些宿主能力，交付成插件包。

## 什么时候用

- 需要快速验证「这个工具能不能用、界面长什么样」——用 `cordis_*`。
- 需要长期存在、可安装、可分发——用插件包。

两者不互相替代：原型解释交互，包承载能力。