import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import "@lobehub/icons";
import { afterAll, describe, expect, test } from "bun:test";
import { hasDesignSystemContent, MarketplaceCard, setLocale, t } from "@musepi/client-core";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { CapabilityCenterPage } from "../src/components/CapabilityCenterPage";
import { DesignSystemRail, OPEN_CAPABILITY_EVENT } from "../src/components/composer/design-system-rail";
import { type DesignSystemEntry, useDesignSystems } from "../src/components/composer/use-design-systems";
import type { RpcClient } from "../src/lib/rpc";

/**
 * M3.7d GUI 路契约（docs/review/0.5.0-m3-mode-page-redesign.md §3.2 末段与
 * §6 3.7d 验收行「能力中心可安装设计体系包并即见」）：
 *
 * 1. ＋市场卡：设计体系 rail 排尾追加 dashed 入口卡（结构从属卡片排：
 *    同 120×72 基类、同入场 stagger），DOM 顺序恒为行内最后一个子元素，
 *    且不进 radiogroup（a11y：radiogroup 只含 role=radio）。
 * 2. 跳转：点击 dispatch 宿主既有 `omp-open-capability` 事件，detail.tab =
 *    "marketplace"（app.tsx 监听落能力中心市场 tab；ExtensionsCenter CTA
 *    同款通道，无 detail 的旧调用方行为不变——本测试钉 detail 载荷）。
 * 3. 能力中心落地 tab：CapabilityCenterPage initialTab="marketplace" 时
 *    市场 tab 选中（含市场网格挂载，数据源 marketplace.list）。
 * 4. 内容标识：marketplace 目录条目以 category/tags 声明 design-system
 *    （大小写不敏感、kebab/空格同义）→ 能力中心市场卡渲染「设计体系」
 *    徽章；普通包不渲染；纯函数 hasDesignSystemContent 钉判定边界。
 * 5. 即见（GUI 侧）：chat 面常驻挂载（display:none 不卸载），装包返回后
 *    rail 靠 daemon 的 extensions.changed 广播重拉 design.systems.list；
 *    无关事件不重拉。
 */

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

const SYSTEMS: DesignSystemEntry[] = [
	{
		id: "minimal",
		label: "极简留白",
		description: "Neutral Minimal — 中性灰阶、大留白。",
		swatches: ["#1c1c1f", "#6b6b70", "#d4d4d8", "#f5f5f6"],
		tokens: { "--bg": "#fafafa" },
		source: "builtin",
	},
	{
		id: "acme-brand",
		label: "Acme Brand",
		description: "Extension-registered Acme corporate design system.",
		swatches: ["#003366", "#336699", "#6699cc", "#ffffff"],
		tokens: { "--bg": "#ffffff" },
		source: "extension",
	},
];

function renderRail(): ReturnType<typeof createRoot> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	act(() => {
		root.render(createElement(DesignSystemRail, { systems: SYSTEMS, selected: null, onPick: () => {} }));
	});
	return root;
}

async function settle(ms = 30): Promise<void> {
	await act(async () => {
		await new Promise(r => setTimeout(r, ms));
	});
}

function marketCard(): HTMLButtonElement {
	const card = document.body.querySelector<HTMLButtonElement>("[data-testid='gui-ds-market-card']");
	expect(card).not.toBeNull();
	return card!;
}

