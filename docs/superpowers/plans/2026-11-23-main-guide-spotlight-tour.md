# 主界面 Spotlight 导览实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 MusePi 主界面加一层「灯打在真实控件上、可以当场点」的分步导览，桌面端与 `client-core` 三端共用一份引擎，各自提供步骤表。

**Architecture:** 引擎落在 `packages/client-core/src/components/guide/`（纯函数测量 + 定位、焦点白名单、图层组件、触发 hook），通过 `packages/client-core/src/index.ts` 导出；`apps/desktop` 与 `client-core` 的 `app.tsx` 各自只加 `data-guide` 锚点、步骤表和一处挂载。焦点接现有 `lib/modal-focus.ts`，返回键接 `lib/back-stack.ts`，位置过渡只用 `--ease-one-take`。

**Tech Stack:** TypeScript、React 19（`react` 原生 `createElement` 风格与 JSX 混用，跟随既有文件）、Bun 测试 + `@happy-dom/global-registrator`、Biome。

**Spec:** `docs/superpowers/specs/2026-11-23-main-guide-spotlight-tour-design.md`

## Global Constraints

- 引擎代码只在 `packages/client-core/src/components/guide/`，桌面端**不复制**任何引擎逻辑。
- 位置过渡只用 `--ease-one-take` + `--duration-one-take`（280ms）；**禁止** `--spring-*` 作用于 `left/top/width/height`。退场用 `--ease-dismiss` 160ms、图层保持挂载到 180ms。
- 动效关闭：`gui-motion-off` 或 `prefers-reduced-motion: reduce` 时全部过渡为 0ms，直接到终态。
- 层级：图层 `z-index: 200`，卡片 `210`。不新建 z-index 档。
- 锚点属性固定为 `data-guide="<id>"`；不改既有 class 命名，不用 class 选择器定位目标。
- 已看过标记键：`musepi-gui-main-guide-done`，值为 `"1"`。
- 文案只从 `packages/client/locale/src/client/{zh-CN,en-US}/guide.ts` 取；中英键集合必须一致（`en-US` 用 `satisfies Record<GuideKey, string>`）。
- 浮层**不进** `modalStack`；只享受「不被 `inert`」与「Tab 可循环」。
- 桌面宿主元素：`.gui-shell`；`client-core` 宿主元素：`.sh-app`。
- 命令：`packages/client-core` 用 `bun test <file>`、`bun run check`；`apps/desktop` 用 `bun test --isolate --timeout=15000 <file>`、`bun run check`。
- 不出现注释解释「改了什么」，只写不显然的约束与不变式（仓库 AGENTS.md 规则）。

## Review Focus

| # | 输入/条件 | 用户会预期的行为 | 归属任务 |
|---|---|---|---|
| 1 | 用户在高亮区里点开了模型选择器等 portal 浮层 | 浮层可点、可打字，不被遮罩封住 | Task 3、Task 4 |
| 2 | 浮层打开时按 Esc | 只关浮层，导览不消失 | Task 4 |
| 3 | 用户点了高亮控件，目标在 DOM 里消失（点设置、点面板入口） | 导览暂停、卡片还在，回去后自动恢复到同一步，而不是被判定为看完 | Task 5 |
| 4 | 导览中窗口在 wide↔compact 之间缩放 | 重新测量、停在同一逻辑步，不闪退 | Task 5、Task 6 |
| 5 | 步骤锚点被新代码改名/删除 | 构建期测试失败，而不是线上静默少一步 | Task 9、Task 10 |

---

## File Structure

**新建**

| 文件 | 职责 |
|---|---|
| `packages/client-core/src/components/guide/spotlight.ts` | `PAD`、`measureSpotlight`、`placeCard`（纯函数） |
| `packages/client-core/src/components/guide/spotlight.test.ts` | 上述纯函数测试 |
| `packages/client-core/src/components/guide/popup-ownership.ts` | `registerPopupOwner` / `ownedPopups` |
| `packages/client-core/src/components/guide/guide-gate.ts` | `holdGuideGate` / `subscribeGuideGate` / `isGuideGateOpen` |
| `packages/client-core/src/components/guide/types.ts` | `GuideStep`、`GuideSpec` |
| `packages/client-core/src/components/guide/focus-scope.ts` | `useGuideFocusScope`（inert 白名单 + Tab 循环 + Esc + 模态栈） |
| `packages/client-core/src/components/guide/focus-scope.test.ts` | 焦点契约测试 |
| `packages/client-core/src/components/guide/GuideOverlay.tsx` | 图层、遮罩（clip-path 挖洞）、高亮框、卡片 |
| `packages/client-core/src/components/guide/guide.css` | 图层样式 |
| `packages/client-core/src/components/guide/useSpotlightGuide.ts` | 触发判定 + 步骤状态机 + 暂停/恢复 |
| `packages/client-core/src/components/guide/use-spotlight-guide.test.tsx` | hook 状态机测试 |
| `packages/client-core/src/components/guide/index.ts` | 导出 |
| `packages/client-core/src/components/guide/steps.ts` | 移动/网页步骤表 |
| `packages/client-core/src/components/guide/anchors.test.ts` | 两张步骤表的锚点完整性（Task 9 建，Task 10 扩） |
| `apps/desktop/src/lib/main-guide.ts` | 桌面触发 hook 包装（gate + onboarding 衔接 + 标记） |
| `apps/desktop/src/components/main-guide-steps.ts` | 桌面步骤表 |
| `packages/client/locale/src/client/zh-CN/guide.ts` / `en-US/guide.ts` | 文案 |

**修改**

