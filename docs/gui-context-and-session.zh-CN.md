---
layout: default
title: GUI 上下文、会话层级与角色模型
status: living
summary: 结构化引用上下文、子会话折叠和角色/回退模型思考等级契约。
scope:
  - packages/client-core/src/messages
  - packages/desktop-app/src/components
  - packages/coding-agent/src/session
lang: zh-CN
---

# GUI 上下文、会话层级与角色模型

[English](gui-context-and-session.md) | 中文

本文统一管理三个此前不断追加到 GUI 总规范中的契约：结构化引用卡、子会话折叠、角色与回退模型思考等级。

## 结构化 display context

`DisplayContext` 是消息级展示元数据。模型文本与 UI 从同一个值派生，展示元数据不参与模型行为分支。

变体：

- `browser-annotation`：页面 URL、prompt、可选评论和截图。
- `chat-quote`：会话引用文本、可选源消息 id 和评论。
- `file-quote`：工作区路径、选中文本、可选语言、行号和评论。空 quote 表示整文件引用，只发送路径。

`composeDisplayContextPrompt` 生成模型文本。立即发送、工作中 steer/followUp、队列、queued pop/send、optimistic echo 和持久化都同时保留结构化值。普通 Markdown blockquote 不是 context。

Composer chip 提供来源、预览、移除和评论编辑。编辑期间逐字保留空格和换行，只有组成模型 prompt 时才 trim 首尾空白。没有 `Comment:` 行的浏览器批注 prompt 保持逐字不变。

Transcript 使用专用来源卡，包含左竖线、quote clamp/展开、评论和可用时的源消息回跳，不会把普通 blockquote 重新解释成专用卡。

### 文件与代码引用

FilePane 的引用动作发送 `file-quote`，不再把 `@path` 裸文本放进草稿。预览内选区携带选中文本；没有选区时引用整文件。按钮与 Cmd/Ctrl+L 共用 `data-file-path` 和 `data-file-language` 的来源身份。

只有选区能唯一映射回源文件时才写行号；重复或无法映射的文本只保留路径，不伪造范围。引用按钮在 pointer-down 时保留当前选区。

## 子会话折叠

折叠的父会话仍留在列表中并代表隐藏的子会话。只有子行执行高度动画，父行绝不进入零高 leaving 动画。展开恢复原有子会话，不依赖重新挂载。

共享子树存储协调所有 `SessionList` 实例并持久化 collapsed id。搜索会临时展开命中路径。行容器支持键盘操作，折叠使用独立按钮，不嵌套 `<button>`。

头部全局动作同时协调项目与子树：

- `setGroupsAll` 接收 `open`，`setAllSubtreesCollapsed` 接收 `collapse`。
- 没有组覆盖（`groupsAll === null`）时，以真实子树状态决定下一动作。
- 每个 tab 先应用项目/组状态，再按同方向调用 `setAllSubtreesCollapsed`。

## 角色与回退模型思考等级

角色值使用 `provider/id:level`，包含 `:auto`。`auto` 是每个角色独立的策略，不是全局默认值，也不是 effort rung。clamp 保留 auto；不支持的 concrete level 回退到 `inherit`，`off` 与 `auto` 始终有效。

角色行提供 `inherit`、`auto`、`off` 和当前模型的 concrete efforts。每个回退行有相同的独立选择器，但阶梯由该选择器的 `models.detail` 提供。修改某个回退项只替换其后缀，不影响主角色或其他回退项。
