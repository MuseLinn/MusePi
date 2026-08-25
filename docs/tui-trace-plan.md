# TUI /trace 方案:消息树 × 轨迹融合视图(2026-08-21 规划)

> 状态:**已实现(2026-08-26)**。`/trace` 已落地:`packages/coding-agent/src/modes/components/tree-selector.ts` 的投影参数(TreeProjection:HH:mm:ss 时间列、tokens↑↓ 用量、耗时、8 级成本条、错误态符号)叠加在既有 `/tree` 结构投影上;`slash-commands/builtin-session.ts` 注册 `/trace`(与 `/tree` 同入口,切换投影)。测试:`test/modes/components/trace-selector.test.ts`(29 断言,全通过)。
> 背景与术语见 `docs/gui-design.md` §0 术语表——本方案的核心前提是「会话树(消息树)」与「轨迹」是同一批 entries 的两个投影轴:结构(parentId 分支)与时间/成本——`/tree` 与 `/trace` 分别落地这两个轴。

## 1. 动机

- GUI 右侧轨迹面板已具备完整时间投影(turn 树 + Overview 时间轴 + 检视,TODO 2026-08-21 落地)。
- TUI 的 `/tree` 已有完整的**结构投影**(分支点 gutter、叶移动、选中汇总、label 编辑),但节点只显示文本+结构,**没有时间/成本维度**——"这步花了多久、烧了多少 token、哪里失败"答不上来。
- dsh 生态的 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)(DeepSeek Harness 官方公众号收录的 TUI 插件)已经示范了 TUI 轨迹的排版,可直接借鉴,无需重复发明。

## 2. 目标形态

```
/trace            # 打开轨迹视图(树结构 + 时间/成本投影)
/tree             # 保持纯结构投影(现状),/trace 是其时间视角
```

两者共用同一棵 entry 树(数据源 = tree-selector 现有的 SessionEntry 树);`/trace` 的每一行 = 树的一行,叠加轨迹列:

```
╭─ 2026-08-21 10:02:31  question about the bug          ▂▃▄  12.4k↑ 3.1k↓  8.5s   失败
│   2026-08-21 10:02:45  runtime_tool {key: "x"} → ok   ▅▇█  4.2k↑ 0.9k↓   1.2s
│   2026-08-21 10:02:47  apply_patch {...} → applied    ▅▇█  6.1k↑ 1.8k↓   2.0s
╰─ 2026-08-21 10:03:02  summary text                        ▁▂   2.0k↑ 0.4k↓   1.1s
```

- **脊柱**:git-graph 扁平行(`╭ │ ╰`),同一 turn 内行不缩进、靠脊柱表达归属(dsh-TUI Ledger 同款——缩进会破坏 40+ 行一眼扫的对齐)。
- **成本条**:每行一个单格绝对尺度的条形(8 级 `▁▂▃▄▅▆▇█`),颜色承载工作类型(input 蓝 / tool 黄 / model 紫);失败列直接红(入带不入注)。
- **指标列**:时间戳 + 输入/输出 token + 请求耗时 + 速率(数据全在 wire `AssistantMessage.usage/.duration/.ttft` 上,TUI 的 `usage-row.ts` 已在消费,零新数据依赖)。
- **检视**:光标行即出固定高度 Inspector(跟光标零击键,Enter 展开全高页)——dsh-TUI Inspector 的"高度恒定、只发样式字节"决策照搬。
- **成本排序视图(可选 tab)**:按工具/模型相位(解码 vs 等首字节 vs 重试)/turn 排出"时间去哪了"——dsh-TUI HotspotView。

## 3. 数据可行性(已核实)

| 数据 | 位置 | 状态 |
|---|---|---|
| 树结构(parentId) | 会话级 `session-manager`(`leafId()` 在建 entry 时写入,`packages/coding-agent/src/session/session-manager.ts`) | ✅ TUI 本地已有,`/trace` 直接复用 |
| 时间戳 | entry.timestamp | ✅ |
| token 用量 / 请求耗时 / TTFT | wire `AssistantMessage.usage/.duration/.ttft`(settled 回合) | ✅ 已在事件流,TUI usage-row 已在渲染 |
| 失败/中止 | message.`stopReason` / event 流 | ✅ |

**GUI 侧同款数据缺口(一并记录)**:wire message 事件目前**全程不带 parentId**(`WireMessage` 无该字段;`MaterializedView` 投影消息时硬编码 `parentId: null`,仅历史/持久化快照原样保留)。要 GUI 做消息树视图,需协议 seam:①wire 三消息角色(User/Assistant/ToolResult)加可选 `parentId`(已加,向前兼容);②daemon 发射端在 message 事件上打标(`agentSession.sessionManager` 在建 entry 时已知 parentId);③`MaterializedView` 保留 `message.parentId`(已加)。GUI 侧 `lib/message-tree.ts` 的 `buildMessageTree` 已就绪(历史快照立即可用)。

## 4. 实施步骤(排期建议)

1. **P0**:TUI `/trace` 视图骨架——复用 tree-selector 的数据源与键盘导航,行渲染换成 Ledger 式(脊柱 + 成本条 + 指标列),`/tree` 不变。
2. **P1**:Inspector 跟光标检视(usage/duration/ttft 转描);状态行加 MiniWake 微缩带(segment 体系已就绪,成本最低)。
3. **P1**:HotspotView 成本排序 tab。
4. **P2(可选)**：GUI 轨迹面板加「时间线/分支树」切换(复用 `buildMessageTree`),需先落地上述 wire seam(daemon 打标)。

## 5. 参考来源

- dsh-TUI `src/components/trajectory/`(MIT,CC-style TUI 插件):`Ledger`(脊柱+成本条)、`Inspector`(跟光标+固定高度)、`WaveBand`(整场一行字形带)、`HotspotView`(成本排名)、`MiniWake`(状态行微缩带)、`RewindPicker`(双击 Esc 回溯)。
- openchamber:消息树/会话树的分组与行式。
- 本项目 `lib/message-tree.ts`、`trajectory-data.ts`、`TimelineOverview.tsx`(GUI 侧对应实现)。