| 文件 | 改动 |
|---|---|
| `packages/client-core/src/index.ts` | 导出 guide 公开面 |
| `packages/client-core/src/lib/modal-focus.ts` | 新增 `pushModalLayer` / `popModalLayer`，`useModalFocus` 改用它们 |
| `packages/client-core/src/app.tsx` | 挂载导览 + `sh-app` 根 DOM 加锚点 |
| `packages/client-core/src/components/shell/HeaderBar.tsx` | `data-guide` 锚点 + `data-guide` 透传到根 |
| `packages/client-core/src/components/shell/Composer.tsx` | `data-guide` 锚点 |
| `packages/client-core/src/components/shell/MobileTabBar.tsx` | `data-guide` 锚点 |
| `packages/client-core/src/components/shell/MobileSettings.tsx` | 重播入口 |
| `packages/client/locale/src/client/zh-CN/index.ts`、`en-US/index.ts` | 注册 `guide` 域 |
| `apps/desktop/src/components/OnboardingOverlay.tsx`、`AnnouncementOverlay.tsx` | `holdGuideGate()` + 接 gate |
| `apps/desktop/src/components/ChatView.tsx` | 挂载桌面导览 + 锚点 |
| `apps/desktop/src/components/GuiHeader.tsx`、`AppRail`/`RightRail`、`SessionList`、`HeroComposer` | `data-guide` 锚点 |
| `apps/desktop/src/components/GettingStartedCard.tsx` | 受导览活跃状态收起 |
| `apps/desktop/src/components/SettingsNav.tsx` | 「界面导览」重播入口 |

**任务分组**

- **Phase A｜引擎（client-core）**：Task 1–6，全程只动 `packages/client-core/src/components/guide/`、`lib/modal-focus.ts`、`src/index.ts` 与 locale 文案，不接任何 Surface。
- **Phase B｜移动/网页接入（client-core）**：Task 6–7。
- **Phase C｜桌面接入（apps/desktop）**：Task 8–11。
- **Phase D｜收尾**：Task 12。

每完成一个 Phase 跑一次该包的 `bun run check`。

---

## Phase A｜引擎

### Task 1: 测量与卡片定位（纯函数）

**Files:**
- Create: `packages/client-core/src/components/guide/spotlight.ts`
- Test: `packages/client-core/src/components/guide/spotlight.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `interface SpotRect { left: number; top: number; width: number; height: number }`
  - `interface HostSize { width: number; height: number }`
  - `findGuideTarget(host: HTMLElement, targetId: string): HTMLElement | null`
  - `measureSpotlight(host: HTMLElement, targetId: string): SpotRect | null`
  - `placeCard(rect: SpotRect | null, card: HostSize, host: HostSize): Pick<CSSProperties, "left" \| "right" \| "top" \| "bottom">`
  - `export const GUIDE_PAD = 6`、`GUIDE_EDGE = 16`、`GUIDE_GAP = 14`、`GUIDE_NARROW = 640`

- [ ] **Step 1: 写失败测试**

```ts
// packages/client-core/src/components/guide/spotlight.test.ts
import { afterAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { measureSpotlight, placeCard } from "./spotlight";

GlobalRegistrator.register();
afterAll(() => {
	void GlobalRegistrator.unregister();
});

/** 100×60 的宿主，(0,0) 起算，目标放在 (20,30)。 */
function hostWith(rect: { left: number; top: number; width: number; height: number }) {
	const host = document.createElement("div");
	host.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => rect }) as DOMRect;
	document.body.appendChild(host);
	return host;
}

function target(host: HTMLElement, id: string, box: { left: number; top: number; width: number; height: number }) {
	const el = document.createElement("button");
	el.dataset.guide = id;
	el.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => box }) as DOMRect;
	host.appendChild(el);
	return el;
}
```

断言（每个 `it` 一条）：
- 正常矩形：宿主 (0,0,800,600)、目标 (120,80,200,40) → `{ left: 114, top: 74, width: 212, height: 52 }`。
- 目标比宿主靠外：宿主 (100,50,800,600)、目标 (90,40,30,20) → left/top 被夹到宿主内 4px 边距。
- 零尺寸目标 → `null`。
- 同一 id 两处，第一个 `width === 0` → 取第二个可见者。
- 锚点在滚动容器（祖先带 `data-guide-scroll`）内时，按该容器裁剪：容器比宿主小 200px，目标贴着容器边 → 结果不超出容器。
- `placeCard` 四档：左侧窄栏（rect.left < 220）放右侧；否则下方放得下放下方；否则上方；否则左侧；都不行 → 右下角兜底 `left = host.width - card.width - 16`。
- `placeCard` 窄宿主（width ≤ 640）→ 返回 `{ left: 12, right: 12, bottom: 12 }` 或 `{ left: 12, right: 12, top: 12 }`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/client-core && bun test src/components/guide/spotlight.test.ts`
Expected: FAIL — `Cannot find module './spotlight'`

- [ ] **Step 3: 实现**

`findGuideTarget`：`host.querySelectorAll('[data-guide="'+id+'"]')`，逐个 `getBoundingClientRect()`，取第一个 `width > 0 && height > 0`；`id` 为 `""` 或找不到返回 `null`。

`measureSpotlight`：
1. 取宿主与目标矩形，任一 `width <= 0` 返回 `null`。
2. `left = t.left - h.left - GUIDE_PAD`，其余同理（`right`、`bottom` 用 `+ GUIDE_PAD`）。
3. 若 `el.closest("[data-guide-scroll]")` 存在，用它（相对宿主换算后）的四边 + 2px 夹紧；否则用宿主 4px 边距夹紧。
4. `width <= 8 || height <= 8` 返回 `null`；否则四舍五入。

