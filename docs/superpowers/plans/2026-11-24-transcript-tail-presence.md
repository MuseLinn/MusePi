# 转录尾部在场行（TailPresence）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话工作时在转录末尾显示一行「agent 头像 + 会轮换的状态文案 + 计时」，带字形扫光、安静态与可展开的本轮工具摘要，替换现在只有计时的那一行。

**Architecture:** 三层，全部落在共享层 `packages/client-core`，桌面端与移动端自动受益：①`tool-activity.ts` 中立分类器把工具名归成活动类别；②`live-phrase.ts` 纯函数把状态映射成「阶段 + 同义句池」并按确定性哈希轮换；③`TailPresence.tsx` 渲染，头像与展开内容由宿主以 props 注入。`Transcript` 只在「working 且本轮还没有回复」的槽位渲染它。

**Tech Stack:** TypeScript、React 19、Bun 测试（happy-dom + `renderToStaticMarkup`）、Biome、`@musepi/client-locale` 的 `t()`。

**Spec:** `docs/superpowers/specs/2026-11-24-transcript-tail-presence-design.md`

## Global Constraints

- 动效必须是「遮罩窗口 + 反向副本」：`presence-band` 向一侧、`presence-bright` 反向同样多，文字在屏幕上恒不动。位移只用 `steps(12, jump-none)` 走完周期前 35%，其余静止。禁止 `background-position` / `background-clip` 方案。
- 文案永远单行：`white-space: nowrap` + `overflow: hidden` + `text-overflow: ellipsis`。不换行。
- 读屏读**未截断**的规范句；轮换本身不触发播报（live region 只在阶段变化时更新）。
- 计时用现成的 `useWorkingNow`，锚点为本轮 user 消息时间戳；不得每秒重渲染整棵转录。
- 安静态措辞只陈述事实：`暂无新输出` / `已 {minutes} 分钟没有新输出`。禁止「卡住 / 失败 / 重试」字样与恢复按钮。
- i18n 键必须先在 `packages/client/locale/src/client/zh-CN/transcript.ts` 存在（`TranslationKey = keyof typeof zhCN` 是类型源），且 `en-US/transcript.ts` 同步补齐。
- 不得在 client-core 内 import `apps/`；不得把某个渲染器的状态枚举喂给另一个渲染器（`agent-signals.ts` 顶部规则）。
- 检查用 `bun check`，禁止 `tsc` / `npx tsc`。
- `.gui-motion-off` 与 `prefers-reduced-motion: reduce` 下：扫光整层 `display: none`，无进出场动画。

## Review Focus

每一条都在下面的任务里有对应测试；括号里是归属任务。

1. **超长工具名或文件路径**（Task 4 Step 5a）：一个 200 字符的 `mcp__very-long-server__some_tool` 或深层路径，必须仍是一行、以省略号截断，不能撑破转录宽度或推出横向滚动条。
2. **极短容器（移动端窄屏）**（Task 4 Step 5a）：宽度不足以同时容纳头像 + 文案 + 计时时，文案先被压缩截断，头像与计时不被挤掉、不换行。
3. **阶段高频抖动**（Task 4 Step 5b）：模型在 1 秒内连续切换读文件 → 跑命令 → 读文件，轮换计时器必须按新阶段重置而不是叠加，且不能出现两句同时可见。
4. **同屏多个转录**（Task 4 Step 5c + Task 8 Step 5 真机）：子代理面板与主会话同时工作时，两行的扫光相位必须错开（`--presence-sheen-delay` 由 `Date.now() % period` 初始化），不能整齐划一地同步闪。
5. **流式边界**（Task 5 Step 1）：从「工作中无回复」切到「正在流式输出」的瞬间，尾部行必须退场且计时不重复出现两次（一次在尾部、一次在回复下方）。

---

### Task 1: 中立工具分类器 `tool-activity.ts`

