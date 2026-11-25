# 发现、安装与热更新

## 插件装在哪

| 作用域 | 目录 | 说明 |
| --- | --- | --- |
| 用户 | `~/.musepi/plugins/<name>/` | `getPluginsDir()`；`plugin_manager` 的 `install_bundle` 装到这里 |
| 项目 | 项目 registry 所在目录的插件根 | 同名包覆盖用户级 |
| 发行内置 | `packages/coding-agent/src/plugins/<domain>/<pkg>/` | 随发行包分发，不由用户增删 |

同名包按「项目覆盖用户」解析，与市场安装的阴影语义一致。

## 安装与启用

模型侧走 `plugin_manager`：

- `list_plugins` — 两轨的插件行与状态，每行带 `track`（`cordis` / `extension`）
- `list_bundles` — profile 可叠加的 bundle
- `install_bundle` / `remove_bundle` — 装/卸包
- `set_plugin` / `set_bundle` — 切换某一行、选中/取消一个 bundle；`set_plugin` 按行的 `track` 写回各自存储（`extension` 行改 `musepi-plugins.lock.json`，`cordis` 行改 profile patch）
- `list_version_exemptions` / `set_version_exemption` — 精确的版本兼容豁免

`install_bundle` 的 `target` 就是市场版本给出的 `install.target`；若该版本声明了非默认 npm registry，同时传 `install.registry`。

安装会执行宿主代码，还可能运行构建脚本，因此**需要自动批准的会话**；否则让用户从插件页完成。授予版本豁免等于接受崩溃与数据丢失风险，只在这个精确的插件/运行时版本对上、且用户明确同意后授予。

## 热更新

改动插件入口文件后，watcher 在约 500 毫秒内广播变更；界面约 1 秒刷新，活跃会话重载属主入口（忙会话挂起、`agent_end` 补做），无需重启 daemon。会话内工具在下次调用生效，未重新注册的旧工具名被移除。

子模块改动同样生效：watcher 按整张源码图的 mtime 判定，命中后重载属主入口。

watcher 忽略 `node_modules` 与 `.git`：依赖靠重装而非编辑，跟随 workspace 符号链接会让监视器回到已经监视的目录，从而陷入不终止的遍历。

插件内存状态不迁移。只有改了发现/加载机制本身时才需要重启 daemon。

## 排障顺序

1. `plugin_manager` 的 `list_plugins` — 行是否存在、状态是否为启用
2. `cordis_inspect_self` — 当前会话已装载的动态插件与诊断
3. 宿主日志 — 装载失败的结构化原因会写在这里

没有证据支持的结论要标为未验证，不要凭印象报告「已加载」。