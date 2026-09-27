import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
// @lobehub/icons has an internal cycle (brand module ↔ providerConfig); importing
// the package entry first initializes providerConfig before the brand modules
// that reference it, avoiding the TDZ crash under bun's module evaluation order.
import "@lobehub/icons";
import { afterAll, describe, expect, test } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { CreationMessage } from "../src/components/CreationModeRow";
import { useSessionDesignSystem } from "../src/components/composer/use-session-design-system";
import { WelcomeComposer } from "../src/components/WelcomeComposer";
import type { RpcClient } from "../src/lib/rpc";

/**
 * M3.7b GUI 路契约（docs/review/0.5.0-m3-mode-page-redesign.md §3.3/§6 3.7b 行）：
 *
 * 1. 预览 rail：design armed 时渲染 120×72 卡横排（色卡条 + 体系名 + 内置/
 *    扩展徽章），数据源自 design.systems.list RPC；RPC 挂掉回退内置五套。
 * 2. 选中态同源：rail 卡选中 = accent 描边 + 勾选角标，且风格胶囊显示同一
 *    选中；点同一卡再选一次 = 取消（跟随既有）。
 * 3. 选中落盘：发送走 session.create 管线，metadata.designSystemId = 选中
 *    id；未选中保持 buildProjectMetadata 的 M3.1 占位（null）。
 * 4. hover 预览卡：rail 卡/菜单行 mouseenter 浮出预览卡（description 全文），
 *    mouseleave 经短桥接后消失。
 * 5. 会话内接线（useSessionDesignSystem）：初始值经 creation.metadata.get
 *    从会话头 projectMetadata 回读；pick 发 session.setDesignSystem
 *    （{ sessionId, designSystemId }，null = 清除）；读头失败静默为未选中。
 */

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

interface CapturedSubmit {
	metadata: Record<string, unknown>;
	message?: CreationMessage;
}

const captured: CapturedSubmit[] = [];

interface RpcCall {
	method: string;
	params: unknown;
}

/** design.systems.list 的测试条目：内置 + 扩展各一。 */
const LIST_SYSTEMS = [
	{
		id: "minimal",
		label: "极简留白",
		description: "Neutral Minimal — 中性灰阶、大留白。",
		swatches: ["#1c1c1f", "#6b6b70", "#d4d4d8", "#f5f5f6", "#ffffff", "#888888"],
		tokens: { "--bg": "#fafafa", "--fg": "#1c1c1f", "--radius": "6px" },
		promptSection: { name: "design-system", order: 40, text: "…" },
		templates: null,
		source: "builtin",
	},
	{
		id: "acme-brand",
		label: "Acme Brand",
		description: "Extension-registered Acme corporate design system.",
		swatches: ["#003366", "#336699", "#6699cc", "#ffffff", "#eeeeee", "#ffcc00"],
		tokens: { "--bg": "#ffffff", "--fg": "#003366" },
		promptSection: { name: "design-system", order: 40, text: "…" },
		templates: null,
		source: "extension",
	},
];