**Files:**
- Create: `packages/client-core/src/lib/tool-activity.ts`
- Test: `packages/client-core/test/tool-activity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type ToolActivityKind =
    | "thinking" | "searching" | "reading" | "writing" | "running-commands"
    | "browsing" | "using-computer" | "messaging" | "waiting" | "working";
  export function toolActivityKind(toolName: string | null | undefined): ToolActivityKind;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { toolActivityKind } from "../src/lib/tool-activity";

describe("toolActivityKind", () => {
	it("maps search-family names to searching", () => {
		expect(toolActivityKind("grep")).toBe("searching");
		expect(toolActivityKind("Glob")).toBe("searching");
		expect(toolActivityKind("ast_grep")).toBe("searching");
		expect(toolActivityKind("web_search")).toBe("searching");
	});
	it("maps read-family names to reading", () => {
		expect(toolActivityKind("read")).toBe("reading");
		expect(toolActivityKind("view")).toBe("reading");
		expect(toolActivityKind("read_file")).toBe("reading");
	});
	it("maps write-family names to writing", () => {
		expect(toolActivityKind("edit")).toBe("writing");
		expect(toolActivityKind("apply_patch")).toBe("writing");
		expect(toolActivityKind("write_file")).toBe("writing");
	});
	it("maps shell-family names to running-commands", () => {
		expect(toolActivityKind("bash")).toBe("running-commands");
		expect(toolActivityKind("run_command")).toBe("running-commands");
		expect(toolActivityKind("terminal")).toBe("running-commands");
	});
	it("maps browser, computer, messaging and waiting families", () => {
		expect(toolActivityKind("browser_navigate")).toBe("browsing");
		expect(toolActivityKind("fetch_url")).toBe("browsing");
		expect(toolActivityKind("computer_click")).toBe("using-computer");
		expect(toolActivityKind("send_message")).toBe("messaging");
		expect(toolActivityKind("ask_user")).toBe("waiting");
	});
	it("strips an mcp__server__ prefix before classifying", () => {
		expect(toolActivityKind("mcp__files__read")).toBe("reading");
		expect(toolActivityKind("mcp__shell__bash")).toBe("running-commands");
	});
	it("falls back to working for unknown, empty and null names", () => {
		expect(toolActivityKind("some_unknown_tool")).toBe("working");
		expect(toolActivityKind("")).toBe("working");
		expect(toolActivityKind(null)).toBe("working");
		expect(toolActivityKind(undefined)).toBe("working");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/client-core && bun test test/tool-activity.test.ts`
Expected: FAIL — `Cannot find module "../src/lib/tool-activity"`.

- [ ] **Step 3: Implement `toolActivityKind` in `packages/client-core/src/lib/tool-activity.ts`**

