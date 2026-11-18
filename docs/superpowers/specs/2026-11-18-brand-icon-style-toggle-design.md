# 设计：全局品牌图标「Mono / 彩色」切换

日期：2026-11-18
状态：待批准

## 意图与原因

`@lobehub/icons` 为每个品牌提供两类视觉：默认（Mono，跟随 `currentColor`，适配明暗主题）与 `.Color`（品牌主色）。此前导入面板与模型选择器统一写死 Mono。用户发现依赖其实提供彩色变体，希望有一个全局开关由自己决定用哪种——切到彩色时，WorkBuddy（绿 `#01C886`）与 CodeBuddy（紫 `#6c4dff`）这类同形品牌才分得开。

## 目标

- 用户在设置里切换「品牌图标：跟随主题色 / 品牌彩色」，开关影响导入面板与模型选择器两处
- 默认保持 Mono，不改变现状
- 切换后立即生效，无需重启
- 某个品牌缺少彩色变体时，自动回退到 Mono，绝不出现空图标

## 非目标

- 不新增或替换品牌资产，全部用 `@lobehub/icons` 提供的内容
- 不改 daemon / RPC / 会话数据；这是纯 GUI 偏好
- 不做「按主题自动选」，开关由用户显式控制

## 约束与已查明的事实

- 6.16 的 `import Brand from "@lobehub/icons/es/<Brand>"` 默认组件就是 Mono；compound 的 `.Color` 才是彩色变体（compound 没有 `.Mono`）
- 62 个用到的品牌 dir 与 Mono 组件都齐全；但**彩色变体并非人人都有**：实测 OpenCode、Grok、Pi、OpenAI、Anthropic、Moonshot、Stepfun、XiaomiMiMo 等没有 `.Color`，WorkBuddy 没有顶层具名导出（要走深导入）
- 导入面板的映射在 `ImportSessionsSetup.tsx`（9 个来源，其中 omp/pi 共用 Pi）；模型图标映射在 `model-brand-icon.tsx`（约 60 个 provider）
- 现有同类先例：`musepi-gui-avatars`（localStorage）由 `SettingsView` 持有状态，传给 appearance 设置区的 toggle

## 方案（选定的）

1. 新增偏好键 `musepi-gui-brand-icons`，取值 `mono`（默认）或 `color`。沿用头像开关的轻量模式：localStorage 写入 + 一个 `musepi-gui-brand-icons-changed` CustomEvent 通知。
2. 新增共享 hook `useBrandIconStyle(): "mono" | "color"`，读 localStorage 并订阅 change 事件；再导出一个纯函数 `brandIconStyle()` 供非 React 的映射逻辑读取。
3. 改 `model-brand-icon.tsx`：映射表从「组件」升级为「{ mono, color? } 一对」，渲染时按当前偏好选；`color` 缺失就用 `mono`。为拿到 `.Color`，把现有 60 个深导入改为从顶层具名导入（`import { Claude, … } from "@lobehub/icons"`），WorkBuddy 这类顶层没有的用深导入补齐。保留 provider 的确切匹配与 model-id 回退规则。
4. 改 `ImportSessionsSetup.tsx`：来源映射同样升级为一对组件，`SourceGlyph` 按偏好选变体；workbuddy 用深导入取 `.Color`。
5. 在 appearance 设置区加一个 toggle「品牌图标使用彩色」，与「显示头像」并列；文案进中英 i18n。

### 为什么不用 CSS 滤镜把 Mono 染成彩色

品牌主色各不相同（绿、紫、蓝……），单一滤镜无法还原；逐个硬编码色值等于自己维护一套品牌资产，违背「用依赖提供的图标」这个前提。

### 为什么不在每个组件各自读 localStorage

两处共 4+ 个渲染点，各读一次会在切换后不同步。共享 hook + change 事件能让所有实例一起更新，且与头像开关的模式一致。

## 风险与回退

- **彩色缺失**：已实测并设计回退到 Mono；每个映射项在测试里验证「两种变体至少有一个可渲染」
- **顶层导出覆盖**：WorkBuddy 无顶层导出，用深导入；其余已实测有顶层导出
- **包体**：从深导入改为顶层具名导入可能影响 tree-shaking。缓解：只导入实际用到的具名符号，构建后核对 bundle 体积无明显增长

## 验收

- 默认 Mono：10 个来源与模型图标全部 `fill=currentColor`
- 切到 Color：有 `.Color` 的品牌渲染出品牌主色，无 `.Color` 的仍为 Mono，无空图标
- 切换后已打开的导入面板与模型菜单即时更新
- `bun run check` / 相关测试通过