`placeCard`：按 `--duration-one-take` 无关的纯几何，规则固定为——`host.width <= GUIDE_NARROW` 时返回通栏（`bottom` 放得下则贴底，否则贴顶）；否则依次判定右/下/上/左，全部用 `clamp(v, GUIDE_EDGE, max)`，最后兜底右下。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/client-core && bun test src/components/guide/spotlight.test.ts`
Expected: PASS，全部用例绿。

- [ ] **Step 5: 提交**

```bash
git add packages/client-core/src/components/guide/spotlight.ts packages/client-core/src/components/guide/spotlight.test.ts
git commit -m "feat(client-core): spotlight measurement and card placement for the main guide"
```

---

### Task 2: 浮层归属与导览闸门

**Files:**
- Create: `packages/client-core/src/components/guide/popup-ownership.ts`
- Create: `packages/client-core/src/components/guide/guide-gate.ts`
- Create: `packages/client-core/src/components/guide/types.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `registerPopupOwner(owner: RefObject<HTMLElement | null>, popup: RefObject<HTMLElement | null>): () => void`
  - `ownedPopups(roots: HTMLElement[]): HTMLElement[]`
  - `holdGuideGate(): () => void`
  - `isGuideGateOpen(): boolean`
  - `subscribeGuideGate(listener: (open: boolean) => void): () => void`
  - `interface GuideStep { target?: string; title: TranslationKey; cue: TranslationKey; fallback?: string; optional?: boolean }`
  - `interface GuideSpec { mode: string; nonce: number; steps: GuideStep[] }`

- [ ] **Step 1: 写失败测试**

`packages/client-core/src/components/guide/focus-scope.test.ts` 里先放这一组（`popup-ownership` 与 `guide-gate` 无 DOM 依赖的部分），`describe("guide gate")`：

- `holdGuideGate()` 后 `isGuideGateOpen()` 为 `false`；返回的 release 调用一次后为 `true`。
- 两次 hold、释放其中一个仍为 `false`，释放两个才为 `true`（计数语义）。
- release 幂等：调两次不会把计数压成 -1（再 release 一个无关 hold 后仍正确）。
- `subscribeGuideGate` 在状态翻转时收到 `true/false`，重复状态不回声。

`describe("ownedPopups")`：
- 目标元素 → owner，弹层 → popup，`ownedPopups([target, card])` 含 popup。
- 弹层未登记 → 不含。
- 弹层 `data-leaving` 或 `!isConnected` → 不含。
- 链式：弹层 A 由目标拥有、A 又拥有 B → 两者都含（递归）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/client-core && bun test src/components/guide/focus-scope.test.ts -t "guide gate"`
Expected: FAIL — `Cannot find module './guide-gate'`

- [ ] **Step 3: 实现**

`guide-gate.ts`：模块级 `let holds = 0` 与 `Set<(open: boolean) => void>`；`sync()` 只在 `open` 值变化时通知。`holdGuideGate` 自增并在返回的闭包里递减一次（用局部 `released` 布尔保证幂等）。

`popup-ownership.ts`：模块级 `Map<HTMLElement, HTMLElement>`（popup → owner，用当前元素而非 ref，避免 ref 更换后失效）；宽度优先的 BFS——从 `roots` 开始，反复把「owner 在已允许集合里的 popup」加入，直到稳定。

`types.ts`：两个 `interface`，`title`/`cue` 用 `import type { TranslationKey } from "../../i18n/index.js"`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/client-core && bun test src/components/guide/focus-scope.test.ts -t "guide gate"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-core/src/components/guide/popup-ownership.ts packages/client-core/src/components/guide/guide-gate.ts packages/client-core/src/components/guide/types.ts packages/client-core/src/components/guide/focus-scope.test.ts
git commit -m "feat(client-core): guide gate and popup ownership registry"
```

---

### Task 3: 模态层导出 + 焦点白名单

**Files:**
- Modify: `packages/client-core/src/lib/modal-focus.ts`
- Create: `packages/client-core/src/components/guide/focus-scope.ts`
- Test: `packages/client-core/src/components/guide/focus-scope.test.ts`（追加）

**Interfaces:**
- Consumes: `ownedPopups`、`isGuideGateOpen`（Task 2）。
- Produces:
  - `pushModalLayer(el: HTMLElement): void`、`popModalLayer(el: HTMLElement): void`（`lib/modal-focus.ts`）
  - `useGuideFocusScope(active: boolean, options: { layer: RefObject<HTMLElement | null>; getRoots: () => HTMLElement[]; onEscape: () => void }): void`

- [ ] **Step 1: 写失败测试**

`focus-scope.test.ts` 追加 `describe("useGuideFocusScope")`，用 `react-dom/client` + `act` 渲染一个最小宿主（参照 `src/components/transcript/tree-outline-nav.test.tsx:1-55` 的 register/act 写法）：

```ts
// 断言：背景元素不 inert，白名单外全部 inert
const host = document.createElement("div");
document.body.appendChild(host);
const background = document.createElement("button");            // 白名单外
const target = document.createElement("button");
target.dataset.guide = "composer";
const card = document.createElement("div");
// …渲染 <GuideHost />（测试内定义，调用 useGuideFocusScope(true, {...}) 并把 target/card 放进 DOM）
expect(background.inert).toBe(true);
expect(target.inert).toBe(false);
// 卸载后还原
```

