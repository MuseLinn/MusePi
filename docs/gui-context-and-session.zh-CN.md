---
layout: default
title: GUI 上下文、会话层级与角色模型
status: living
summary: 结构化引用上下文、子会话折叠、宿主权威的会话阅读状态，以及角色/回退模型思考等级契约。
scope:
  - packages/client-core/src/messages
  - apps/desktop/src/components
  - packages/coding-agent/src/session
  - packages/coding-agent/src/daemon
lang: zh-CN
---

# GUI 上下文、会话层级与角色模型

[English](gui-context-and-session.md) | 中文

本文统一管理四个此前不断追加到 GUI 总规范中的契约：结构化引用卡、子会话折叠、会话阅读状态，以及角色与回退模型思考等级。

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

## 会话阅读状态

会话是否未读、是否失败由 daemon 决定。`SessionReadStateService` 在宿主上按会话保存一条记录，并以 tmp+rename 持久化到 daemon 状态目录的 `session-read-state.json`，因此标记能跨 daemon 重启保持，同一宿主上的所有客户端看到同一个答案：在手机上打开会话会清掉桌面上的点，已清掉的失败提示重启后不会复活。fork、子会话与 advisor 会话是独立 session id，因此各有独立记录；显示哪些行由客户端筛选。

记录统计的是**完成轮**，不是消息数：

| 字段 | 含义 |
| --- | --- |
| `completedTurn` | 本宿主上观察到的已完成 agent run 数，单调递增。 |
| `readTurn` | 用户最后一次已读到的 `completedTurn`。 |
| `lastFailed` | 最近一次完成轮是否以错误结束。 |
| `manualUnread` | 用户手动把会话标为未读；只有显式已读能清除。 |

派生状态为 `unread = manualUnread || completedTurn > readTurn`，`failed = unread && lastFailed`。因此失败提示只在该失败轮仍未读时存在：打开会话会清掉它，之后成功的一轮也会清掉它，而中止是用户的决定、不算失败通知。有客户端正在订阅该会话时，完成轮会推进 `readTurn`（转录就在屏幕上），但绝不会清除 `manualUnread`——手动固定的会话保持未读，直到显式已读。

客户端不再用消息数推导未读。`session.list` 的每行携带 `read`（`unread`、`failed`、`manualUnread`、计数与 `completedAt`），`sessionStatus.list` 返回完整跟踪集合。打开会话发送 `sessionStatus.mark { sessionId, read: true }`，清除手动固定并追上最新完成轮；侧栏菜单的 标记为已读/未读 走同一路由，以 `unread: true` 固定。`sessionStatus.markAll` 把全部跟踪会话加上调用方列出的 id 一起置为已读，欢迎页提醒面板与桌宠角标消费轮询投影出的 `unread` 集合；点桌宠气泡的 ✓ 也是同一次显式已读。没有记录的会话表示本宿主上从未完成过轮次，按已读处理。

旧 localStorage 游标（`musepi-gui-unread`、`musepi-gui-read-count`）已不存在。升级后首次启动时，所有既有会话本来就是已读，因为宿主初始没有任何完成轮记录；旧键直接删除，不再解释。

桌面侧栏对普通未读行画 accent 点，对未读失败行画 danger 点；两者互斥（失败行撤掉 accent 类），失败标记带可访问名称。移动端 `SessionsSheet` 读取同一状态，行首点采用相同的 accent/danger 区分。两个界面都不从会话持久化的生命周期状态渲染失败：生命周期可能描述更早的一轮，而阅读状态始终描述最近完成的一轮。

## 撤回

撤回是移动分支，不是删除：`session.branchAt` 把会话 leaf 移到该消息的父节点，这一回合因此离开活跃路径，作为旁支留在树上。被撤回的回合仍然能从地图和消息树回到——这正是设计意图，不是 bug。

用户可见的契约：

- **先问再动。** 所有把 leaf 移出对话末端的动作都问同一句：转录行的 ⤺ 动作与它的「编辑并重发」、消息树面板的行、地图的重答、面板里的回合重答。切换到另一分支同样是移动 leaf，但它是用户读旁支的方式，所以不问。确认里点名那一回合（引它的原话；行里没有可读内容时写「更早的一回合」），并用产品自己的话说明后果：这一回合会移到旁支、不会删除任何内容、文字和图片回到输入框、浮条提供一次撤销。运行中的回合也写在同一句里——「正在写的回复会在撤回时停止」——而不是先弹一个「是否中断」、回答后再弹一个「确定吗」；停下发生在回答之后。取消会在任何 RPC 之前返回，leaf 不会移动。
- **转录只跟随活跃路径。** 撤回后它显示到撤回目标为止（含目标）的对话，被放弃的尾部一行都不显示。输入框上方的浮条点名跳转目标并提供唯一一次撤销，撤销会切回去并恢复该回合。
- **一条优先级规则，不是特例。** daemon 回答过 `branchAt`（或广播过 `session_leaf_moved`）之后，它的路径就是权威，决定转录可见性；本地 `parentId` 链走只是"这个窗口里没被回退过"的会话的兜底。这条规则只写一次——这里与 `leaf-walk.ts`——因为 `parentId` 断链在 wire 上是合法的（`packages/wire/src/index.ts:173`），是回退后的常见形态，不是边角情况。整段链路都缺失的尾部与会话根部的连续段无法区分，walk 因此会回答 `complete: true` 却在描述错的路径；这正是它不能盖过 daemon 答案的原因。
- **那份权威是一段窗口，不是全路径。** daemon 最多只回最后 200 条（`daemon/server.ts` 把 `pathEntries` 切成 `TAIL_ENTRIES`），而客户端保留它加载的每一页。所以 daemon 路径只从它的首个 id 往后作数；更老的行回落到链走，链不可信时一行不藏。把这段投影当成无条件权威，会让任何加载超过 200 行的会话在撤回的瞬间删掉真实历史。daemon 路径也只收 message，所以链走放在活跃路径上的 compaction 分隔即使不在集合里也仍然可见。
- **用户再次输入时权威结束。** 新消息提交了新分支并丢掉 pinned 路径，之后由链走重新跟随末端。留着旧路径会把 bug 反过来：转录会藏起刚刚问出来的回答。新回合开始时 daemon 会广播新的路径。
- **旁支轮以数据形式标记。** `TrajectoryTurnGroup.offPath` 在该轮首事件不在活跃路径上时为 `true`，路径未知时为 `undefined`——只有已知路径时"不在路径上"才有意义。地图怎么画这件事属于地图自己的范畴。

## 角色与回退模型思考等级

角色值使用 `provider/id:level`，包含 `:auto`。`auto` 是每个角色独立的策略，不是全局默认值，也不是 effort rung。clamp 保留 auto；不支持的 concrete level 回退到 `inherit`，`off` 与 `auto` 始终有效。

角色行提供 `inherit`、`auto`、`off` 和当前模型的 concrete efforts。每个回退行有相同的独立选择器，但阶梯由该选择器的 `models.detail` 提供。修改某个回退项只替换其后缀，不影响主角色或其他回退项。