describe("M3.7d ＋市场卡（rail 排尾 + 跳能力中心市场 tab）", () => {
	test("市场卡在 rail 行内 DOM 顺序恒为最后，且不进 radiogroup", () => {
		const root = renderRail();
		const row = document.body.querySelector<HTMLElement>(".gui-ds-rail-row")!;
		expect(row).not.toBeNull();
		// 行内最后子元素 = ＋市场卡（在体系卡组之后）。
		expect(row.lastElementChild).toBe(marketCard());
		// 结构从属卡片排：同基类（几何/入场 stagger），视觉从属：dashed 修饰。
		expect(marketCard().classList.contains("gui-ds-card")).toBe(true);
		expect(marketCard().classList.contains("gui-ds-market-card")).toBe(true);
		// 单选语义：radiogroup 只含体系卡（role=radio），市场卡在外层。
		const group = row.querySelector<HTMLElement>("[role='radiogroup']")!;
		expect(group).not.toBeNull();
		expect(group.querySelectorAll("[role='radio']")).toHaveLength(SYSTEMS.length);
		expect(group.contains(marketCard())).toBe(false);
		// 文案 + aria。
		expect(marketCard().textContent).toContain(t("design system market cta"));
		expect(marketCard().getAttribute("aria-label")).toBe(t("design system market aria"));
		root.unmount();
		document.body.innerHTML = "";
	});

	test("点击 dispatch omp-open-capability 事件（detail.tab = marketplace）", () => {
		const root = renderRail();
		const events: Event[] = [];
		const onEvent = (e: Event): void => {
			events.push(e);
		};
		window.addEventListener(OPEN_CAPABILITY_EVENT, onEvent);
		try {
			act(() => {
				marketCard().click();
			});
		} finally {
			window.removeEventListener(OPEN_CAPABILITY_EVENT, onEvent);
		}
		expect(events).toHaveLength(1);
		expect((events[0] as CustomEvent<{ tab?: string }>).detail?.tab).toBe("marketplace");
		root.unmount();
		document.body.innerHTML = "";
	});
});

