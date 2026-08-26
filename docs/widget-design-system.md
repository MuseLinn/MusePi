# Widget 设计系统（看板组件 + 消息内联 widget）

> **状态（2026-08-25 核对）**：registry 组件层已实现（18 种 widget，parity 测试 `desktop-web/test/widget-parity.test.ts`）；
> iframe 沙箱层部分（html widget opaque-origin sandbox + postMessage bridge 存在，缺 token CSS 预加载与沙箱 sendPrompt）；
> 完整核对见 `docs/board-dashboard.md` 状态行。
>
> 2026-08-07 建立。来源：kimi 官方 widget 设计系统（`~/Downloads/kimi-widget-skill/`，
> 用户从 kimi 对话中取得）提炼 + 映射到 MusePi GUI token。适用范围：**白名单 registry 组件**
> （看板卡 + transcript 内联卡）与 **iframe 沙箱组件**（M4 备选升级）共用——设计系统是
> 两层的共享约束层。board-dashboard.md 是架构立项；本文件是渲染规范。

## 1. 运行时形态

- **registry 组件**（首选）：TSX 组件编译进 GUI，经 `WidgetRegistry` 渲染；agent 通过
  `widget.render {type, data}` 工具按 schema 填数据。组件内只用本设计系统的 token。
- **iframe 沙箱组件**（备选）：单 HTML 自包含文件 + postMessage bridge；宿主注入
  **widget 设计系统 CSS**（token 预加载，kimi 模式）——组件代码零外部依赖（无
  fetch/WebSocket/CDN/npm），所有 CSS 变量运行时可用。
- **通信**：交互 widget 可把用户意图推回会话（kimi `window.sendPrompt` 等价物）——
  registry 组件经回调 → daemon → 会话 steer；沙箱组件经 bridge 的 `sendPrompt`。
- **流式友好**：内容早出（style 短 + 静态 HTML 先行 + 数据内联 + `<script>` 最后）；
  控件用 inline style（流式渲染中 <style> 块延迟生效）；禁注释（浪费 token）；SVG 的
  `<defs>` 前置、实色填充（渐变/阴影在流式 DOM diff 中闪烁）。

## 2. Token 映射表（kimi → MusePi）

| kimi token | MusePi 等价 | 用途 |
|---|---|---|
| `--kimi-color-text-primary` | `--color-text` | 主文本、关键值、激活态、主按钮 |
| `--kimi-color-text-secondary/tertiary/quaternary` | `--color-text-muted/faint` | 灰阶层级、分隔、禁用 |
| `--kimi-color-surface/surface-muted/surface-raised/surface-strong` | `--color-surface/surface-raised/surface-sunken` | 表面 |
| `--kimi-color-border` | `--border` | 结构 |
| `--kimi-color-danger/positive/warning` | `--color-danger/ok/warning` | 状态色 |
| `--kimi-color-accent` | `--color-accent` | **仅数据可视化/语义强调** |
| `--kimi-chart-1…5` | `--chart-1…5` | 图表序列（蓝/红/绿/紫/灰） |
| `--t-micro/fast/normal/slow`、`--ease-*` | 动效规范 §3（240ms/160ms 曲线） | 时长/缓动 |
| `--kimi-font-sans/mono` | 现有字体栈（Maple Mono NF CN 等） | 字体 |

## 3. 设计原则

- **黑白优先，灰为层级**：交互强调用 `--color-text` + 灰 tint，**不用 accent 蓝当"可交互"
  标记**（kimi 训练数据关联蓝色=交互，其产品刻意规避——我们 GUI 主界面沿用现有 accent
  交互惯例，但 **widget 内部**遵循此规则：accent 只用于数据可视化/状态）。
- **不设默认背景**：widget 保持 transparent/inherit，宿主背景透出；禁止装饰性底填、
  渐变光球、bokeh、重阴影、玻璃拟态——表面干净/扁平，细边框（0.5–1px 分隔、6px chips、
  8px 图标钮、10px 列表卡、12px 浮层面板）。
- **accent 仅多色语义**：状态（danger/ok/warning）、优先级点、图表序列、tag、类别 chip、
  进度填充、头像——背景用 token 10–25% tint（`color-mix(in srgb, var(--color-danger) 12%, transparent)`），
  禁实色填充作主导；禁彩色渐变（如必须，单色相透明度阶梯）。