其他 `it`：
- 原本就是 `inert` 的元素在卸载后仍然是 `inert`（还原到原值，不是一律设 false）。
- Tab 从卡片最后一个可聚焦元素按下 → 焦点回到白名单第一个（`Shift+Tab` 反向）。
- 浮层 open 且登记了 owner → 浮层元素 `inert === false`，且浮层内的 input 可聚焦。
- 浮层内按下 Escape 且浮层自己 `preventDefault()` → `onEscape` 不被调用。
- 无浮层时 Escape → `onEscape` 被调用一次。
- `isTopModal(layer)` 在 active 期间为 `true`，卸载后为 `false`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/client-core && bun test src/components/guide/focus-scope.test.ts`
Expected: FAIL — `Cannot find module './focus-scope'`

- [ ] **Step 3: 实现**

`lib/modal-focus.ts`：把 `modalStack.push(container)` / 移除逻辑抽成 `pushModalLayer` / `popModalLayer`，`useModalFocus` 改为调用它们（行为不变，这是为了引导能进入同一个栈）。

`focus-scope.ts` 的 `useGuideFocusScope`：
1. `active` 为真时 `pushModalLayer(layer)`，清理时 `popModalLayer`。
2. 用 `MutationObserver`（`childList: true, subtree: true`）重算白名单，节流到一个 `requestAnimationFrame`。
3. `sync()`：`restore()` 再重新 `isolate(document.body)`；白名单 = `[...getRoots(), ...ownedPopups(getRoots())]`；isolate 的递归规则与 `modal-focus.ts` 现有 `getFocusable` 的可见性判断保持一致。
4. Tab 捕获阶段拦截，候选集合 = 白名单内所有可聚焦元素（复用 `modal-focus.ts` 的 `FOCUSABLE` 选择器，导出它）。
5. Escape 监听在 `document` 捕获阶段，`event.defaultPrevented` 时直接返回（浮层已消费）。
6. 白名单外焦点（`focusin`）时把焦点拉回卡片。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/client-core && bun test src/components/guide/focus-scope.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-core/src/lib/modal-focus.ts packages/client-core/src/components/guide/focus-scope.ts packages/client-core/src/components/guide/focus-scope.test.ts
git commit -m "feat(client-core): guide focus scope on the shared modal stack"
```

---

### Task 4: 图层与卡片组件

**Files:**
- Create: `packages/client-core/src/components/guide/GuideOverlay.tsx`
- Create: `packages/client-core/src/components/guide/guide.css`
- Test: `packages/client-core/src/components/guide/guide-overlay.test.tsx`

**Interfaces:**
- Consumes: `measureSpotlight`、`placeCard`、`useGuideFocusScope`、`GuideStep`、`t`。
- Produces: `interface GuideOverlayProps { active: boolean; step: GuideStep; index: number; total: number; host: RefObject<HTMLElement | null>; onNext(): void; onPrev(): void; onSkip(): void; onReady(): void }`；渲染根 `className="guide-layer"`，卡片 `className="guide-card"`，高亮框 `className="guide-spot"`，遮罩 `className="guide-backdrop"`。

- [ ] **Step 1: 写失败测试**

`describe("GuideOverlay")`：
- 无目标时渲染纯遮罩（`.guide-backdrop--dim`），不渲染 `.guide-spot`。
- 有目标时为 `.guide-backdrop` 带 `style.clipPath`，值以 `polygon(evenodd` 开头。
- 卡片标题、`{index+1} / {total}`、说明文字来自 `t(key)`。
- 第 0 步不渲染「上一步」按钮；最后一步按钮文案是 `t("guide.done")`。
- 点击「跳过」调用 `onSkip`，「下一步」调用 `onNext`。
- 点击 `.guide-spot` 本身不触发任何回调（`pointer-events: none` 由 CSS 保证，测试断言该元素 `aria-hidden="true"` 且无 `onClick` 语义）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/client-core && bun test src/components/guide/guide-overlay.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

`GuideOverlay.tsx`：
- 用 `useLayoutEffect` 测 `measureSpotlight(host.current, step.target ?? fallback)`，写入 `spot` state；用 `ResizeObserver` + `host` 的 `scroll`（捕获）+ `resize` + `animationend` 触发重测，全部合并到一个 `requestAnimationFrame`。
- `placeCard(spot, {width: card.offsetWidth, height: card.offsetHeight}, hostSize)` → 卡片内联 style；测不到卡片尺寸时用 `{ width: 304, height: 140 }` 占位。
- `onReady()` 在第一次测量完成后调用一次（通知 hook 进入「已就绪」）。
- `useGuideFocusScope(active, { layer, getRoots: () => [targetEl, cardEl], onEscape: onSkip })`。
- 方向键 ←/→：仅当 `document.activeElement` 不在 input/textarea/contenteditable 且无修饰键时 `preventDefault()` 并 `onPrev`/`onNext`。

`guide.css`：
- `.guide-layer { position: absolute; inset: 0; z-index: 200; pointer-events: none; border-radius: inherit; overflow: hidden; }`
- `.guide-backdrop { position: absolute; inset: 0; pointer-events: auto; background: color-mix(in oklab, var(--color-bg) 55%, transparent); }`
- `.guide-backdrop--dim { animation: guide-fade var(--duration-settle) var(--ease-appear); }`
- `.guide-spot { position: absolute; border-radius: 12px; border: 1.5px solid var(--color-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 22%, transparent); pointer-events: none; transition: left var(--duration-one-take) var(--ease-one-take), top var(--duration-one-take) var(--ease-one-take), width var(--duration-one-take) var(--ease-one-take), height var(--duration-one-take) var(--ease-one-take); }`
- `.guide-card { position: absolute; z-index: 210; width: 304px; max-width: calc(100% - 24px); …L2 float 材质…; transition: left/top 同上; }`
- `@media (prefers-reduced-motion: reduce), :where(.gui-motion-off) .guide-layer { … transition/animation: none }`

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/client-core && bun test src/components/guide/guide-overlay.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-core/src/components/guide/GuideOverlay.tsx packages/client-core/src/components/guide/guide.css packages/client-core/src/components/guide/guide-overlay.test.tsx
git commit -m "feat(client-core): guide overlay, spotlight clip and card"
```

---

### Task 5: 状态机 hook

**Files:**
- Create: `packages/client-core/src/components/guide/useSpotlightGuide.ts`
- Test: `packages/client-core/src/components/guide/use-spotlight-guide.test.tsx`

**Interfaces:**
- Consumes: `GuideStep`、`GuideSpec`、`isGuideGateOpen`、`subscribeGuideGate`。
- Produces:

```ts
export const GUIDE_DONE_KEY = "musepi-gui-main-guide-done";