Lowercase the name, strip a leading `mcp__<server>__` prefix, then test the same family patterns `apps/desktop/src/lib/agent-signals.ts:144` already uses (search/grep/glob/find → searching；read/view/inspect/cat → reading；edit/write/patch/apply → writing；bash/shell/exec/command/terminal/run → running-commands；browser/fetch/http → browsing；computer/mouse/keyboard → using-computer；message/chat/reply → messaging；todo/ask/approval/wait → waiting；其余 working). Keep the pattern list in one ordered array so the first match wins.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/client-core && bun test test/tool-activity.test.ts`
Expected: PASS（7 个用例全绿）。

- [ ] **Step 5: Point the desktop adapter at the shared classifier**

In `apps/desktop/src/lib/agent-signals.ts`, rewrite `activityVerbForTool` to delegate:

```ts
export function activityVerbForTool(toolName: string | null | undefined): AgentActivityVerb {
	return toolActivityKind(toolName) as AgentActivityVerb;
}
```

（`ToolActivityKind` 与 `AgentActivityVerb` 目前取值一致；用 `as` 而不是互相 import 枚举，正是 `agent-signals.ts` 顶部「Never feed one renderer's state enum into another」要求的边界。）

- [ ] **Step 6: Run the desktop adapter's existing tests**

Run: `cd apps/desktop && bun test test/agent-role.test.ts test/companion-gaze.test.ts`
Expected: PASS — 委托后行为不变。

- [ ] **Step 7: Commit**

```bash
git add packages/client-core/src/lib/tool-activity.ts packages/client-core/test/tool-activity.test.ts apps/desktop/src/lib/agent-signals.ts
git commit -m "refactor: 抽出共享的工具活动分类器"
```

---

### Task 2: i18n 词条

**Files:**
- Modify: `packages/client/locale/src/client/zh-CN/transcript.ts`（字典末尾、`bootPreparing` 之后）
- Modify: `packages/client/locale/src/client/en-US/transcript.ts`
- Test: `packages/client-core/test/live-phrase.test.ts`（与 Task 3 共用，此任务只先建文件并放一条键存在性断言）

**Interfaces:**
- Consumes: nothing.
- Produces: 键名清单，Task 3 与 Task 4 按名引用。
  - `transcript.phaseThinking` / `PhaseReading` / `PhaseSearching` / `PhaseWriting` / `PhaseCommands` / `PhaseBrowsing` / `PhaseComputer` / `PhaseMessaging` / `PhaseWaiting` / `PhaseReply` / `PhaseWorking`
  - 每阶段同义句：`transcript.altMulling`、`altPiecing`、`altWeighing`、`altNarrowing`、`altSkimming`、`altDrafting`、`altCheckingOutput`、`altTakingALook`、`altClickingThrough`、`altLookingItUp`
  - `transcript.workingQuiet`、`transcript.workingSilent`（`{minutes}`）、`transcript.presenceDetailLabel`、`transcript.presenceSteps`（`{files}`、`{commands}`）

- [ ] **Step 1: Add the zh-CN keys**

在 `packages/client/locale/src/client/zh-CN/transcript.ts` 的 `transcript` 对象内追加：

```ts
	"transcript.phaseThinking": "正在仔细思考",
	"transcript.phaseReading": "正在读文件",
	"transcript.phaseSearching": "正在四处查找",
	"transcript.phaseWriting": "正在编写代码",
	"transcript.phaseCommands": "正在运行命令",
	"transcript.phaseBrowsing": "正在查资料",
	"transcript.phaseComputer": "正在操作界面",
	"transcript.phaseMessaging": "正在发消息",
	"transcript.phaseWaiting": "正在等你确认",
	"transcript.phaseReply": "正在回复",
	"transcript.phaseWorking": "正在处理",
	"transcript.altMulling": "正在琢磨",
	"transcript.altPiecing": "正在理清思路",
	"transcript.altWeighing": "正在权衡做法",
	"transcript.altNarrowing": "正在缩小范围",
	"transcript.altSkimming": "正在过一遍内容",
	"transcript.altDrafting": "正在落地改动",
	"transcript.altCheckingOutput": "正在看执行结果",
	"transcript.altTakingALook": "正在看一眼",
	"transcript.altClickingThrough": "正在逐项点开",
	"transcript.altLookingItUp": "正在查一下",
	"transcript.workingQuiet": "暂无新输出",
	"transcript.workingSilent": "已 {minutes} 分钟没有新输出",
	"transcript.presenceDetailLabel": "这一轮正在做什么",
	"transcript.presenceSteps": "读取 {files} 个文件 · 运行 {commands} 条命令",
```

- [ ] **Step 2: Add the matching en-US keys**

在 `packages/client/locale/src/client/en-US/transcript.ts` 追加同名键，值为英文（`PhaseThinking: "Thinking it through"`、`altMulling: "Mulling it over"`、`workingQuiet: "No new output"`、`workingSilent: "No new output for {minutes} min"`、`presenceSteps: "Read {files} files · ran {commands} commands"` 等）。

- [ ] **Step 3: Write the key-existence test**

```ts
import { describe, expect, it } from "bun:test";
import { t } from "../src/i18n/index.js";

describe("tail presence i18n keys", () => {
	it("resolves every phase label and quiet-state string", () => {
		expect(t("transcript.phaseSearching")).not.toBe("transcript.phaseSearching");
		expect(t("transcript.altNarrowing")).not.toBe("transcript.altNarrowing");
		expect(t("transcript.workingQuiet")).not.toBe("transcript.workingQuiet");
		expect(t("transcript.workingSilent", { minutes: 2 })).toContain("2");
		expect(t("transcript.presenceSteps", { files: 3, commands: 2 })).toContain("3");
	});
});
```

（`t()` 找不到键时原样返回键名，所以「返回值不等于键名」就是键存在的证明。）

- [ ] **Step 4: Run the test**

Run: `cd packages/client-core && bun test test/live-phrase.test.ts`
Expected: PASS。

- [ ] **Step 5: Run the hardcoded-copy gate**

Run: `bun scripts/verify-client-ui-i18n.ts`
Expected: 通过；基线不得新增违规。

- [ ] **Step 6: Commit**

```bash
git add packages/client/locale/src/client/zh-CN/transcript.ts packages/client/locale/src/client/en-US/transcript.ts packages/client-core/test/live-phrase.test.ts
git commit -m "feat(i18n): 尾部在场行的状态文案词条"
```

---

### Task 3: 文案引擎 `live-phrase.ts`

**Files:**
- Create: `packages/client-core/src/components/transcript/live-phrase.ts`
- Test: `packages/client-core/test/live-phrase.test.ts`（在 Task 2 建的文件里追加）

**Interfaces:**
- Consumes: `toolActivityKind`（Task 1）；`t()` 与 Task 2 的键。
- Produces:
  ```ts
  export interface TailSignals {
    working: boolean;
    streaming: boolean;
    approvals: number;
    paused: boolean;
    toolName?: string | null;
  }
  export interface LivePhrase {
    /** 稳定阶段键：阶段变了才重置轮换。 */
    phase: string;
    /** 首项是规范句（读屏用），其余是同义句（视觉轮换用）。 */
    phrases: readonly string[];
  }
  export function livePhraseFor(signals: TailSignals): LivePhrase;
  export function phraseAt(phrases: readonly string[], seed: string, step: number): string;
  export function phraseHoldMs(seed: string, step: number): number;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { livePhraseFor, phraseAt, phraseHoldMs } from "../src/components/transcript/live-phrase";