- **图表色规则**：sequential 默认、categorical 例外、diverging 最后；categorical 顺序
  `--chart-1→5`（最多 5 色，超出用线型区分）；可比序列用同色相透明度阶梯（100/70/50/40/25%）
  ；正负对比：蓝 vs 红；中点多色散：红↔中性↔蓝；基准线/网格/无数据用 quaternary；
  **色盲安全：绿红禁同图**（`--chart-3` 与 `--chart-2`、positive 与 danger），灰度可辨，
  不单靠颜色（加标签/线型）。

## 4. 排版

- 16px 基准（t2，行高 24px）；标题 17–20px/500；次级 14–15px；元数据 12px；主显示值
  28–42px（≤48px）字重 500 行高 ≥1.08。
- **仅两个字重**：400/500——禁 600/700（对宿主显重）。
- 数字显示（计时器/价格/计数/百分比/日期/滑杆值）：`font-variant-numeric: tabular-nums`
  ——**禁换 mono**；mono 仅代码/hash/日志/原始标识符，且小号次级。
- 禁硬编码字体栈（全部走变量）；letter-spacing ≥ 0；sentence case（禁 Title Case/全大写）；
  句中禁加粗（实体/类名/函数名用 code 样式）。
- 图标：用现有图标库（oc-icons/lucide）`currentColor` 着色；**禁 emoji 当 UI 图标**；
  24px 最大图标尺寸（大装饰位用排版/布局解决，不用大图标）。

## 5. 间距 / 圆角 / 控件

- **间距阶梯 4/8/12/16/20/24/32**——禁 7px/13px 等"意外值"；两档之间取小。
- **圆角阶梯 4/6/8/10/12/16/full**：6px chips、8px 图标钮、10px 列表卡/输入、12px 浮层、
  full 药丸/头像。
- **嵌套圆角**：内层 < 外层，`inner = outer − padding`（12px 面板 + 8px padding 内放
  4px-radius 子件）；同心圆角（两曲线共享圆心）。
- **控件中性化**：原生控件（slider/switch/checkbox/radio/progress）`accent-color:
  var(--color-text)` 或灰——**不用浏览器默认蓝/accent 蓝**（除非控件本身是语义选择器）。
- **破坏性/次级行操作 hover 显现**（`opacity/visibility` 过渡而非 display:none——
  布局不跳、键盘可达）；单一直白的破坏性主操作（如确认框 Delete）可常显。

## 6. 动画

- 只用 CSS transition/原生 JS；无 Motion/GSAP/React 运行时（registry 组件本身在 React 内，
  指组件内部动画）；动效有目的、短（60–300ms）、禁无意义循环；时长/缓动走动效规范
  （240ms `cubic-bezier(0.22,1,0.36,1)` 高度形变、160ms 淡入、ease-out/in/standard 等价）。

## 7. 应用 checklist

1. 保持宿主背景（不设默认底）。
2. 主 UI 色黑白优先；交互强调用 text-primary + 灰，不用 accent 蓝。
3. 灰管层级；accent 仅多状态/多类别必要区分（状态/优先级/chart 序列/tag），背景 10–25% tint。
4. 字体全走 token（sans/mono），数字 tabular-nums。
5. 间距/圆角全部落阶梯；嵌套圆角外大内小。
6. 验证无 accent 变成底填/主导主题色。
7. 无外部依赖（registry 组件：仅本项目 token/组件；沙箱组件：单文件自包含）。

## 8. 参考文件

- kimi 官方：`~/Downloads/kimi-widget-skill/`（SKILL.md + references/design-system.md +
  references/icon-system.md + assets/icons/ 105 图标）
- kimi 运行时机制（用户对话确认）：沙箱 iframe + 预加载设计系统 + 内联自包含内容；
  `window.sendPrompt(text)` 推回意图
- bitfun：`src/web-ui/src/tools/bitfun-canvas/`（data-display/charts/hooks SDK）
- musepi：`docs/board-dashboard.md`（架构立项）、`docs/gui-design.md`（主设计规范）