export interface UseSpotlightGuideOptions {
	steps: GuideStep[];
	/** 主聊天表面是否可见（面板/设置/工作区打开时为 false）。 */
	surfaceVisible: boolean;
	/** 是否已连接、可交互。 */
	connected: boolean;
	/** 重播时把聊天表面换回来；重播在设置里触发。 */
	returnToChat(): void;
	/** 目标消失多久后判定为暂停（默认 2 帧后仍未测到，实现用 120ms 兜底）。 */
}

export interface SpotlightGuide {
	active: boolean;
	step: GuideStep | null;
	index: number;
	total: number;
	paused: boolean;
	next(): void;
	prev(): void;
	dismiss(): void;
	replay(): void;
	ready(): void;
	reportTargetMissing(missing: boolean): void;
}
```

- [ ] **Step 1: 写失败测试**

- 首次满足条件（未看过、`surfaceVisible`、`connected`、gate 开）→ `active === true`、`index === 0`。
- 条件未满足（`surfaceVisible: false`）→ 不启动；后续变为 true 才启动。
- `dismiss()` → `active === false` 且 `localStorage.getItem(GUIDE_DONE_KEY) === "1"`。
- 走完最后一步 `next()` → 同 `dismiss()`。
- `localStorage` 已有 `"1"` → 不自动启动，但 `replay()` 能启动且 `index === 0`。
- `replay()` 调用 `returnToChat` 一次，并在其后才启动。
- `optional` 步的目标缺失 → 自动跳过到下一步；全部 optional 缺失 → 直接写入 done 不显示。
- `reportTargetMissing(true)` → `paused === true`，`active` 仍为 true；`reportTargetMissing(false)` → `paused === false` 且 `index` 不变。
- gate 关闭时不启动；gate 打开后且条件仍成立才启动。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/client-core && bun test src/components/guide/use-spotlight-guide.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

`useSpotlightGuide(options)`：
- `useState` 存 `{ spec: GuideSpec | null }`；`nonce` 递增保证 `replay()` 从头开始。
- 自动启动用 `useEffect` 依赖 `[surfaceVisible, connected, gateOpen]`，条件全部成立且 `!seen()` 时 `setSpec({ mode: "main", nonce: 1, steps })`。
- `seen()` / `markSeen()` 读写 `localStorage`，任何异常都按「已看过」处理（spec 的失败行为）。
- `dismiss()`、走完 → `markSeen()` + `setSpec(null)`。
- `replay()` → `returnToChat()`，`setSpec({ mode: "main", nonce: prev + 1, steps })`。
- `reportTargetMissing(true)` 只在 `!paused` 时置位，并起一个 120ms 定时器；期间收到 `false` 就取消定时器。
- 返回的 `step` 在 `paused` 时仍返回当前步（卡片继续显示）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/client-core && bun test src/components/guide/use-spotlight-guide.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-core/src/components/guide/useSpotlightGuide.ts packages/client-core/src/components/guide/use-spotlight-guide.test.tsx
git commit -m "feat(client-core): main guide state machine with pause and replay"
```

---

### Task 6: 导出与文案

**Files:**
- Create: `packages/client-core/src/components/guide/index.ts`
- Create: `packages/client/locale/src/client/zh-CN/guide.ts`
- Create: `packages/client/locale/src/client/en-US/guide.ts`
- Modify: `packages/client/locale/src/client/zh-CN/index.ts`、`en-US/index.ts`
- Modify: `packages/client-core/src/index.ts`

**Interfaces:**
- Consumes: Task 1–5 的全部产物。
- Produces: `@musepi/client-core` 导出 `GuideOverlay`、`useSpotlightGuide`、`GUIDE_DONE_KEY`、`registerPopupOwner`、`holdGuideGate`、`measureSpotlight`、`placeCard`、`GuideStep`、`GuideSpec`、`SpotlightGuide`；文案键 `guide.*`。

- [ ] **Step 1: 写失败测试**

