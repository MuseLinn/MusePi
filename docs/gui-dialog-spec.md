# 弹窗与浮层规格

> 状态：2026-10-25 更新，为 `docs/gui-design.md` §5e / §5u 的执行细则。规范正文，不是变更记录。
> 适用范围：`apps/desktop/src/components/` 与 `packages/client-core/src/components/` 下所有 Dialog / Panel / Popover / Sheet / Menu / Modal / Overlay 组件。

本文件规定尺寸、滚动、焦点与键盘契约；六类浮层的选择与材质见 `docs/gui-design.md` §5u。

---

## 1. 基座与共享焦点

| 层         | 入口                                                          | 何时用                                             |
| ---------- | ------------------------------------------------------------- | -------------------------------------------------- |
| 模态对话框 | `DialogFrame`；client-core 危险/普通确认使用 `ConfirmDialog` | 需要用户先处理完才能继续的：设置、确认、快捷键说明 |
| 非模态浮层 | `ContextMenu` / `MenuPopup` / `AskPopover`                    | 锚定在元素上的菜单、气泡                           |
| 内嵌面板   | 右栏 / 底部 dock 的既有容器（`gui-surface-tabpanel` 一族）    | 与主内容并存的常驻区域                             |

`DialogFrame` 已提供、**不得重复实现**的行为：

- **两阶段进出场**：首帧 opacity 0 且不带动画类，让磨砂背板先合成，避免"透明→玻璃"闪一下；随后 `--entered` 跑缩放淡入。`open` 翻 false 后组件保持挂载直到退场动画结束。
- **常驻挂载**：宿主必须无条件渲染并用 `open` 驱动。**不要条件挂载**（`{open && <DialogFrame/>}` 会丢掉退场动画）。
- **键盘归属**：只有共享栈顶弹窗处理 Escape；普通确认允许 Enter，危险确认禁止 Enter 提交。任何按键都不得漏给背后的 composer。
- **焦点**：共享 `useModalFocus` 在打开时移焦（第一个可聚焦元素，否则弹窗本身），关闭栈顶时归还可连接的 opener；Tab / Shift+Tab 仅在栈顶循环。
- **`label` 必填**：作为 `role="dialog"` 的可访问名称。

其他私有 modal、drawer、sheet 不强制改用 `DialogFrame`，但必须复用 `useModalFocus` / `isTopModal`，不得另写平行焦点栈。

---

## 2. 尺寸：四档，不许自定义

`.gui-dialog` 的默认值是 **600×420 的设置框**。它是基类，不是弹窗的默认尺寸 —— 用它装一张两栏的快捷键表就是把内容挤爆。

| 档位     | 宽 × 高                                                         | 用于                                                           |
| -------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| 紧凑     | `width: auto; max-width: 380px`                                 | 确认框、输入框（已有 `.gui-dialog--confirm` / `--prompt`）     |
| 标准     | `min(600px, 90vw)` × `min(420px, 80vh)`                         | 单列表单类设置面板                                             |
| 宽       | `min(1040px, 94vw)`，高 `auto` + `min-height: min(58vh, 620px)` | 多分组列表、需要滚动容器的参考面板（`.gui-dialog--shortcuts`） |
| 全屏面板 | `min(88vh, 880px)` 上限                                         | 设置中心、扩展中心                                             |

**弹窗高度由内容撑开，不由固定值撑开。** 只在"内容可能超过视口"时才给 `min-height`，并同时加大行距去填满它 —— 只给 `min-height` 会留下一块与内容无关的死空间。

**滚动区与内容区的间距必须大于组内间距。** 否则多个分组会读成一整串列表。

### 确认框：标题只写动作，解释进正文

`confirm(message)` 的 `message` 是**标题**：一行说明这次操作会做什么（「撤回这一回合？」「删除 3 个会话？」）。需要解释后果、补充约束或引用原文时，把说明放进第三个参数的 `body`；正文按空行分段，正文区自带 `--ui-font-size-sm` 与 `--color-text-muted`。

- 不要把整段说明塞进标题：`.gui-dialog--confirm h3` 是 17px/600 的标题字阶，整段正文会被当成标题排版（用户报告：「撤回」弹窗读起来像一整块粗体正文）。
- 标题里已经引用过的原文不要在正文重复一遍。
- 正文过高时由 `.gui-dialog-body` 自己滚动（`max-height: min(46vh, 320px)`），弹窗不跟着长高，按钮始终可见。

