---
name: musepi-gui-visual-probe
description: 用真实样式表渲染 MusePi GUI 组件并返回截图与结构化测量，验证布局、层级与交互态；改动 GUI 组件、修样式回归、或需要视觉证据时使用。
---

# MusePi GUI 视觉验证

把"改完看一眼"变成可复跑的证据：**真实样式表 + 真实组件 + 结构化测量 + 截图**，一次运行同时回答"长什么样"和"为什么是这样"。

工具在 `apps/desktop/scripts/gui-probe.ts`；示例场景在 `apps/desktop/scripts/gui-probe-scenarios/`。

## 什么时候用

- 改了 `apps/desktop/src/components/` 或 `packages/client-core/src/components/` 的组件
- 改了 `apps/desktop/src/styles/gui-*.css` 或 `packages/client-core/src/styles/`
- 用户报"视觉层级乱""动效不对""控件重复"
- 提交 GUI 改动前需要证据，而测试只断言 DOM 结构

不要在只改文案或纯逻辑时用：它启动一次 Chromium，比跑单测慢。

## 用法

```bash
# 跑一个场景文件，亮暗两套主题
rtk bun apps/desktop/scripts/gui-probe.ts apps/desktop/scripts/gui-probe-scenarios/connection-locations.tsx

# 单主题、改宽度、只输出 JSON
rtk bun apps/desktop/scripts/gui-probe.ts <scene.tsx> --theme dark --width 560 --json

# 失败时保留临时目录排查
MUSEPI_GUI_PROBE_KEEP=1 rtk bun apps/desktop/scripts/gui-probe.ts <scene.tsx>
```

输出每个主题一张 PNG（默认 `.tmp/gui-probe/`）加一段测量 JSON，失败项以 `✗` 标出并以非零码退出。

## 写一个场景

场景文件默认导出一个以名字为键的对象，每个值三项：

```tsx
import { t } from "@musepi/client-core";
import { MyPanel } from "../../src/components/MyPanel";
import { clickText, measure, mount, readBox } from "../gui-probe-helpers";

export default {
	"my-panel": {
		capture: ".my-panel",          // 截图裁到哪个元素；省略则整页
		async render(root) {
			await mount(<MyPanel />, root);
			await clickText(root, "button", "展开");
		},
		async measure(body) {
			return {
				// elements 是断言的作用域：expect 里的键必须在这里出现
				elements: measure(body, { panel: ".my-panel", firstRow: ".my-row" }),
				rowCount: body.querySelectorAll(".my-row").length,
			};
		},
		expect: {
			// 精确值
			firstRow: { display: "flex", cursor: "pointer" },
			// 区间：布局缺陷是越界，钉死像素会因文案改动误报
			panel: { "box.h": { max: 460 } },
		},
	},
} satisfies Record<string, GuiScenario>;
```

`measure()` 拿到的 `body` 是**整个文档**——`DialogFrame` 的弹窗 portal 到 `document.body`，查挂载容器会什么都找不到。

## 交互态怎么验

`gui-probe-helpers` 提供 `focusAndRead(node)`，读 `:focus-visible` 的实际 outline。悬停与按下需要节点在页面上，可在 `render()` 里直接 `node.focus()` 后测量，或在 `measure()` 里读 `getComputedStyle` 的 `transition` 确认过渡存在。

契约是 **hover 加 `:focus-visible`**（不用 `:focus-within`），见 `docs/gui-design.md`。

## 已踩过的坑（工具内部已处理，不要再自己绕）

| 坑 | 现象 | 原因 |
| --- | --- | --- |
| `file://` 下 module 脚本不执行 | 无报错、无 console、阶段标记全空 | Chromium 静默拒绝；必须走 loopback HTTP |
| 内联 module 不执行 | 同上 | 紧挨 1.4MB 内联样式表时不可靠；boot 脚本必须是独立文件 |
| `window` 上的值读不到 | 树已渲染但 `evaluate` 得到 undefined | 模块作用域与 evaluate 观察的全局对象未必同一个；结果改走 DOM `dataset` |
| `bun build` 的 CSS 不可用 | 圆角 0px、表单无宽度 | bundle 只带部分样式；必须按应用顺序拼接真实样式表 |
| 主题设了没用 | 截图仍是另一主题 | 应用挂载时会覆写 `data-theme`；需在场景稳定后重设 |
| 标题白底白字 | 看着像样式坏了 | 裸页面 `html` 不继承颜色 |
| favicon 404 报失败 | 每次都有无关失败项 | 浏览器在问一个这页永远不回答的问题；工具已过滤 |

## 断言尺度

- **用区间断高度、宽度**，不要钉死像素：文案换行会改变盒子。
- **断言"存在唯一"用计数**（`querySelectorAll(...).length`），不要靠 `expect(node).toBeNull()`——渲染树序列化会让失败耗时到像超时，仓库有 `scripts/check-dom-assertions.ts` 专门拦这个。
- **每个断言对应一个真实缺陷**，不要为了覆盖率堆属性。写注释说明"这条防的是什么"。

## 收尾

- 截图与测量是过程证据，默认写到 `.tmp/`，**不要提交**。
- 需要长期保留的场景放 `apps/desktop/scripts/gui-probe-scenarios/`，它和组件一起演进。
- 只用一次的场景放 `.tmp/`，用完删掉。