import { t } from "../src/i18n/index.js";

const base = { working: true, streaming: false, approvals: 0, paused: false };

describe("livePhraseFor", () => {
	it("puts a paused session first", () => {
		expect(livePhraseFor({ ...base, paused: true, approvals: 2, toolName: "bash" }).phase).toBe("paused");
	});
	it("puts a pending approval above tool activity", () => {
		expect(livePhraseFor({ ...base, approvals: 1, toolName: "bash" }).phase).toBe("awaiting");
	});
	it("puts a streaming reply above tool activity", () => {
		expect(livePhraseFor({ ...base, streaming: true, toolName: "bash" }).phase).toBe("reply");
	});
	it("classifies a running tool by its activity kind", () => {
		expect(livePhraseFor({ ...base, toolName: "grep" }).phase).toBe("tool:searching");
		expect(livePhraseFor({ ...base, toolName: "read" }).phase).toBe("tool:reading");
	});
	it("falls back to thinking when working without a tool", () => {
		expect(livePhraseFor(base).phase).toBe("thinking");
	});
	it("leads with the canonical phrase and offers alternates", () => {
		const phrase = livePhraseFor({ ...base, toolName: "grep" });
		expect(phrase.phrases[0]).toBe(t("transcript.phaseSearching"));
		expect(phrase.phrases.length).toBeGreaterThan(1);
	});
});

describe("phraseAt", () => {
	const pool = ["A", "B", "C"];
	it("returns the canonical phrase at step 0", () => {
		expect(phraseAt(pool, "seed", 0)).toBe("A");
	});
	it("is deterministic for the same seed and step", () => {
		expect(phraseAt(pool, "seed", 3)).toBe(phraseAt(pool, "seed", 3));
	});
	it("never repeats the previous phrase", () => {
		for (let step = 1; step < 12; step++) {
			expect(phraseAt(pool, "seed", step)).not.toBe(phraseAt(pool, "seed", step - 1));
		}
	});
	it("returns an empty string for an empty pool", () => {
		expect(phraseAt([], "seed", 2)).toBe("");
	});
});