---

## 3. 修饰类必须写成 `.gui-dialog` + 修饰名

这是本文件最重要的一条，因为它的失败是静默的。

`gui.css` 的 `@import` 顺序是固定的：`gui-chrome.css` 在 `gui-composer.css` **之前**。而 `.gui-dialog` 定义在 `gui-composer.css`。同特异度下**后加载的样式表赢**，所以只写修饰类、且该修饰类所在文件比基类更早时，修饰类里的每一条声明都不生效。

```css
/* 错：这条规则可能从未生效，且没有任何报错 */
.gui-dialog--shortcuts {
  width: min(1040px, 94vw);
}

/* 对：靠特异度取胜，不依赖 import 顺序 */
.gui-dialog.gui-dialog--shortcuts {
  width: min(1040px, 94vw);
}
```

**规则：新增修饰类一律写成 `.gui-dialog.<修饰名>`。** 已在 `gui-composer.css` 内、且位置在 `.gui-dialog` 之后的修饰类（`--confirm` / `--prompt` / `--pending` / `--entered` / `--closing`）是历史遗留的例外，不要模仿。

配套检查：`bun run check:tools` 的 `css-structure` 门禁只管括号平衡，**不管遮蔽**。遮蔽靠这条约定 + review。

---

## 4. 滚动容器：两侧羽化，且只羽化被遮住的一侧

可滚动列表硬裁在圆角边框上，看起来像渲染故障。

- 滚动容器必须有 `min-height: 0` 和 `overflow-y: auto`，并且在 flex 链上拿到剩余空间（`flex: 1 1 auto`）。
- **弹窗的主动作在滚动区之外。** 内容可能超过 `max-height` 的弹窗由三段组成：固定标题、唯一滚动容器、承载当前状态唯一决定性动作的底栏。按钮留在滚动内容末尾，等于在小窗口里把它藏起来。
- **`DialogFrame` 的 `.gui-dialog-morph` 默认是块级。** 块级包装会让正文的 `flex: 1 1 auto` 静默失效，内容随 `max-height` 被裁掉而不是滚动；需要滚动的弹窗必须自己把这一层续成 flex 列（`display: flex; flex-direction: column; min-height: 0; overflow: hidden`），再让滚动容器声明 `flex: 1 1 auto; min-height: 0`。参照 `.gui-collab-dialog`。
- **不要写固定 `mask` 羽化。** 内容装得下时固定 mask 会把首行和末行也淡化，那是错的。正确做法是由组件按实时滚动位置设 `data-scrolled-top` / `data-scrolled-bottom`，CSS 只对被遮住的一侧加渐变。
- 参照实现：`.gui-shortcuts-grid` + `ShortcutsDialog` 的 `measure()`。
- **不要用 `gap-N` 之类的 Tailwind 工具类表达栏间距。** 生成产物 `tailwind.out.css` 是 content-scan 的，只含被扫到的工具类；任意写一个 `gap-8` 不会报错也不会生效。间距写进自有 CSS 规则。

---

## 5. 焦点与叠层

- **嵌套 modal 允许共存。** `useModalFocus` 按激活顺序压栈；只有 `isTopModal` 命中的栈顶处理 Tab / Shift+Tab 和 Escape，底层保持打开但不响应这些键。
- 关闭栈顶时，若 opener 仍连接则归还焦点；opener 已断开则不抛错、不强行选新焦点。关闭底层或任意组件卸载都不得从剩余栈顶抢焦点。
- `CommandPalette` 保留自己的输入焦点、方向键导航和 Escape 处理，不属于共享栈；不要假设所有带 `role="dialog"` 的元素都自动入栈。
- 浮层里的可聚焦元素必须能被 Tab 走通；不可聚焦的装饰元素标 `aria-hidden`。
- 任何 `Enter` 有歧义的场景（发送消息 / 提交表单），在浮层里显式声明归属，不要指望浏览器默认。普通确认允许 Enter；`destructive: true` 禁止 Enter 提交，Promise confirm 初始聚焦 Cancel，Escape 仅由栈顶认领。

---

## 6. 新增弹窗的检查清单

写完一个浮层，逐条核对：

