---
layout: default
title: UI 块
status: living
summary: 助手回复里可携带的声明式、按行组织的块语法，以及它在 MusePi 三种作答面中的位置。
scope:
  - packages/client-core/src/ui-blocks
  - packages/coding-agent/src/prompts/system/system-prompt.md
  - packages/coding-agent/src/bundled-plugins/visuals
---

# UI 块

[English](ui-blocks.md) | 中文

助手回复里可以带一个 ```` ```ui ```` 围栏，围栏体是**声明式组件列表**。其余部分仍是普通文本：块就画在围栏所在的位置，随消息滚动，复制与导出时连同源码一起保留。

## 1. 两种作答面

| 面 | 形状 | 用于 |
| --- | --- | --- |
| ```` ```ui ```` 块（回复内） | OpenUI Lang 组件树，由本模块渲染 | 数据与结构：对比、表格、关键数字、步骤、趋势——以及回复要问出的决定 |
| `widget` 页面 | null-origin 沙箱里的一页自包含 HTML | 必须看起来就是最终样子的版式，或需要用户补条件的选择（`awaitAnswer`） |

没有第三种「成品卡」面：结构化卡片类型现在归看板——卡片在那里能活在画布上——
回复需要表格时直接画表格，而不是去找一张同名的卡。

这套分流只写在一个地方——系统提示的 *Visual answers* 段——并由
`packages/client-core/src/ui-blocks/guidance.test.ts` 保证目录与文案不会分叉。

## 2. 格式：OpenUI Lang

围栏体是 **OpenUI Lang**，与 OpenBitFun、OpenChamber 同一套语言：一行一条语句，
`name = Component(args)`，第一行 `root = Stack([...])`。

````text
```ui
root = Stack([Card("迁移顺序", [Steps([{title: "影子写", status: "done"}, {title: "双读", status: "current"}, {title: "切主"}])]),
  Table(["阶段", "耗时"], [["影子写", "1 天"], ["双读", "2 天"]])])
```
````

共用语言本身就是理由。两个独立产品教模型同一套文法，模型进来就会写；而
MusePi 私有格式等于每个会话都要重新解释一遍方言。解析器
（`@openuidev/lang-core`，MIT）还顺带提供了自研格式必须重做的三件事：

- **局部树**：任意前缀都能解析，于是块可以边生成边生长；
- **具名诊断**：`Card takes 2 arg(s), got 3` 直接点名组件并复述签名；
- **位置参数检查**：模型在位置参数语言里反复写 `Card(title: "x", …)`，解析器用它自己的分词器把这种情况压成一条明确错误，而不是一连串误导。

参数是位置式的。调用里写 `name: value` 是错误，不是风格。

## 3. 组件目录

`Stack Row Card Text Badge Callout KeyValue Table Steps Stat Progress BarChart LineChart`，
外加 `Series`（图表的输入）、`Details`（折叠一段），以及用于提问的
`Choice Input Button`。

- `Text`/`Callout` 接受 `markdown`，但只解释粗体与行内代码，其余一律转义成文本。
- `Table` 输出裸 `<table>`，交给 markdown 管线统一装饰——表格只有一套实现，列宽拟合、复制与下载与直接写在回复里的表格完全一致。
- `BarChart` 取 `labels` 与 `series`；`whole: true` 只在数值确实是「同一个整体的各部分」时才成立，因此占比与合计只在那时显示。
- `LineChart` 至少需要两个 label；`null` 断线而不是画穿零点。
- 色调用应用既有的五种：`neutral info success warning error`。只有 `warning` 与 `error` 才配填充底色——一条回复里五个染色横幅会读成斑马纹。

`render.ts` 里的 `UI_BLOCK_TYPES` 是渲染器与文案校验测试共读的唯一清单。

## 4. 回复结束后失败才可见

块只在回复停止生成之后才做诊断。流式期间，已闭合或写了一半的围栏只显示已经解析出的节点：一次 token 间隔不代表程序写完，中途冒出的错误卡还会用自己的修复请求打断 agent。

回复结束后：

- 完整但丢失部分的块保留完好的节点，逐行列出失败原因与解析器给出的理由（同一理由只列一次），折叠源码，并提供**一个**修复操作；
- 什么都画不出的块显示同样的提示加源码；
- 回复停在语句中间（围栏未闭合，或输出被上限截断）时，只说明「还没写完」并折叠源码，不提供修复——把前缀原样引用回去修不好它。

修复是一次用户回合：按下一次就发送源码与原因，再次点击或重绘都不会重复发送。一条已结束的回复里有多个失败块时，自动修复把它们合成一条消息，而不是每块各发一轮。

## 5. 块能提问

回复可以提问，答案只发一条消息：

- `Choice(name, options, label?, multiple?)`——每行一个选项，可带一句说明；
- `Input(name, label?, placeholder?, multiline?)`——自由文本；
- `DateInput(name, label?, time?, value?)`——日期；`time` 为真时带时间；
- `Slider(name, min, max, label?, step?, value?, unit?)`——区间内的一个数；
- `Button(label, variant?, value?)`——针对同一条目的一个选项。

一张装着 `Button` 的 `Card` 是**一个**由卡标题命名的决定；其他控件各自是一个决定。
四个按钮的卡收集一个答案，不是四个。

答案存在 `answers.ts` 里，按块的哈希索引——因为 markdown 的 HTML 每次提交都会重写，
视图每次渲染后从这份 store 重新水合控件。于是流式 tick、虚拟列表回收、主题切换
都不会弄丢已选。

块底部带一个补充说明框和一个发送按钮，**只有选了东西之后才出现**。按下它会把
**一条**消息（`界面选择：` 加每条决定一行，再加补充说明）组装好并派发
`musepi-ui-block-answer`；桌面与游客壳把它当成普通用户回合投递进会话。已发送的块
转为记录：控件变淡，不再邀请点击。

## 6. 边界

块渲染成 HTML 而不是 React，因为 markdown 管线对整条消息只产出一段 HTML 字符串——
mermaid 受的是同一个约束。由此带来的取舍：

- **没有状态与绑定。** 块是答案的图加它要收的答案；OpenUI 的 `$state`、query 与
  mutation 刻意不支持（它们需要响应式存储与独立评审）。
- **不做持久化。** 块属于它所在的这条消息；要活过回复的东西归看板与 `widget` 页面。
- **流式会绘制未闭合的围栏。** 回复已打开 ```` ```ui ```` 但还没闭合时，围栏在
  markdown 解析前被切出来，用局部树直接渲染，于是块随回复一起长。markdown 解析器
  根本看不到它，所以不会把它当成未完成的代码块扣住。块空闲之后这个切分仍然保留：
  已结束的回复末尾若还有未闭合围栏，那是被截断的输出，不是正文。扫描时围栏成对
  匹配，所以写在其他围栏里的 ```` ```ui ```` 示例不会被误当成正在生成的块。

## 7. 阻塞是另一种面

块的答案是用户的**下一条**消息：画块的这一轮已经结束，所以块永远不可能让 agent
在中途停下。页面存在的全部意义就在这里——`widget` 配 `awaitAnswer` 会让调用一直等待，
`ask` 工具则在轮内索要澄清。

分流由此得出：agent 需要答案才能继续的决定，放进会阻塞的面；用户可以慢慢决定、
可能有多项、还想补一句说明的，放进块。
