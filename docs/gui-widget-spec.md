# 小组件卡片规格

> 状态：2026-10-04 定稿。本文是 `packages/client-core/src/widgets/` 的现行规范。
> 架构立项见 `docs/archive/board-dashboard.md`（已归档，只作背景），渲染规范的前身见 `docs/archive/widget-design-system.md`（已归档）。**两份归档文档都不再是现行标准** —— 它们记录的是立项与初版设计意图，本文记录的是当前实现的实际契约。
> 适用范围：看板卡片（Board）与消息内联 widget 共用的 registry 组件层。

---

## 1. 栅格：卡片尺寸是算出来的，不是随手写的

看板是自由布局，但落点必须落在栅格上。全部常量在 `packages/desktop-app/src/lib/board-model.ts`，**组件不得自己定义尺寸常量**。

| 常量     | 值                           | 含义                                     |
| -------- | ---------------------------- | ---------------------------------------- |
| `SNAP`   | `8`                          | 吸附步长                                 |
| `BASE_W` | `1092`                       | 看板基准宽（13 × `SNAP_W` + 12 × `GAP`） |
| `SNAP_W` | `92`                         | 单列宽                                   |
| `SNAP_H` | `44`                         | 单行高                                   |
| `GAP`    | `12`                         | 卡片间距                                 |
| `MIN_W`  | `2 * SNAP_W - GAP` = `172`   | 最窄卡片                                 |
| `MIN_H`  | `2 * SNAP_H - GAP` = `76`    | 最矮卡片                                 |
| `MAX_H`  | `33 * SNAP_H - GAP` = `1440` | 最高卡片                                 |

**`MIN_W = 2 * SNAP_W - GAP` 不是 `2 * SNAP_W`。** 占 2 列的卡片实际宽度是 `2 × 92 − 12`，因为相邻两列之间要扣掉一个 `GAP`。写成 `2 * SNAP_W` 会让最小宽度比实际可容纳宽度大 12px，导致窄内容卡片出现横向裁切。

新增卡片组件时的取值约束：

- 内容能读的最小宽度是 `MIN_W`。放不下就换布局，不要突破下限。
- 内容纵向滚动时给 `max-height`，不要给 `height` —— 高度留给内容撑开。
- 需要内边距时用 `padding`，**不要用 `gap` 表达卡片与卡片的间距**（那个归 `board-model` 的布局层）。

---

## 2. 注册：一个 widget 必须同时出现在三处

`WidgetDef`（`packages/client-core/src/widgets/registry.ts`）的字段是契约，不是可选装饰：

| 字段                  | 必填 | 契约                                                                                       |
| --------------------- | ---- | ------------------------------------------------------------------------------------------ |
| `type`                | ✅   | 稳定标识。daemon 侧 `WIDGET_TYPES` 与它一一对应                                            |
| `nameKey` / `descKey` | ✅   | i18n key，**不是字面文案**。加 widget 必须同步 en-US 域文件                                |
| `fields`              | ✅   | 数据字段声明。形状必须与 daemon 侧一致                                                     |
| `defaults()`          | ✅   | 返回 `Record<string, unknown>`。**必须是函数**，不能是常量 —— 调用方不应拿到可变的共享对象 |
| `tone`                | —    | `default` / `dark` / `light` / `blue`。看板允许深浅混排，不要强制统一表面                  |
| `Component`           | ✅   | 纯展示 + `update(patch)`。**不发网络请求、不读全局状态**                                   |

### 2.1 `sendPrompt` 是可选能力，不是必备

`Component` 可以带 `sendPrompt(text)`：把用户意图推回会话。内联 chat widget 用它把结果交回 agent；看板没有会话，就不传，**组件要在 `sendPrompt` 缺失时隐藏发送入口** —— 不是留一个点了没反应的按钮。

### 2.2 parity 测试是三处同步的唯一保证

`packages/client-core/test/widget-parity.test.ts` 断言四件事：

1. registry 里的每个 `type` 都存在于 daemon 的 `WIDGET_TYPES` 表
2. `defaults()` 逐 type 相等
3. `tone` 逐 type 相等
4. `fields` 逐 type 相等

**只在 `registry.ts` 加条目而不改 daemon 表，parity 测试会失败** —— 这是故意的。新增 widget 的正确顺序是：daemon `WIDGET_TYPES` 与 defaults → registry 条目 → i18n 词表 → parity 测试转绿。

---

## 3. 源文本是一处契约

独立展示的卡片（聊天内联与右栏「组件预览」共用 `WidgetCard`）在卡片头右侧有「⋯」菜单：

| 菜单项             | 行为                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| 下载到本地         | 写**源**文件：`html` 型 → `<slug>.html`（可独立打开），其余 → `<slug>.json` |
| 下载为图片         | 光栅化为 `<slug>.png`，`pixelRatio: 2`                                      |
| 复制代码           | 复制同一份源；菜单项翻成「已复制」，1.2s 后自动收起                         |
| 查看代码 / 显示 UI | **卡片头不动**，卡片体在渲染结果与源文本之间切换                            |

**「源」的定义只有一处**：`widgets/source.ts` 的 `widgetSource`。`html` 型给生成面自己的标记，其余型给 `{ type, title?, data }` 的 JSON —— 即 `widget` 工具被调用时的载荷，粘回对话就能让 agent 改这张卡。查看器、剪贴板、下载全部读这一份，所以三者不会漂移。**新增输出方式时读 `widgetSource`，不要自己再拼一份。**

### 3.1 能力门：不渲染，而不是点了没反应

