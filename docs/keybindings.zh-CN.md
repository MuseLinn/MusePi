# 按键绑定

[English](keybindings.md) | 中文

在 `musepi` 会话中运行 `/hotkeys` 可查看当前构建生效的组合键。该列表会反映从磁盘加载的所有重映射，以及由 extension 添加的绑定。

## 自定义按键绑定

用户重映射保存在 `~/.musepi/agent/keybindings.yml`。该文件是一个 YAML mapping：键为 keybinding action ID，值为单个组合键字符串或组合键字符串数组。它不会从 `~/.musepi/agent/config.yml` 读取，也不存在嵌套的 `keybindings` 对象。

```yaml
app.model.cycleForward: Ctrl+P
app.model.selectTemporary: Alt+P
app.plan.toggle: Alt+Shift+P
```

组合键名称不区分大小写，使用与 UI 中相同的记法，例如 `Ctrl+P`、`Alt+Shift+P`、`Shift+Enter` 和 `Ctrl+Backspace`。

将某个 action 设置为空数组即可禁用它：

```yaml
app.history.search: []
```

## 常用 action ID

| Action ID | 默认值 | 含义 |
| --- | --- | --- |
| `app.model.cycleForward` | `Ctrl+P` | 向前循环 role model |
| `app.model.cycleBackward` | `Shift+Ctrl+P` | 向后循环 role model |
| `app.model.selectTemporary` | `Alt+P` | 为当前 session 临时选择一个 model |
| `app.model.select` | `Alt+M` | 打开 model selector 并设置 role |
| `app.plan.toggle` | `Alt+Shift+P` | 切换 plan mode |
| `app.history.search` | `Ctrl+R` | 搜索 prompt 历史 |
| `app.tools.expand` | `Ctrl+O` | 展开/收起 tool 输出 |
| `app.tools.toggleVisibility` | `Ctrl+Shift+O` | 显示或隐藏 tool 活动 |
| `app.thinking.toggle` | `Ctrl+T` | 切换 thinking block 的可见性 |
| `app.thinking.cycle` | `Shift+Tab` | 循环切换 thinking level |
| `app.editor.external` | `Ctrl+G` | 在 `$VISUAL` / `$EDITOR` 中编辑草稿 |
| `app.message.followUp` | `Ctrl+Q`, `Ctrl+Enter` | 将 follow-up 消息加入队列 |
| `app.message.dequeue` | `Alt+Up`, `Shift+Up` | 将已入队的消息取回编辑器 |
| `app.retry` | `Alt+R` | 重试最近一次失败的 assistant turn |
| `app.display.reset` | `Alt+L` | 重置终端显示 |
| `app.clipboard.copyLine` | `Alt+Shift+L` | 复制当前行 |
| `app.clipboard.copyPrompt` | `Alt+Shift+C` | 复制整个 prompt |
| `app.clipboard.pasteTextRaw` | `Ctrl+Shift+V`, `Alt+Shift+V` | 粘贴剪贴板文本且不做折叠处理 |
| `app.clipboard.pasteImage` | Linux: `Ctrl+V`; macOS: `Ctrl+V`, `Cmd+V`; Windows: `Ctrl+V`, `Alt+V` | 从剪贴板粘贴（优先图片，文本兜底） |
| `app.stt.toggle` | 未绑定（按住 `Space`） | 切换 speech-to-text。默认没有组合键——按住空格键开始录音（push-to-talk），松开即转写；如需按下即切换（press-to-toggle）的方式，可在此绑定组合键 |
| `app.live.toggle` | `Ctrl+L` | 启动或停止 live voice mode（与 `/live` 相同） |
| `app.agents.hub` | `Alt+A` | [打开 Agent Hub](./agent-hub.html) |

在 Windows Terminal 中，`Ctrl+V` 可能会在 `musepi` 收到之前被终端自身的粘贴命令截获；如果剪贴板图片粘贴看起来毫无反应，请改用 `Alt+V` 兜底。当剪贴板中没有图片时，`app.clipboard.pasteImage` 会改为粘贴剪贴板文本，因此只传递这一个组合键的宿主环境（配置为转发 `Ctrl+V` 的 VS Code 集成终端、通过 `Win+V` 触发的 Windows 剪贴板历史）对两类内容都能正常工作。Windows Terminal 还会吞掉 `Ctrl+Enter`，因此 `app.message.followUp` 还绑定了 `Ctrl+Q`——GitHub Copilot CLI 使用的也是这个组合键——并且同一组合键也用于提交 agent dashboard 的新 agent 描述以及 hook 编辑器中的 prompt。如果你现有的 `keybindings.yml` 已把 `Ctrl+Q` 分配给其他 action，用户重映射优先生效，follow-up 将保留 `Ctrl+Enter`，除非你显式绑定 `app.message.followUp`。

实现了 OSC 5522 增强粘贴的终端可以把剪贴板 MIME 数据直接发送给 `musepi`；图片粘贴会以 `[Image #N]` 形式附加，而 text/plain 粘贴事件保持普通粘贴行为。当 OSC 5522 不可用时，bracketed paste 仍可处理文本；当粘贴的是单个图片文件路径且 `musepi` 宿主可以读取该文件时，它会作为图片加载。

旧的未加命名空间前缀的 action 名称会在加载 `keybindings.yml` 时自动迁移，但新文档和新配置应使用上述带命名空间的 action ID。已有的 `keybindings.json` 文件仍被接受并迁移为 `keybindings.yml`；`keybindings.yaml` 也被接受。
