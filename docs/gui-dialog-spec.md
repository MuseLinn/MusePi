# 弹窗与浮层规格

> 状态：2026-10-04 定稿，为 `docs/gui-design.md` §5e / §5u 的执行细则。规范正文，不是变更记录。
> 适用范围：`packages/desktop-app/src/components/` 与 `packages/client-core/src/components/` 下所有 Dialog / Panel / Popover / Sheet / Menu / Modal / Overlay 组件。

本文件存在的原因：41 个浮层组件共用一个基座（`DialogFrame`），但尺寸、滚动与焦点此前没有任何统一约定，于是每个弹窗各自在样式表里发明一个修饰类。2026-10-04 快捷键弹窗的修复过程中，同一个弹窗上连续暴露四类缺陷 —— 修饰类被基类遮蔽而从未生效、样式块括号缺失导致其后规则全失效、内容重复渲染、滚动列表硬裁切。**四类都不会让任何门禁失败。** 本文件把约定写死，让下一次同类问题在 review 阶段就被挡住。

---

## 1. 基座：只有 `DialogFrame`

浮层分三层，各自有唯一入口。不要绕过。

| 层         | 入口                                                          | 何时用                                             |
| ---------- | ------------------------------------------------------------- | -------------------------------------------------- |
| 模态对话框 | `DialogFrame`（`desktop-app/src/components/DialogFrame.tsx`） | 需要用户先处理完才能继续的：设置、确认、快捷键说明 |
| 非模态浮层 | `ContextMenu` / `MenuPopup` / `AskPopover`                    | 锚定在元素上的菜单、气泡                           |
| 内嵌面板   | 右栏 / 底部 dock 的既有容器（`gui-surface-tabpanel` 一族）    | 与主内容并存的常驻区域                             |

`DialogFrame` 已提供、**不得重复实现**的行为：

- **两阶段进出场**：首帧 opacity 0 且不带动画类，让磨砂背板先合成，避免"透明→玻璃"闪一下；随后 `--entered` 跑缩放淡入。`open` 翻 false 后组件保持挂载直到退场动画结束。
- **常驻挂载**：宿主必须无条件渲染并用 `open` 驱动。**不要条件挂载**（`{open && <DialogFrame/>}` 会丢掉退场动画）。
- **键盘归属**：弹窗打开期间 `Enter` / `Escape` 归它，不落到背后的页面（composer 会吞 Enter）。Escape 走 `onClose`。
- **焦点**：打开时把焦点移入弹窗（第一个可聚焦元素，否则弹窗本身）；卸载时归还给打开前的元素。
- **`label` 必填**：作为 `role="dialog"` 的可访问名称。

AGENTS.md 里关于模态必须独占键盘的那条规则，是这条契约的散文版；两者冲突时以本节为准，因为这里是实现事实。

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
- **不要写固定 `mask` 羽化。** 内容装得下时固定 mask 会把首行和末行也淡化，那是错的。正确做法是由组件按实时滚动位置设 `data-scrolled-top` / `data-scrolled-bottom`，CSS 只对被遮住的一侧加渐变。
- 参照实现：`.gui-shortcuts-grid` + `ShortcutsDialog` 的 `measure()`。
- **不要用 `gap-N` 之类的 Tailwind 工具类表达栏间距。** 生成产物 `tailwind.out.css` 是 content-scan 的，只含被扫到的工具类；任意写一个 `gap-8` 不会报错也不会生效。间距写进自有 CSS 规则。

---

## 5. 焦点与叠层

- **同层只有一个模态。** 需要第二个模态时，先关掉第一个。不要叠两个 `DialogFrame`。
- 遮罩层层级由 `DialogFrame` 的 portal 决定，本文件不新增约定。
- 浮层里的可聚焦元素必须能被 Tab 走通；不可聚焦的装饰元素标 `aria-hidden`。
- 任何 `Enter` 有歧义的场景（发送消息 / 提交表单），在浮层里显式声明归属，不要指望浏览器默认。

---

## 6. 新增弹窗的检查清单

写完一个浮层，逐条核对：

- [ ] 用 `DialogFrame`，无条件挂载，用 `open` 驱动
- [ ] 传了 `label`
- [ ] 尺寸取自第 2 节的四档之一；修饰类写成 `.gui-dialog.<名>`
- [ ] 修饰类所在文件的 `@import` 顺序已确认（`gui-composer.css` 之前 = 必须复合选择器）
- [ ] 可滚动的话：滚动容器加了 `min-height: 0` + `flex`，羽化按滚动位置开关
- [ ] 没有依赖未在生成产物里的 Tailwind 工具类
- [ ] 内容量 > 组内间距
- [ ] Escape 关闭、焦点入栈、关闭后归还
- [ ] `bun run --cwd=packages/desktop-app check` 与该包的测试通过

---

## 7. 与其他文档的关系

- `docs/gui-design.md` §5e / §5u 是设计意图；本文件是执行细则。冲突时以本文件为准，因为这里记录的是当前实现的实际约束。
- `docs/gui-implementation.md` §8 是 UI 改动的验证流程，配套使用。