`ToolRenderHost.saveImage` 只有带光栅器的宿主提供（桌面端复用 html-to-image 管线）。纯浏览器与 HTML 导出宿主不提供 —— 此时「下载为图片」**不渲染菜单项**。文本下载走共享 `lib/download.ts` 的 `downloadBlob`（blob + `<a download>`），所有宿主都有。

---

## 4. 视觉规则（从归档设计系统提炼的现行部分）

以下规则**在 widget 内部生效**，与主界面的 accent 交互惯例不同 —— 卡片不是按钮集合。

### 4.1 黑白优先，灰管层级

- 交互强调用 `--color-text` + 灰 tint。**不用 accent 蓝当"可交互"标记**。
- 灰阶层级：`--color-text` → `--color-text-muted` → `--color-text-faint`。
- `--color-accent` **仅用于**数据可视化与语义强调：状态（`--color-danger` / `--color-ok` / `--color-warning`）、优先级点、图表序列、tag、类别 chip、进度填充、头像。

### 4.2 不设默认背景

widget 保持 `transparent` / `inherit`，宿主背景透出。禁止装饰性底填、渐变光球、bokeh、重阴影、玻璃拟态。表面靠细边框与留白分开，不是靠底色。

### 4.3 accent 用 tint，不用实色

状态背景走 10–25% tint：

```css
background: color-mix(in srgb, var(--color-danger) 12%, transparent);
```

**禁实色填充作主导**；禁彩色渐变（确需层次时用单色相透明度阶梯）。

### 4.4 图表色

- sequential 默认 → categorical 例外 → diverging 最后
- categorical 顺序 `--chart-1` → `--chart-5`，最多 5 色，超出用线型区分
- 可比序列用同色相透明度阶梯（100 / 70 / 50 / 40 / 25%）
- 正负对比：蓝 vs 红；中点多色散：红 ↔ 中性 ↔ 蓝
- 基准线、网格、无数据用 quaternary 灰
- **色盲安全：绿与红禁同图**。灰度必须可辨，不单靠颜色 —— 加标签或线型

### 4.5 排版

- 16px 基准（行高 24px）；标题 17–20px / 500；次级 14–15px；元数据 12px；主显示值 28–42px（≤48px）字重 500
- **仅两个字重 400 / 500** —— 禁 600 / 700，对宿主显重
- **数字一律 `font-variant-numeric: tabular-nums`**，禁换成 mono 字体。mono 仅用于代码 / hash / 日志 / 原始标识符，且小号次级
- 禁硬编码字体栈，全部走变量；`letter-spacing >= 0`
- sentence case，禁 Title Case 与全大写；句中禁加粗，实体 / 类名 / 函数名用 code 样式
- 图标用图标库（oc-icons / lucide）以 `currentColor` 着色，**禁 emoji 当 UI 图标**，最大 24px

### 4.6 间距与圆角

- 间距阶梯 **4 / 8 / 12 / 16 / 20 / 24 / 32** —— 禁 7px、13px 这类意外值；需要中间感时取小的那档
- 圆角阶梯 **4 / 6 / 8 / 10 / 12 / full**：6px chips、8px 图标钮、10px 列表卡与输入、12px 浮层、full 药丸与头像
- **嵌套圆角内层小于外层**：`inner = outer − padding`

### 4.7 控件中性化

原生控件（slider / switch / checkbox / radio / progress）设 `accent-color: var(--color-text)` 或灰 —— **不用浏览器默认蓝**，除非控件本身就是语义选择器。

破坏性与次级行操作 hover 显现，用 `opacity` / `visibility` 过渡而非 `display: none`（布局不跳、键盘可达）。唯一的例外：单一直白的破坏性主操作（如确认框的 Delete）可以常显。

### 4.8 动画

只用 CSS transition 或原生 JS，**无运行时动画库**。时长 60–300ms 且必须有目的，禁无意义循环。标准值：高度形变 240ms `cubic-bezier(0.22, 1, 0.36, 1)`，淡入 160ms ease-out。

### 4.9 无外部依赖

registry 组件只能用本项目的 token 与组件：**不 fetch、不引 CDN、不引 npm 包**。卡片在离线的看板快照里也要能渲染。

---

## 5. 新增 widget 的检查清单

- [ ] daemon `WIDGET_TYPES` 与 defaults 已加
- [ ] `registry.ts` 加了 `WidgetDef` 条目：`type` / `nameKey` / `descKey` / `fields` / `defaults()` / `Component`
- [ ] `defaults()` 是函数，返回新对象
- [ ] `sendPrompt` 缺失时发送入口隐藏
- [ ] i18n 的 zh-CN 与 en-US 域文件都加了 key（en 侧必须 `satisfies Record<ZhKey, string>`）
- [ ] `widget-parity.test.ts` 转绿
- [ ] 尺寸取自第 1 节常量，未自行定义
- [ ] 内容在 `MIN_W` 下可读
- [ ] 遵守第 4 节：token 化、tabular-nums、两字重、阶梯间距圆角、控件中性化、无 emoji 图标、无外部依赖
- [ ] 卡片菜单读 `widgetSource`，未另拼一份
- [ ] `bun test packages/client-core` 与该包 `check` 通过

---

## 6. 与其他文档的关系

- `docs/gui-dialog-spec.md` —— 卡片头「⋯」菜单是浮层，尺寸、portal、Escape 归属按那篇。
- `docs/gui-design.md` —— 主界面设计规范。**第 4 节的 accent 规则与主界面相反且是有意的**：主界面用 accent 标可交互，widget 内部不用。