/** 可记录调用的 rpc 桩：listMode = ok(返回 LIST_SYSTEMS) | fail(拒绝)。 */
function makeRpc(calls: RpcCall[], listMode: "ok" | "fail" = "ok"): RpcClient {
	return {
		request: (method: string, params?: unknown): Promise<unknown> => {
			calls.push({ method, params });
			if (method === "design.systems.list") {
				return listMode === "ok"
					? Promise.resolve({ systems: LIST_SYSTEMS })
					: Promise.reject(new Error("unknown method: design.systems.list"));
			}
			if (method === "creation.templates.list") return Promise.resolve({ templates: [] });
			if (method === "creation.metadata.get") return Promise.resolve({ metadata: null });
			if (method === "git.branches") return Promise.resolve({ current: null, branches: [] });
			if (method === "models.listAvailable" || method === "models.list") return Promise.resolve([]);
			return Promise.resolve({});
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
}

function renderWelcome(rpc: RpcClient): ReturnType<typeof createRoot> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	act(() => {
		root.render(
			createElement(WelcomeComposer, {
				rpc,
				project: "C:\\proj",
				modes: [
					{ id: "work", label: "Work" },
					{ id: "design", label: "Design" },
				],
				modeId: "design",
				onModeChange: () => {},
				designSubmit: (metadata: Record<string, unknown>, message?: CreationMessage) => {
					captured.push({ metadata, message });
					return Promise.resolve(true);
				},
				onSubmit: () => {},
			}),
		);
	});
	return root;
}

/** 等 RPC 回填 + 短桥接计时器落地。 */
async function settle(ms = 40): Promise<void> {
	await act(async () => {
		await new Promise(r => setTimeout(r, ms));
	});
}

function railCards(): HTMLButtonElement[] {
	return [...document.body.querySelectorAll<HTMLButtonElement>(".gui-ds-card")];
}

function railCard(id: string): HTMLButtonElement {
	const card = railCards().find(c => c.dataset.designSystem === id);
	expect(card).toBeDefined();
	return card!;
}

/** 创作 chip 排按钮（类型 chip；sessionDraft 是 CreationModeRow 模块级
 *  缓存，跨测试文件共享——发送类用例先把 chip 归位到 prototype，保证
 *  metadata.kind 断言与文件执行顺序无关，离场时也把草稿留在默认态）。 */
function chipButton(label: string): HTMLButtonElement {
	const btn = [...document.body.querySelectorAll<HTMLButtonElement>(".gui-creation-chip")].find(
		b => b.textContent === label,
	);
	expect(btn).toBeDefined();
	return btn!;
}

/** happy-dom 下 React 19 合成 input 进不了 ChangeEventPlugin，照
 *  creation-mode-page.test.tsx 的手法直接驱动 textarea props.onChange。 */
async function typeAndSend(text: string): Promise<void> {
	const textarea = document.body.querySelector("textarea");
	expect(textarea).not.toBeNull();
	const propsKey = Object.keys(textarea!).find(k => k.startsWith("__reactProps$"))!;
	const props = (textarea as unknown as Record<string, { onChange(e: unknown): void }>)[propsKey]!;
	(textarea as HTMLTextAreaElement).value = text;
	act(() => {
		props.onChange({ target: textarea, currentTarget: textarea });
	});
	const sendBtn = document.body.querySelector<HTMLButtonElement>(".gui-send-btn");
	expect(sendBtn).not.toBeNull();
	act(() => {
		sendBtn!.click();
	});
	await act(async () => {
		await Promise.resolve();
	});
}

describe("M3.7b 预览 rail（欢迎页 design armed）", () => {
	test("rail 渲染色卡+名称+来源徽章，数据源自 design.systems.list", async () => {
		const calls: RpcCall[] = [];
		const root = renderWelcome(makeRpc(calls));
		await settle();
		expect(document.body.querySelector("[data-testid='gui-design-system-rail']")).not.toBeNull();
		expect(calls.some(c => c.method === "design.systems.list")).toBe(true);
		const cards = railCards();
		// 内置 + 扩展各一张（RPC 合并视图直渲染）。
		expect(cards.map(c => c.dataset.designSystem)).toEqual(["minimal", "acme-brand"]);
		expect(railCard("minimal").textContent).toContain(t("design system builtin"));
		expect(railCard("acme-brand").textContent).toContain(t("design system extension"));
		// 扩展体系用 RPC 原样 label；内置走 i18n 词表。
		expect(railCard("acme-brand").textContent).toContain("Acme Brand");
		expect(railCard("minimal").textContent).toContain(t("design style minimal"));
		// 色卡条：前 4 色拼接。
		const bars = railCard("minimal").querySelectorAll(".gui-ds-swatchbar--rail > span");
		expect(bars).toHaveLength(4);
		root.unmount();
		document.body.innerHTML = "";
	});

	test("rail 卡选中 = accent 描边 + 勾选角标，且与风格胶囊同源；再点取消", async () => {
		const root = renderWelcome(makeRpc([]));
		await settle();
		act(() => {
			railCard("minimal").click();
		});
		expect(railCard("minimal").classList.contains("gui-ds-card--on")).toBe(true);
		expect(railCard("minimal").querySelector(".gui-ds-card-check")).not.toBeNull();
		expect(railCard("acme-brand").classList.contains("gui-ds-card--on")).toBe(false);
		// 同源：胶囊按钮显示同一选中体系名。
		const pill = document.body.querySelector<HTMLButtonElement>(".gui-style-select-btn");
		expect(pill?.textContent).toContain(t("design style minimal"));
		// 再点同一卡 = 取消（跟随既有）。
		act(() => {
			railCard("minimal").click();
		});
		expect(railCard("minimal").classList.contains("gui-ds-card--on")).toBe(false);
		expect(document.body.querySelector(".gui-ds-card--on")).toBeNull();
		root.unmount();
		document.body.innerHTML = "";
	});

	test("选中体系落盘 projectMetadata.designSystemId；未选中保持 null 占位", async () => {
		captured.length = 0;
		const root = renderWelcome(makeRpc([]));
		await settle();
		// sessionDraft 跨文件共享：归位 prototype，kind 断言与执行顺序无关。
		act(() => {
			chipButton(t("creation tab prototype")).click();
		});
		// 未选中：M3.1 占位 null，buildProjectMetadata 形状不被破坏。
		await typeAndSend("做一个落地页");
		expect(captured).toHaveLength(1);
		expect(captured[0]!.metadata.designSystemId).toBeNull();
		// 选中后再发送：designSystemId = 选中 id。
		captured.length = 0;
		act(() => {
			railCard("acme-brand").click();
		});
		await typeAndSend("品牌官网首页");
		expect(captured).toHaveLength(1);
		expect(captured[0]!.metadata.designSystemId).toBe("acme-brand");
		expect(captured[0]!.metadata.kind).toBe("prototype");
		// 取消选中再发送：回到 null。
		captured.length = 0;
		act(() => {
			railCard("acme-brand").click();
		});
		await typeAndSend("再做一个");
		expect(captured).toHaveLength(1);
		expect(captured[0]!.metadata.designSystemId).toBeNull();
		root.unmount();
		document.body.innerHTML = "";
	});

	test("design.systems.list 不可用时回退内置五套（离线可用）", async () => {
		const root = renderWelcome(makeRpc([], "fail"));
		await settle();
		const cards = railCards();
		expect(cards.map(c => c.dataset.designSystem)).toEqual([
			"minimal",
			"glass",
			"editorial",
			"neubrutalism",
			"darkneon",
		]);
		expect(cards.every(c => c.textContent?.includes(t("design system builtin")))).toBe(true);
		root.unmount();
		document.body.innerHTML = "";
	});

	test("hover rail 卡浮出预览卡（description 全文），移出后消失", async () => {
		const root = renderWelcome(makeRpc([]));
		await settle();
		act(() => {
			railCard("acme-brand").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
		});
		await settle(30);
		const hover = document.body.querySelector(".gui-ds-hover");
		expect(hover).not.toBeNull();
		expect(hover!.textContent).toContain("Extension-registered Acme corporate design system.");
		expect(hover!.textContent).toContain("Acme Brand");
		// tokens 迷你 mock 出现（mini 按钮示意）。
		expect(hover!.querySelector(".gui-ds-mock-btn")).not.toBeNull();
		// 移出 → 短桥接（120ms）后隐藏。
		act(() => {
			railCard("acme-brand").dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
		});
		await settle(180);
		expect(document.body.querySelector(".gui-ds-hover")).toBeNull();
		root.unmount();
		document.body.innerHTML = "";
	});
});

describe("M3.7b 风格胶囊菜单", () => {
	test("菜单行 hover 浮出预览卡；Escape 归宿主浮动菜单关闭", async () => {
		const root = renderWelcome(makeRpc([]));
		await settle();
		const pill = document.body.querySelector<HTMLButtonElement>(".gui-style-select-btn")!;
		act(() => {
			pill.click();
		});
		await settle(30);
		const menu = document.body.querySelector<HTMLElement>(".gui-style-select-menu");
		expect(menu).not.toBeNull();
		const rows = [...menu!.querySelectorAll<HTMLButtonElement>(".gui-attach-opt")];
		// 跟随既有 + 内置/扩展体系行。
		expect(rows.length).toBe(3);
		act(() => {
			rows[2]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
		});
		await settle(30);
		const hover = document.body.querySelector(".gui-ds-hover");
		expect(hover).not.toBeNull();
		expect(hover!.textContent).toContain("Acme Brand");
		act(() => {
			rows[2]!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
		});
		await settle(180);
		expect(document.body.querySelector(".gui-ds-hover")).toBeNull();
		// 键盘契约：Escape 关闭菜单（useFloatingMenu 统一处理）。
		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		await settle(160);
		expect(document.body.querySelector(".gui-style-select-menu")).toBeNull();
		root.unmount();
		document.body.innerHTML = "";
	});

	test("菜单点选写选中态（与 rail 同源），跟随既有清除", async () => {
		const root = renderWelcome(makeRpc([]));
		await settle();
		const pill = document.body.querySelector<HTMLButtonElement>(".gui-style-select-btn")!;
		act(() => {
			pill.click();
		});
		await settle(30);
		const menu = document.body.querySelector<HTMLElement>(".gui-style-select-menu")!;
		const rows = [...menu.querySelectorAll<HTMLButtonElement>(".gui-attach-opt")];
		act(() => {
			rows[1]!.click(); // minimal
		});
		expect(railCard("minimal").classList.contains("gui-ds-card--on")).toBe(true);
		// 再开菜单点「跟随既有」→ 清除。
		act(() => {
			pill.click();
		});
		await settle(30);
		const menu2 = document.body.querySelector<HTMLElement>(".gui-style-select-menu")!;
		act(() => {
			menu2.querySelector<HTMLButtonElement>(".gui-attach-opt")!.click();
		});
		expect(document.body.querySelector(".gui-ds-card--on")).toBeNull();
		root.unmount();
		document.body.innerHTML = "";
	});
});

describe("M3.7b 会话内接线（useSessionDesignSystem）", () => {
	function Harness({ rpc, sessionId }: { rpc: RpcClient | null; sessionId: string }): ReactNode {
		const { designStyle, pickDesignStyle } = useSessionDesignSystem(rpc, sessionId, true);
		return createElement(
			"div",
			null,
			createElement("span", { "data-testid": "style" }, designStyle ?? "none"),
			createElement("button", { "data-testid": "pick", onClick: () => pickDesignStyle("minimal") }),
			createElement("button", { "data-testid": "clear", onClick: () => pickDesignStyle(null) }),
		);
	}

	function renderHarness(rpc: RpcClient | null, sessionId = "s1"): ReturnType<typeof createRoot> {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		act(() => {
			root.render(createElement(Harness, { rpc, sessionId }));
		});
		return root;
	}

	const styleText = (): string => document.body.querySelector<HTMLElement>("[data-testid='style']")!.textContent!;

	test("初始值经 creation.metadata.get 从会话头 projectMetadata 回读", async () => {
		const calls: RpcCall[] = [];
		const rpc = makeRpc(calls);
		// 覆盖 metadata.get：会话头里存了 glass。
		rpc.request = ((method: string, params?: unknown): Promise<unknown> => {
			calls.push({ method, params });
			if (method === "creation.metadata.get") return Promise.resolve({ metadata: { designSystemId: "glass" } });
			return Promise.resolve({});
		}) as RpcClient["request"];
		const root = renderHarness(rpc, "sess-a");
		await settle();
		const read = calls.find(c => c.method === "creation.metadata.get");
		expect(read?.params).toEqual({ sessionId: "sess-a" });
		expect(styleText()).toBe("glass");
		// pick 覆盖本地态。
		act(() => {
			document.body.querySelector<HTMLButtonElement>("[data-testid='pick']")!.click();
		});
		expect(styleText()).toBe("minimal");
		root.unmount();
		document.body.innerHTML = "";
	});

	test("pick 发 session.setDesignSystem（选中即写，null = 清除）", async () => {
		const calls: RpcCall[] = [];
		const root = renderHarness(makeRpc(calls), "sess-b");
		await settle();
		act(() => {
			document.body.querySelector<HTMLButtonElement>("[data-testid='pick']")!.click();
		});
		await settle();
		const write = calls.find(c => c.method === "session.setDesignSystem");
		expect(write?.params).toEqual({ sessionId: "sess-b", designSystemId: "minimal" });
		act(() => {
			document.body.querySelector<HTMLButtonElement>("[data-testid='clear']")!.click();
		});
		await settle();
		const writes = calls.filter(c => c.method === "session.setDesignSystem");
		expect(writes).toHaveLength(2);
		expect(writes[1]!.params).toEqual({ sessionId: "sess-b", designSystemId: null });
		expect(styleText()).toBe("none");
		root.unmount();
		document.body.innerHTML = "";
	});

	test("读头失败静默为未选中；rpc 缺失不发写", async () => {
		const calls: RpcCall[] = [];
		const failing = makeRpc(calls);
		failing.request = ((method: string, params?: unknown): Promise<unknown> => {
			calls.push({ method, params });
			if (method === "creation.metadata.get") return Promise.reject(new Error("no header"));
			return Promise.resolve({});
		}) as RpcClient["request"];
		const root = renderHarness(failing, "sess-c");
		await settle();
		expect(styleText()).toBe("none");
		root.unmount();
		document.body.innerHTML = "";
		// rpc = null：pick 静默（组件内不发 RPC 也不抛）。
		const root2 = renderHarness(null);
		await settle();
		act(() => {
			document.body.querySelector<HTMLButtonElement>("[data-testid='pick']")!.click();
		});
		expect(styleText()).toBe("minimal");
		expect(calls.filter(c => c.method === "session.setDesignSystem")).toHaveLength(0);
		root2.unmount();
		document.body.innerHTML = "";
	});
});