`packages/client/locale/src/client/en-US/guide.ts` 的类型 `satisfies Record<GuideKey, string>` 本身就是编译期断言。另在 `packages/client-core/src/components/guide/anchors.test.ts` 先放一条：`import { t } from "../../i18n/index.js"; expect(t("guide.next")).not.toBe("guide.next")`（未注册的 key 会原样返回）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/client-core && bun test src/components/guide/anchors.test.ts`
Expected: FAIL — `t("guide.next")` 返回 `"guide.next"`（键不存在）

- [ ] **Step 3: 实现**

`zh-CN/guide.ts` 至少包含：

```ts
export const guide = {
	"guide.title": "界面导览",
	"guide.next": "下一步",
	"guide.prev": "上一步",
	"guide.skip": "跳过",
	"guide.done": "完成",
	"guide.counter": "{index} / {total}",
	"guide.restart": "界面导览",
	"guide.restartHint": "重新看一遍主界面的用法",
	// 移动/网页
	"guide.composer.title": "输入框",
	"guide.composer.cue": "在这里打字然后发送，和按下 Enter 是一回事。",
	"guide.attach.title": "附件",
	"guide.attach.cue": "点这里加图片或文件。",
	"guide.model.title": "模型与思考",
	"guide.model.cue": "换模型、调思考深度都在这个胶囊里。",
	"guide.sessions.title": "会话",
	"guide.sessions.cue": "点标题打开会话列表，之前的对话都在里面。",
	"guide.tabs.title": "底部导航",
	"guide.tabs.cue": "聊天、连接和设置在这里切换。",
	// 桌面
	"guide.sidebar.title": "侧栏",
	"guide.sidebar.cue": "这里收起或展开会话列表。",
	"guide.tree.title": "会话树",
	"guide.tree.cue": "每个会话都是一条分支，可以在这里切换。",
	"guide.panels.title": "工作面板",
	"guide.panels.cue": "文件、终端、看板从这里的入口打开。",
	"guide.settings.title": "设置",
	"guide.settings.cue": "外观、服务商、语音都在设置里。",
} as const;
export type GuideKey = keyof typeof guide;
```

`en-US/guide.ts` 同键英文，`satisfies Record<GuideKey, string>`；两个 `index.ts` 加 `...guide` 与 import；`client-core/src/index.ts` 加 `export * from "./components/guide/index.js"`。

- [ ] **Step 4: 跑检查**

Run: `cd packages/client-core && bun run check`
Expected: biome 与类型检查均通过（若 `guide.*` 键在 `t()` 调用处拼错，这里会报错）。

Run: `cd packages/client-core && bun test src/components/guide/anchors.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client-core/src/components/guide/index.ts packages/client-core/src/index.ts packages/client/src/client/zh-CN/guide.ts packages/client/src/client/en-US/guide.ts packages/client/src/client/zh-CN/index.ts packages/client/src/client/en-US/index.ts packages/client-core/src/components/guide/anchors.test.ts
git commit -m "feat(i18n): guide copy and client-core guide exports"
```

---

## Phase B｜移动 / 网页接入

### Task 7: `client-core` 主界面接入

**Files:**
- Create: `packages/client-core/src/components/guide/steps.ts`
- Modify: `packages/client-core/src/app.tsx`
- Modify: `packages/client-core/src/components/shell/Composer.tsx`
- Modify: `packages/client-core/src/components/shell/HeaderBar.tsx`
- Modify: `packages/client-core/src/components/shell/MobileTabBar.tsx`
- Modify: `packages/client-core/src/components/shell/MobileSettings.tsx`

**Interfaces:**
- Consumes: `useSpotlightGuide`、`GuideOverlay`、`GuideStep`。
- Produces: `clientGuideSteps(opts: { mobile: boolean }): GuideStep[]`；`app.tsx` 内 `guideHostRef` 指向 `.sh-app`。

- [ ] **Step 1: 加锚点并写失败测试**

在锚点元素上加 `data-guide`：

| 文件 | 元素 | id |
|---|---|---|
| `Composer.tsx:1366` 附近的外层 `<div className="sh-composer…">` | 根 div | `composer` |
| `Composer.tsx:1434-1442` 的 `+` 按钮 | button | `composer-attach` |
| `Composer.tsx:1458-1494` 的 `.sh-mt-capsule` | div | `composer-model` |
| `HeaderBar.tsx:267-287` 的 `.sh-title` 按钮或 span | 元素 | `header-title` |
| `HeaderBar.tsx:327-408` 的 `.sh-header-nav` | span | `header-panels` |
| `MobileTabBar.tsx` 的设置页签按钮 | button | `tabbar-settings` |

`anchors.test.ts` 追加：

```ts
it("every non-optional client-core step has its anchor in source", () => {
	const source = readdirSync(clientDir)
		.filter(file => file.endsWith(".tsx") || file.endsWith(".ts"))
		.map(file => readFileSync(join(clientDir, file), "utf8"))
		.join("\n");
	for (const step of clientGuideSteps({ mobile: true })) {
		const present = step.target === undefined || source.includes(`data-guide="${step.target}"`);
		expect(present || step.optional === true).toBe(true);
	}
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/client-core && bun test src/components/guide/anchors.test.ts`
Expected: FAIL — 缺少 `steps.ts` 导出，或锚点未加

- [ ] **Step 3: 实现**

`steps.ts` 按设计文档 §2 的移动表实现；`mobile: false`（桌面浏览器）时把最后一步换成 `header-panels`。

`app.tsx` 在 `Session` 组件里：

```tsx
const guideHostRef = useRef<HTMLDivElement | null>(null);
const guide = useSpotlightGuide({
	steps: clientGuideSteps({ mobile }),
	surfaceVisible: activePanel === null && !inWorkspace,
	connected: client !== null,
	returnToChat: () => { setActivePanel(null); },
});
```

根 div 加 `ref={guideHostRef}`；在 `<Toasts />` 之前渲染：

```tsx
{guide.active && guide.step && (
	<GuideOverlay
		active
		step={guide.step}
		index={guide.index}
		total={guide.total}
		host={guideHostRef}
		onNext={guide.next}
		onPrev={guide.prev}
		onSkip={guide.dismiss}
		onReady={guide.ready}
	/>
)}
```

`activePanel === null && !inWorkspace` 时导览才活跃；面板/设置打开时导览整个卸载（用户主动离开主界面，不算看完，不写 done——`dismiss` 才写）。

`MobileSettings.tsx` 在「通用」分组加一行按钮：`onClick={() => { setActivePanel(null); guide.replay(); }}`，文案 `t("guide.restart")` + hint `t("guide.restartHint")`。若 `MobileSettings` 拿不到 `guide`，改为通过 `window` 自定义事件 `musepi-main-guide-replay`，由 `app.tsx` 监听并调用 `guide.replay()`。

- [ ] **Step 4: 跑测试与检查**

Run: `cd packages/client-core && bun test src/components/guide/anchors.test.ts && bun run check`
Expected: PASS

- [ ] **Step 5: 手动验证（网页版）并提交**

Run: `cd packages/client-core && bun run dev`
在浏览器里：清 `localStorage` → 进入会话 → 导览出现 → 下一步 → 框滑到附件按钮且不越位 → 在高亮里点开模型胶囊 → 浮层可点 → Esc 只关浮层 → 跳过 → 重看入口可用。

```bash
git add packages/client-core/src/components/guide/steps.ts packages/client-core/src/app.tsx packages/client-core/src/components/shell/Composer.tsx packages/client-core/src/components/shell/HeaderBar.tsx packages/client-core/src/components/shell/MobileTabBar.tsx packages/client-core/src/components/shell/MobileSettings.tsx packages/client-core/src/components/guide/anchors.test.ts
git commit -m "feat(client-core): main guide on the shared shell with replay entry"
```

---

## Phase C｜桌面接入

### Task 8: 桌面浮层登记与 gate 接线

**Files:**
- Modify: `apps/desktop/src/lib/use-floating-menu.tsx`
- Modify: `apps/desktop/src/components/OnboardingOverlay.tsx`
- Modify: `apps/desktop/src/components/AnnouncementOverlay.tsx`

**Interfaces:**
- Consumes: `registerPopupOwner`、`holdGuideGate`。
- Produces: `useFloatingMenu` 在内部用 `ownerRef`（anchor）与 `menuRef` 调 `registerPopupOwner`，调用点签名不变（39 处不用改）。

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/lib/use-floating-menu.test` 若无现成测试文件则新建 `apps/desktop/test/use-floating-menu.test.ts`：
- 打开菜单后 `ownedPopups([anchor])` 含菜单元素。
- 关闭菜单后不再包含。
- gate：`AnnouncementOverlay` 挂载且 `open` 时 `isGuideGateOpen() === false`，卸载后 `true`（用 happy-dom 渲染最小子树，或在 `OnboardingOverlay` 顶部加可测的 `holdGuideGate` 调用并用 spy 断言）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test test/use-floating-menu.test.ts`
Expected: FAIL — `ownedPopups` 不含菜单

- [ ] **Step 3: 实现**

`use-floating-menu.tsx:500` 附近 `return { anchorRef: setAnchor, renderMenu }` 前加：

```ts
const ownerEl = anchorElRef 的当前元素;
const menuEl = menuRef.current;
useEffect(() => {
  if (!open || !ownerEl || !menuEl) return;
  return registerPopupOwner(ownerEl, menuEl);
}, [open, ownerEl, menuEl]);
```

`OnboardingOverlay.tsx` 与 `AnnouncementOverlay.tsx`：在 `open` 为真时 `holdGuideGate()`，关闭时 release（用 `useEffect` 依赖 `open`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && bun test test/use-floating-menu.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/lib/use-floating-menu.tsx apps/desktop/src/components/OnboardingOverlay.tsx apps/desktop/src/components/AnnouncementOverlay.tsx apps/desktop/test/use-floating-menu.test.ts
git commit -m "feat(desktop): register menu popups and hold the guide gate for tour layers"
```

---

### Task 9: 桌面步骤表与锚点

**Files:**
- Create: `apps/desktop/src/components/main-guide-steps.ts`
- Modify: `apps/desktop/src/components/GuiHeader.tsx`
- Modify: `apps/desktop/src/components/SessionList.tsx`
- Modify: `apps/desktop/src/components/HeroComposer.tsx`
- Modify: `apps/desktop/src/components/AppRail.tsx`（设置入口）
- Create: `apps/desktop/test/main-guide-anchors.test.ts`

**Interfaces:**
- Consumes: `GuideStep`。
- Produces: `desktopGuideSteps(): GuideStep[]`。

- [ ] **Step 1: 加锚点并写失败测试**

| 文件 | 元素 | id |
|---|---|---|
| `GuiHeader.tsx:718` 的 `.gui-sidebar-toggle` | button | `sidebar-toggle` |
| `SessionList.tsx` 会话树容器 | div | `session-tree` |
| `HeroComposer.tsx` 输入卡片根 | div | `composer` |
| `HeroComposer.tsx` 模型选择胶囊 | button | `model-picker` |
| `GuiHeader.tsx:864` `.gui-header-spacer` 右侧的视图切换 | 容器 | `header-panels` |
| `AppRail.tsx` 的账号/rail 设置入口 | button | `settings-entry` |

`main-guide-anchors.test.ts`：遍历 `apps/desktop/src` 下 `.tsx`，断言每个非 optional 步骤的 `data-guide="<id>"` 出现至少一次。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test test/main-guide-anchors.test.ts`
Expected: FAIL — `desktopGuideSteps` 不存在

- [ ] **Step 3: 实现**

`main-guide-steps.ts` 按设计文档 §2 桌面表；`session-tree` 带 `fallback: "sidebar-toggle"`、`model-picker` 带 `optional: true`、`settings-entry` 落地时若 AppRail 没有合适的常驻元素则写 `optional: true` 且不加锚点（保留卡片步骤）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && bun test test/main-guide-anchors.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/components/main-guide-steps.ts apps/desktop/src/components/GuiHeader.tsx apps/desktop/src/components/SessionList.tsx apps/desktop/src/components/HeroComposer.tsx apps/desktop/src/components/AppRail.tsx apps/desktop/test/main-guide-anchors.test.ts
git commit -m "feat(desktop): main guide step table and data-guide anchors"
```

---

### Task 10: 桌面触发与挂载

**Files:**
- Create: `apps/desktop/src/lib/main-guide.ts`
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify: `apps/desktop/src/app.tsx`

**Interfaces:**
- Consumes: `useSpotlightGuide`、`GuidOverlay`、`desktopGuideSteps`。
- Produces: `useMainGuide({ host, visible, returnToChat }): SpotlightGuide`。

- [ ] **Step 1: 写失败测试**

`apps/desktop/test/main-guide.test.ts`：
- 未看过 + `visible` → 启动；已看过 → 不启动。
- `musepi-onboarding-finished` 事件在 320ms 后触发一次启动尝试（用 fake timers）。
- gate 关闭（公告打开）时不启动。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test test/main-guide.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

`main-guide.ts` 包一层 `useSpotlightGuide`：订阅 `musepi-onboarding-finished` 并 `setTimeout(320)`；`connected` 取渲染层的连接状态。

`ChatView.tsx` 在 `apps/desktop/src/app.tsx:5148` 的 `.gui-shell` 根节点上挂 `ref={guideShellRef}`（在 `app.tsx` 里声明 `const guideShellRef = useRef<HTMLDivElement | null>(null)` 并透传给 `ChatView`；若 `ChatView` 的根不是 `.gui-shell`，就挂在它最内层的 `gui-pane-center` 上，宿主只需要包含所有锚点）；`visible` 取「聊天地面可见」（`!pageDestinationActive && !settingsActive`），在 `ChatView` 的返回树里、`Toasts` 之上挂载 `GuideOverlay`。

导出标记键在 `apps/desktop/src/lib/main-guide.ts` 里不要重复定义，直接复用 `GUIDE_DONE_KEY`（Task 5），避免两处键名漂移。

- [ ] **Step 4: 跑测试与检查**

Run: `cd apps/desktop && bun test test/main-guide.test.ts && bun run check`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/lib/main-guide.ts apps/desktop/src/components/ChatView.tsx apps/desktop/src/app.tsx apps/desktop/test/main-guide.test.ts
git commit -m "feat(desktop): mount the main guide on the chat surface"
```

---

### Task 11: 「开始使用」清单卡与重播入口

**Files:**
- Modify: `apps/desktop/src/components/GettingStartedCard.tsx`
- Modify: `apps/desktop/src/components/SettingsNav.tsx`

**Interfaces:**
- Consumes: `SpotlightGuide.active`、`replay`。
- Produces: `GettingStartedCard` 新增可选 prop `suppressed?: boolean`（为真时按「已折叠」渲染）。

- [ ] **Step 1: 写失败测试**

- `suppressed` 为真时卡片渲染为折叠态，且**不改写** `musepi-gui-getting-started-v1`。
- `suppressed` 变回 false 后恢复用户自己的折叠状态。
- `SettingsNav` 里新入口点击后调用 `replay`（用 spy）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test test/getting-started-suppressed.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`GettingStartedCard` 的渲染分支读 `suppressed || state.collapsed` 决定是否展开；localStorage 写入不变。

`SettingsNav.tsx:712` 现有的「引导」按钮旁加一行「界面导览」，`onClick` 先关设置、再 `guide.replay()`（`returnToChat` 已负责切回聊天）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && bun test test/getting-started-suppressed.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/components/GettingStartedCard.tsx apps/desktop/src/components/SettingsNav.tsx apps/desktop/test/getting-started-suppressed.test.ts
git commit -m "feat(desktop): suppress the getting-started card during the guide and add replay"
```

---

## Phase D｜收尾

### Task 12: 文档与变更记录

**Files:**
- Modify: `docs/gui-design.md`（§ overlay selection 表里加一行「Spotlight guide」，说明层级 200/210、不模糊、位置用 one-take）
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`（`[Unreleased]` 下 `Added`）

**Interfaces:**
- Consumes: 前序任务的最终行为。
- Produces: 无。

- [ ] **Step 1: 写文档**

`docs/gui-design.md` 在 overlay 表的 tour 段落后补一段：导览层与 onboarding 同处 200 档但**不模糊、不盖界面**，位置过渡固定 `--ease-one-take`；与「开始使用」清单卡互斥。

`CHANGELOG.musepi.md`：

```markdown
- **Main interface guide**: the first time you land on the main screen, a short spotlight guide points at the sidebar, composer, model picker and panels and lets you click the real control while it runs. Skip or replay it from Settings; it runs once per profile and never covers Settings itself. / 主界面新增一次性的聚光灯导览：第一次进入主界面时高亮侧栏、输入框、模型选择与面板入口，导览期间可以直接点真实控件。可在设置里跳过或重播，每个配置文件只自动出现一次，不覆盖设置页。
```

- [ ] **Step 2: 跑全量检查**

Run: `cd packages/client-core && bun run check && bun test`
Run: `cd apps/desktop && bun run check && bun test`
Run: `bun check`（仓库根，任务说明要求用它而非 tsc）
Expected: 全部通过；若有与本改动无关的既有失败，单独记录，不掩盖。

- [ ] **Step 3: 提交**

```bash
git add docs/gui-design.md packages/coding-agent/CHANGELOG.musepi.md
git commit -m "docs: document the main interface spotlight guide"
```