describe("phraseHoldMs", () => {
	it("holds each phrase between 4 and 6 seconds", () => {
		for (let step = 0; step < 20; step++) {
			const hold = phraseHoldMs("seed", step);
			expect(hold).toBeGreaterThanOrEqual(4000);
			expect(hold).toBeLessThanOrEqual(6000);
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/client-core && bun test test/live-phrase.test.ts`
Expected: FAIL — `Cannot find module "../src/components/transcript/live-phrase"`。

- [ ] **Step 3: Implement `live-phrase.ts`**

`livePhraseFor` 按 paused → awaiting → reply → tool → thinking 的顺序判定，`tool` 阶段用 `toolActivityKind` 拼成 `tool:${kind}`，并通过一张 `kind → 键数组` 表取规范句与同义句。`phraseAt` 用 FNV-1a 对 `${seed}|${index}` 哈希排序其余同义句，`step` 在「排序后的同义句 + 规范句」这个环上取模。`phraseHoldMs` 返回 `4000 + (hash(`${seed}#${step}`) % 2001)`。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/client-core && bun test test/live-phrase.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src/components/transcript/live-phrase.ts packages/client-core/test/live-phrase.test.ts
git commit -m "feat: 尾部在场行的文案轮换引擎"
```

---

### Task 4: `TailPresence` 组件与样式

**Files:**
- Create: `packages/client-core/src/components/transcript/TailPresence.tsx`
- Modify: `packages/client-core/src/components/transcript/transcript.css`（`tr-working` 区块之后追加）
- Test: `packages/client-core/test/tail-presence.test.tsx`

**Interfaces:**
- Consumes: `LivePhrase`、`phraseAt`、`phraseHoldMs`（Task 3）；`useWorkingNow`、`useCollapseHeight`、`collapseStyle`。
- Produces:
  ```tsx
  export function TailPresence(props: {
    avatar?: ReactNode;
    visible: boolean;
    phrase: LivePhrase;
    seed: string;
    since?: number;
    quietMs?: number;
    detail?: ReactNode;
    detailLabel?: string;
    className?: string;
  }): ReactNode;
  ```

- [ ] **Step 1: Write the failing test**

```tsx
import { afterAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";
import { TailPresence } from "../src/components/transcript/TailPresence";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const phrase = { phase: "tool:searching", phrases: ["正在四处查找", "正在缩小范围"] };

function render(overrides: Partial<Parameters<typeof TailPresence>[0]> = {}) {
	return renderToStaticMarkup(
		<TailPresence visible phrase={phrase} seed="s1" since={Date.now() - 12_000} {...overrides} />,
	);
}

describe("TailPresence", () => {
	it("renders nothing when not visible", () => {
		expect(render({ visible: false })).toBe("");
	});
	it("renders the canonical phrase in the visible slot and the sheen copy", () => {
		const html = render();
		expect(html).toContain("正在四处查找");
		expect(html).toContain("presence-band");
	});
	it("keeps the phrase single-line with ellipsis", () => {
		expect(render()).toContain("presence-phrase");
	});
	it("marks the animated copy aria-hidden and exposes one live region", () => {
		const html = render();
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain('role="status"');
		expect(html.match(/role="status"/g)?.length).toBe(1);
	});
	it("renders the avatar only when one is supplied", () => {
		expect(render()).not.toContain("presence-avatar");
		expect(render({ avatar: <span>orb</span> })).toContain("presence-avatar");
	});
	it("is a toggle button only when a detail is supplied", () => {
		expect(render()).not.toContain("presence-toggle");
		const withDetail = render({ detail: <span>rows</span>, detailLabel: "这一轮正在做什么" });
		expect(withDetail).toContain("presence-toggle");
		expect(withDetail).toContain('aria-expanded="false"');
	});
	it("shows the quiet note only past the threshold", () => {
		expect(render({ quietMs: 10_000 })).not.toContain("presence-quiet");
		expect(render({ quietMs: 45_000 })).toContain("presence-quiet");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/client-core && bun test test/tail-presence.test.tsx`
Expected: FAIL — module not found。

- [ ] **Step 3: Implement `TailPresence.tsx`**

结构：外层 `.presence`（`visible` 为假时返回 `null`）→ 可选 `.presence-avatar` → `.presence-toggle`（有 `detail` 时是 `<button aria-expanded aria-controls aria-describedby>`，否则是 `<span>`）→ `.presence-phrase`（单行截断的规范句）→ `.presence-sheen`（`aria-hidden`，内含 `.presence-band[data-text]`）→ `.presence-sep` + 计时（`useWorkingNow`）→ 条件 `.presence-quiet` → 视觉隐藏的 live region（只装规范句，`key={phrase.phase}` 使其只在阶段变化时更新）→ `detail` 存在时 `.presence-detail` 用 `useCollapseHeight(open, ref)` + `collapseStyle(open)`。

轮换用 `useEffect` + `setTimeout(phraseHoldMs(seed + "|" + phase, step))`，阶段变化时 `step` 归零；`--presence-sheen-delay` 用 `-${Date.now() % 2200}ms` 初始化（每行错开相位）。

- [ ] **Step 4: Add the CSS**

在 `transcript.css` 追加 `.presence`、`.presence-avatar`、`.presence-toggle`、`.presence-phrase`、`.presence-sheen`、`.presence-band`、`.presence-band::before`、`.presence-sep`、`.presence-timer`、`.presence-quiet`、`.presence-detail`，以及两条关键帧 `presence-band` / `presence-bright`——**逐字采用 spec §3 的代码块**（`steps(12, jump-none)`、`35%` 停顿、反向位移）。末尾加 `@media (prefers-reduced-motion: reduce)` 与 `.gui-motion-off` 两条：`.presence-band { display: none; }`。字号 13.5px、行高 22px、计时 12px `tabular-nums`、行高预留 36px。

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/client-core && bun test test/tail-presence.test.tsx`
Expected: PASS。

- [ ] **Step 5a: Pin the two layout failure modes (Review Focus 1 & 2)**

追加两条测试：

```tsx
	it("keeps a very long phrase in one line with ellipsis", () => {
		const long = { phase: "tool:reading", phrases: ["正在读取 " + "a/".repeat(80) + "file.ts"] };
		const html = renderToStaticMarkup(
			<TailPresence visible phrase={long} seed="s1" since={Date.now()} />,
		);
		// 单行截断由样式契约保证：nowrap + ellipsis 必须落在文案槽上。
		expect(html).toContain("presence-phrase");
		expect(html).not.toContain("presence-phrase-wrapped");
	});

	it("still renders avatar and timer when the phrase is long", () => {
		const long = { phase: "tool:reading", phrases: ["正在读取 " + "a/".repeat(80)] };
		const html = renderToStaticMarkup(
			<TailPresence visible phrase={long} seed="s1" since={Date.now()} avatar={<span>orb</span>} />,
		);
		expect(html).toContain("presence-avatar");
		expect(html).toContain("presence-timer");
	});
```

同时在第 4 步的 CSS 里确认 `.presence-phrase` 带 `white-space: nowrap`、`overflow: hidden`、`text-overflow: ellipsis`，`.presence` 带 `min-width: 0` 且头像与计时 `flex: 0 0 auto`——否则长文案会把计时挤出行外。

Run: `cd packages/client-core && bun test test/tail-presence.test.tsx`
Expected: PASS。

- [ ] **Step 5b: Pin the rotation-reset failure mode (Review Focus 3)**

追加一条：同一组件实例连续两次改变 `phrase.phase`，断言渲染出的文案始终只有一个可见副本（`.presence-phrase` 出现 1 次），且 live region 内容等于新阶段的规范句。

Run: `cd packages/client-core && bun test test/tail-presence.test.tsx`
Expected: PASS。

- [ ] **Step 5c: Pin the two-transcript phase offset (Review Focus 4)**

追加一条：渲染两个 `TailPresence`，断言两者的 `.presence-band` 都写出了格式合法的 `--presence-sheen-delay`（`-<n>ms`）。`renderToStaticMarkup` 的两次调用可能落在同一毫秒、delay 相等，所以只断言格式；相位真正错开的验证放在 Task 8 Step 5 的真机检查里。

Run: `cd packages/client-core && bun test test/tail-presence.test.tsx`
Expected: PASS。

- [ ] **Step 6: Verify the sheen leaves the glyphs still**

在 `packages/client-core/test/tail-presence.test.tsx` 追加一条**样式契约**断言：用 `readFileSync` 读 `transcript.css`，断言 `presence-band` 与 `presence-bright` 两个关键帧都存在，且各自的 `translateX` 起点符号相反（一个 `-70%`、一个 `70%`）。

这条测试值得写在组件测试文件里，因为它守的是「文字必须不动」这条唯一不可退让的正确性条件——`TailPresence` 自己的 DOM 断言看不出位移方向，只有样式源能。任何人日后把反向位移改成同向，这条测试立刻红。

Run: `cd packages/client-core && bun test test/tail-presence.test.tsx`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add packages/client-core/src/components/transcript/TailPresence.tsx packages/client-core/src/components/transcript/transcript.css packages/client-core/test/tail-presence.test.tsx
git commit -m "feat: 尾部在场行组件与扫光样式"
```

---

### Task 5: 接入 `Transcript`

**Files:**
- Modify: `packages/client-core/src/components/transcript/Transcript.tsx`（props 约 236 行附近；渲染约 3101-3106 行；`tailTools` 约 2652 行）
- Test: `packages/client-core/test/transcript.test.tsx`（改 954-983 的两个既有断言）

**Interfaces:**
- Consumes: `TailPresence`（Task 4）、`livePhraseFor`（Task 3）。
- Produces: `Transcript` 新增四个可选 props：`tailAvatar?: ReactNode`、`tailDetail?: ReactNode`、`approvals?: number`、`paused?: boolean`。

  后两个必须新增：`Transcript` 当前只接收 `working` / `stream` / `activeTools`，**没有** `approvals` 与 `paused`（已核实 props 列表与 `packages/client-core/src/app.tsx`）。不传时默认 `0` / `false`，此时 `livePhraseFor` 的 `awaiting` 与 `paused` 阶段不可达，行为退化为「按工具分类 + thinking」，移动端无需改动即可编译。

- [ ] **Step 1: Write the failing test**

在 `packages/client-core/test/transcript.test.tsx` 的 `describe("Transcript work-timer round anchoring")` 内改两条既有断言，并新增一条：

```ts
	it("keeps the live ticker off the previous round's message while the model is responding", () => {
		const html = renderTranscript({
			entries: [assistantEntry({ timestamp: 100 }), userEntry(200)],
			working: true,
		});
		expect(countElements(html, ".tr-ghost-working")).toBe(1);
		expect(countElements(html, ".presence")).toBe(1);
	});

	it("mounts the ticker inside the current round's assistant message once it exists", () => {
		const html = renderTranscript({
			entries: [userEntry(200), assistantEntry({ timestamp: 300 })],
			working: true,
		});
		expect(countElements(html, ".tr-ghost-working")).toBe(0);
		expect(countElements(html, ".presence")).toBe(0);
		expect(countElements(html, ".tr-working")).toBe(1);
	});

	it("renders the tail presence without an avatar or detail when the host supplies none", () => {
		const html = renderTranscript({
			entries: [userEntry(200)],
			working: true,
			activeTools: new Map([[TOOL_CALL_ID, activeTool()]]),
		});
		expect(countElements(html, ".presence")).toBe(1);
		expect(countElements(html, ".presence-avatar")).toBe(0);
		expect(countElements(html, ".presence-toggle")).toBe(0);
	});

	it("drops the tail presence the moment a reply starts streaming (Review Focus 5)", () => {
		// 流式开始：尾部行退场，计时只在回复下方出现一次。
		const html = renderTranscript({
			entries: [userEntry(200)],
			working: true,
			streaming: true,
		});
		expect(countElements(html, ".presence")).toBe(0);
		expect(countElements(html, ".tr-working")).toBe(1);
	});
```

`renderTranscript` 需要新增 `streaming?: boolean` 参数，并在调用 `Transcript` 时传一个最小的 `stream` 对象（`stream={props.streaming ? streamMessage() : null}`、`streamDone={!props.streaming}`）；`streamMessage()` 复用文件内已有的 assistant 夹具构造，内容为 `[{ type: "text", text: "…" }]`。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/client-core && bun test test/transcript.test.tsx`
Expected: FAIL — `.presence` 计数为 0。

- [ ] **Step 3: Wire it up**

`renderTranscript` 辅助函数加 `tailAvatar` / `tailDetail` / `approvals` / `paused` 透传。`Transcript` 的 props 加这四个可选字段（`approvals` 默认 `0`、`paused` 默认 `false`）。在 3101-3106 的 `tr-ghost-working` 分支内，保留外层 `<div className="tr-ghost-working">`（既有测试与 CSS 依赖它），把其中的 `<WorkingLine>` 换成 `<TailPresence>`：

```tsx
<TailPresence
  visible={working}
  phrase={livePhraseFor({
    working,
    streaming: stream !== null,
    approvals: approvals ?? 0,
    paused: paused ?? false,
    toolName: tailTools.at(-1)?.toolName,
  })}
  seed={sessionKey ?? ""}
  since={lastUserTs}
  quietMs={quietMsOf(entries)}
  avatar={tailAvatar}
  detail={tailDetail}
  detailLabel={t("transcript.presenceDetailLabel")}
/>
```

`quietMsOf(entries)` 是同一文件内的小函数：取最后一条条目的 `entryStartMs`，返回 `Date.now() - at`（无条目时返回 `undefined`）。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/client-core && bun test test/transcript.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src/components/transcript/Transcript.tsx packages/client-core/test/transcript.test.tsx
git commit -m "feat: 转录末尾渲染在场行"
```

---

### Task 6: 桌面端注入头像与展开内容

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx`（`Transcript` 调用处，约 3690-3800 行）
- Test: `apps/desktop/test/chat-view-agent-capsule.test.tsx`（既有文件，追加一条）

**Interfaces:**
- Consumes: `Transcript` 的 `tailAvatar` / `tailDetail`（Task 5）、`AgentAvatar`、`agentSignals`。
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

在 `apps/desktop/test/chat-view-agent-capsule.test.tsx` 追加一条：渲染 `ChatView` 的既有夹具，断言传给 `Transcript` 的 `tailAvatar` 非空且其 `props.size === 28`。

（不要断言 `.presence-avatar`：那是 `Transcript` 内部的 DOM，桌面测试的夹具不进入它的渲染树。测「宿主传了什么」而不是「共享层怎么画」。）

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && bun test test/chat-view-agent-capsule.test.tsx`
Expected: FAIL。

- [ ] **Step 3: Pass the props**

在 `ChatView` 的 `<Transcript>` 上补：

```tsx
tailAvatar={<AgentAvatar state={orb} size={28} signals={agentSignals} seed={store.sessionId} />}
tailDetail={tailDetailNode}
```

`tailDetailNode` 由本轮尚未渲染的运行中工具生成——复用 `Transcript` 已算出的 `tailTools` 等价信息（桌面端从 `snap.activeTools` 取），渲染「读取 N 个文件 · 运行 M 条命令」（`t("transcript.presenceSteps", { files, commands })`）加当前工具名一行，不新造数据管线。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && bun test test/chat-view-agent-capsule.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/ChatView.tsx apps/desktop/test/chat-view-agent-capsule.test.tsx
git commit -m "feat(desktop): 尾部在场行注入头像与本轮工具摘要"
```

---

### Task 7: 文档与 CHANGELOG

**Files:**
- Modify: `docs/gui-design.md`、`docs/gui-design.zh-CN.md`（§3a 状态转场之后追加一段）
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`（`[Unreleased]` → `### 新功能` 顶部）

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Add the design note (both locales)**

在 `docs/gui-design.md` 与 `docs/gui-design.zh-CN.md` 各加一段，说明：转录尾部在场行的三条规则（文字不动、永远单行、不报错）、`TailPresence` 是唯一实现、宿主通过 `tailAvatar` / `tailDetail` 注入，以及「扫光必须是遮罩窗口 + 反向副本」这条不可退让的约束。

- [ ] **Step 2: Add the changelog entry**

在 `packages/coding-agent/CHANGELOG.musepi.md` 的 `[Unreleased]` → `### 新功能` 顶部加一条，中文一段 + 紧随一行 `  - EN: ...` 英文翻译。内容：会话工作时转录末尾显示头像、轮换状态文案与计时，长静默只说「暂无新输出」，点开可看本轮工具摘要。

- [ ] **Step 3: Run the doc gates**

Run: `bun run check:docs && bun test scripts/check-changelog-i18n.test.ts`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add docs/gui-design.md docs/gui-design.zh-CN.md packages/coding-agent/CHANGELOG.musepi.md
git commit -m "docs: 尾部在场行的设计说明与更新日志"
```

---

### Task 8: 整体验证

**Files:** 无新增。

- [ ] **Step 1: Type and lint the two packages**

Run: `cd packages/client-core && bun run check && cd ../../apps/desktop && bun run check`
Expected: 均通过。

- [ ] **Step 2: Run the repository checks**

Run: `bun check`
Expected: 通过（若 `check:rs` 因环境缺 Rust 工具链失败，记录为环境限制，与本次改动无关）。

- [ ] **Step 3: Run the affected test suites**

Run: `cd packages/client-core && bun test test/tool-activity.test.ts test/live-phrase.test.ts test/tail-presence.test.tsx test/transcript.test.tsx`
Expected: 全绿。

- [ ] **Step 4: Exercise the real surface**

启动桌面端，跑一轮至少含「读文件 → 跑命令」的回合，逐条确认：文案随工具切换；计时不因切换会话重置；把窗口收窄到 400px 文案以省略号截断且不出现横向滚动；停手 45 秒后出现「暂无新输出」；点文案区展开工具摘要、Esc 折叠并回焦；关闭动效后扫光消失；开始流式回复时这一行退场且计时只出现一次。

- [ ] **Step 5: Confirm the sheen does not move the glyphs**

在运行中的窗口里用开发者工具选中 `.presence-band::before`，确认 `translateX` 与 `.presence-band` 方向相反、且两者合成后的屏幕位置恒定（这是 spec 里唯一不可退让的正确性条件）。

- [ ] **Step 6: Report**

列出改动文件、验证命令与结果、未能验证的平台行为（若有），以及创建的提交。