describe("M3.7d 能力中心落地 tab", () => {
	function makeRpc(calls: string[]): RpcClient {
		return {
			request: (method: string): Promise<unknown> => {
				calls.push(method);
				if (method === "marketplace.list") return Promise.resolve({ entries: [] });
				if (method === "skills.list") return Promise.resolve({ skills: [] });
				return Promise.resolve({});
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
	}

	test("initialTab=marketplace：市场 tab 选中且市场网格挂载", async () => {
		const calls: string[] = [];
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		act(() => {
			root.render(
				createElement(CapabilityCenterPage, { rpc: makeRpc(calls), onBack: () => {}, initialTab: "marketplace" }),
			);
		});
		await settle();
		const tabs = [...document.body.querySelectorAll<HTMLButtonElement>(".gui-capability-tab")];
		const marketTab = tabs.find(b => b.textContent === t("marketplace"))!;
		expect(marketTab.getAttribute("aria-selected")).toBe("true");
		// 市场网格挂载 = 数据源走 marketplace.list（发现面即能力中心的安装通路）。
		expect(calls).toContain("marketplace.list");
		root.unmount();
		document.body.innerHTML = "";
	});
});

describe("M3.7d 设计体系内容标识（能力中心市场卡徽章）", () => {
	test("hasDesignSystemContent：category/tags 声明即命中，大小写与连字符同义", () => {
		// 声明形态：category 精确 design-system。
		expect(hasDesignSystemContent({ category: "design-system" })).toBe(true);
		// 声明形态：tags 携带（kebab/空格/下划线/无连字符，大小写不敏感）。
		expect(hasDesignSystemContent({ category: "design", tags: ["Design-System"] })).toBe(true);
		expect(hasDesignSystemContent({ tags: ["Design System"] })).toBe(true);
		expect(hasDesignSystemContent({ tags: ["design_system"] })).toBe(true);
		expect(hasDesignSystemContent({ tags: ["designsystem"] })).toBe(true);
		// 负例：design 大类 ≠ 设计体系包（图标/UI 工具包同类别，不误标）。
		expect(hasDesignSystemContent({ category: "design" })).toBe(false);
		expect(hasDesignSystemContent({ category: "Design" })).toBe(false);
		expect(hasDesignSystemContent({})).toBe(false);
		expect(hasDesignSystemContent({ category: "productivity", tags: ["theme", "ui"] })).toBe(false);
	});

	test("市场卡：设计体系包渲染徽章，普通包不渲染", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const dsEntry = { name: "acme-ds-pack", marketplace: "default", tags: ["design-system"] };
		const plainEntry = { name: "pdf-toolkit", marketplace: "default", category: "productivity" };
		act(() => {
			root.render(
				createElement("div", null, [
					createElement(MarketplaceCard, { key: "ds", entry: dsEntry }),
					createElement(MarketplaceCard, { key: "plain", entry: plainEntry }),
				]),
			);
		});
		const cards = document.body.querySelectorAll<HTMLElement>(".mp-card");
		expect(cards).toHaveLength(2);
		const dsBadge = cards[0]!.querySelector(".mp-card-badge--ds");
		expect(dsBadge).not.toBeNull();
		expect(dsBadge!.textContent).toContain(t("mp badge design system"));
		expect(cards[1]!.querySelector(".mp-card-badge--ds")).toBeNull();
		root.unmount();
		document.body.innerHTML = "";
	});
});

describe("M3.7d 即见：装包后 extensions.changed 驱动 rail 数据源重拉", () => {
	/** 顺序返回两组列表的 rpc 桩 + 事件触发器（addEventListener 捕获 handler）。 */
	function makeSeqRpc(calls: string[], seq: DesignSystemEntry[][]): { rpc: RpcClient; fire(e: unknown): void } {
		let listen: ((event: unknown) => void) | null = null;
		let n = 0;
		const rpc = {
			request: (method: string): Promise<unknown> => {
				calls.push(method);
				if (method === "design.systems.list") {
					const systems = seq[Math.min(n, seq.length - 1)]!;
					n += 1;
					return Promise.resolve({ systems });
				}
				return Promise.resolve({});
			},
			addEventListener: (handler: (event: unknown) => void): (() => void) => {
				listen = handler;
				return () => {
					listen = null;
				};
			},
		} as unknown as RpcClient;
		return { rpc, fire: e => listen?.(e) };
	}

	function Harness({ rpc }: { rpc: RpcClient }): ReactNode {
		const systems = useDesignSystems(rpc);
		return createElement("span", { "data-testid": "ds-count" }, String(systems.length));
	}

	async function renderHarness(rpc: RpcClient): Promise<ReturnType<typeof createRoot>> {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		await act(async () => {
			root.render(createElement(Harness, { rpc }));
		});
		return root;
	}

	const countText = (): string => document.body.querySelector<HTMLElement>("[data-testid='ds-count']")!.textContent!;

	test("extensions.changed 广播 → 重拉 design.systems.list（装包返回即见新体系）", async () => {
		const calls: string[] = [];
		const { rpc, fire } = makeSeqRpc(calls, [SYSTEMS.slice(0, 1), SYSTEMS]);
		const root = await renderHarness(rpc);
		await settle();
		expect(countText()).toBe("1");
		expect(calls.filter(m => m === "design.systems.list")).toHaveLength(1);
		// 装包完成后 daemon 广播扩展面变更 → 数据源重拉，新体系并入列表。
		await act(async () => {
			fire({ payload: { type: "extensions.changed" } });
			await Promise.resolve();
		});
		await settle();
		expect(calls.filter(m => m === "design.systems.list")).toHaveLength(2);
		expect(countText()).toBe("2");
		root.unmount();
		document.body.innerHTML = "";
	});

	test("无关事件不重拉（只认 extensions.changed 类型）", async () => {
		const calls: string[] = [];
		const { rpc, fire } = makeSeqRpc(calls, [SYSTEMS.slice(0, 1), SYSTEMS]);
		const root = await renderHarness(rpc);
		await settle();
		await act(async () => {
			fire({ payload: { type: "modes.changed" } });
			await Promise.resolve();
		});
		await settle();
		expect(calls.filter(m => m === "design.systems.list")).toHaveLength(1);
		root.unmount();
		document.body.innerHTML = "";
	});
});