- [ ] `DialogFrame` 无条件挂载并用 `open` 驱动；私有宿主保留既有挂载契约，但焦点必须接入共享栈
- [ ] 传了 `label`
- [ ] 尺寸取自第 2 节的四档之一；修饰类写成 `.gui-dialog.<名>`
- [ ] 修饰类所在文件的 `@import` 顺序已确认（`gui-composer.css` 之前 = 必须复合选择器）
- [ ] 可滚动的话：滚动容器加了 `min-height: 0` + `flex`，羽化按滚动位置开关
- [ ] 没有依赖未在生成产物里的 Tailwind 工具类
- [ ] 内容量 > 组内间距
- [ ] 只有栈顶处理 Escape 与 Tab，关闭后归还可连接的 opener；危险确认不允许 Enter 提交
- [ ] L2/L3 材质取自六类选择表，motion-off/reduced-motion 同时关闭入场和出场
- [ ] `bun run --cwd=apps/desktop check` 与该包的测试通过

---

## 7. 尺寸形变

`DialogFrame` 接受可选的 `morphKey`。当它变化时（步骤切换、面板展开、等待态变为结果），弹窗高度走共享 spring（`HeightMorph`，0.32s、按距离限幅的过冲）而不是突跳；固定高度的弹窗不要传。

- `morphKey` 必须命名一个内容身份（步骤、条目 id + 展开项），不要传每次渲染都变的随机值。
- 形变期间内容被裁剪，由 `HeightMorph` 在收敛后释放；弹窗内部不要再写第二套高度动画。
- reduced motion 下仍然改变高度，但不产生位移。

### 共享元素转场（一镜到底）

有可见触发者的弹窗走浏览器的 View Transitions：触发元素在旧快照里被赋予 `view-transition-name`，目标弹窗的类名携带同名（`connector-surface` / `connector-import` / `device-signin`）。浏览器把两个矩形匹配成一组，同时做位置与尺寸过渡，并交叉淡化内容；两侧快照各按自身尺寸绘制，所以任何一边都不会被拉伸。曲线取鸿蒙的 friction 曲线 `cubic-bezier(0.2, 0, 0.2, 1)`、280ms：起步和落位都有重量，不用采样 spring 的线性尾部。运动编排上出场快、进场稍晚：旧快照 120ms 加速淡出，新快照 180ms 减速淡入并延后 32ms，两者不会叠在一起。

- 触发处调用 `apps/desktop/src/lib/view-transition.ts` 的 `morphSurfaceFrom(element, name, update)`；它在更新后清掉触发元素的临时名字，并先把仍占用同名 `view-transition-name` 的退场弹窗让名——旧状态里出现两个同名元素时，浏览器会忽略这组转场并退回普通淡入。
- 目标名字由弹窗类名提供，不要在调用处再写内联名字。
- 过渡期间 `<html>` 带 `gui-view-transition`：弹窗的首帧透明与入场动画在这段时间关闭，避免与浏览器的几何动画叠加。
- 由转场打开的弹窗在整轮打开周期里不播放入场动画（`gui-dialog--static`）：否则转场结束、标记类移除时，入场动画会从头再播一次，读作闪烁。
- 关闭用 `morphSurfaceBack(from, trigger, name, update)`：旧快照里的表面交出名字，目标元素在更新里接过，浏览器反向匹配两个矩形；目标元素已不存在时回退为既有 exit。
- 已接入：连接器卡片 ↔ 详情弹窗、导入按钮 ↔ 导入弹窗、设备码、插件市场卡片 ↔ 详情弹窗（双向）、技能卡片 → 详情抽屉头部（展开）、看板卡片 ↔ 聚焦卡片（双向）。
- 不支持该 API、关闭动效或 reduced motion 时回退为普通更新，弹窗走既有入场。

- 没有触发者的弹窗（命令面板、启动即弹、跨页面唤起）不参与，保留默认入场。
- 关闭仍走既有 exit 动效；触发元素在关闭时已不存在不影响结果。

## 8. 与其他文档的关系

- `docs/gui-design.md` §5e / §5u 是设计意图；本文件是执行细则。冲突时以本文件为准，因为这里记录的是当前实现的实际约束。
- `docs/gui-implementation.md` §8 是 UI 改动的验证流程，配套使用。
