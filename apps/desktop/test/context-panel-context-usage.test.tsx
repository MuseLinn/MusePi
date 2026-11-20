import "./happy-dom-shim"; // MUST be first: component modules define DOM classes at evaluation time.
import { describe, expect, it } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import type { SessionEntry } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextPanel } from "../src/components/ContextPanel";
import type { RpcClient } from "../src/lib/rpc";
import type { GuiSessionState } from "../src/lib/session-store";
import type { UsePanelTabsResult } from "../src/lib/use-panel-tabs";

// context surface 契约:上下文卡片、按角色计数的统计卡、会话总计与最近助手消息的
// token 表、倒序原始消息列表都来自 snap.entries 里助手消息的 usage 与 message;
// cwd / 模型 / 模式三行、复制路径与会话维护区块不再出现在这个面板里(它们属于
// 标题栏与信息卡)。

setLocale("en-US");

const contextPanelTabs: UsePanelTabsResult = {
	tabs: [
		{
			id: "context::",
			surface: "context",
			target: null,
			label: "Context",
			readOnly: false,
			touchedAt: 1,
			dedupeKey: null,
			dirty: false,
			column: 0,
		},
	],
	activeId: "context::",
	split: false,
	columnActive: ["context::", null],
	open: () => {},
	close: () => {},
	closeMany: () => {},
	duplicate: () => {},
	activate: () => {},
	reorder: () => {},
	moveToColumn: () => {},
	setSplit: () => {},
	setDirty: () => {},
};

const rpc = { request: async () => null, addEventListener: () => () => {} } as unknown as RpcClient;

let nextMessageId = 1;

function assistant(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}): SessionEntry {
	return {
		type: "message",
		id: `m${nextMessageId++}`,
		message: {
			role: "assistant",
			content: [],
			model: "provider/model",
			usage: { ...usage, cost: { total: usage.cost } },
			stopReason: "stop",
			timestamp: 1,
		},
		timestamp: "2026-01-01T00:00:00.000Z",
	} as unknown as SessionEntry;
}

function user(text: string): SessionEntry {
	return {
		type: "message",
		id: `m${nextMessageId++}`,
		message: { role: "user", content: text, timestamp: 2 },
		timestamp: "2026-01-01T00:00:01.000Z",
	} as unknown as SessionEntry;
}

function snapshot(entries: readonly SessionEntry[], sessionId: string | null = "s1"): GuiSessionState {
	return {
		sessionId,
		entries,
		state: { cwd: "C:/workspace", model: { id: "provider/model" } } as unknown as GuiSessionState["state"],
		streaming: false,
		activeTools: new Map(),
		working: false,
		cursor: 0,
		agents: [],
		progress: new Map(),
		lifecycle: new Map(),
		unviewedCompleted: [],
		approvals: [],
		recap: null,
		roundDurations: new Map(),
	} as unknown as GuiSessionState;
}

function mount(entries: readonly SessionEntry[], sessionId: string | null = "s1"): { host: HTMLElement; root: Root } {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	act(() => {
		root.render(
			<ContextPanel
				snap={snapshot(entries, sessionId)}
				rpc={rpc}
				onViewChange={() => {}}
				panelTabs={contextPanelTabs}
				agentId={null}
				onAgentSelect={() => {}}
			/>,
		);
	});
	return { host, root };
}

function render(entries: readonly SessionEntry[], sessionId: string | null = "s1"): string {
	const { host, root } = mount(entries, sessionId);
	const html = host.innerHTML;
	act(() => root.unmount());
	host.remove();
	return html;
}

describe("ContextPanel context 视图", () => {
	it("按助手消息 usage 汇总 token 分桶与缓存命中率", () => {
		const html = render([
			assistant({ input: 1000, output: 400, cacheRead: 1000, cacheWrite: 200, totalTokens: 2600, cost: 0.25 }),
			assistant({ input: 500, output: 100, cacheRead: 1500, cacheWrite: 0, totalTokens: 2100, cost: 0.5 }),
		]);
		// 会话总计:input 1.5K / output 500 / cache read 2.5K / cache write 200
		expect(html).toContain(t("context.sessionTotals"));
		expect(html).toContain("1.5K");
		expect(html).toContain("2.5K");
		// cacheRead 2500 / (2500 + 1500) = 62.5%
		expect(html).toContain("62.5%");
		// 最近一条助手消息:cacheRead 1500 / (1500 + 500) = 75.0%
		expect(html).toContain(t("context.lastAssistantMessage"));
		expect(html).toContain("75.0%");
		expect(html).toContain(t("sessionInfo.input"));
		expect(html).toContain(t("sessionInfo.cacheHitRate"));
		expect(html).toContain("$0.750");
	});

	it("四张统计卡按角色计数,成本取助手消息 usage 之和", () => {
		const { host, root } = mount([
			user("hello"),
			assistant({ input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: 0.25 }),
		]);
		const values = [...host.querySelectorAll(".gui-ctx-stat-v")].map(node => node.textContent);
		expect(values).toEqual(["2", "1", "1", "$0.250"]);
		const labels = [...host.querySelectorAll(".gui-ctx-stat-l")].map(node => node.textContent);
		expect(labels).toEqual([t("general.messages"), t("general.user"), t("general.assistant"), t("settings.cost")]);
		act(() => root.unmount());
		host.remove();
	});

	it("原始消息按时间倒序,行内带角色、token 与时间", () => {
		const { host, root } = mount([
			user("hello"),
			assistant({ input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 2600, cost: 0.25 }),
		]);
		const rows = [...host.querySelectorAll(".gui-ctx-raw-row")];
		expect(rows).toHaveLength(2);
		// 最新一条(助手)在前:token 总数来自 usage.totalTokens
		expect(rows[0]?.textContent).toContain(t("general.assistant"));
		expect(rows[0]?.textContent).toContain("2.6K");
		expect(rows[0]?.querySelectorAll("span")).toHaveLength(3);
		expect(rows[1]?.textContent).toContain(t("general.user"));
		expect(rows[1]?.textContent).toContain("—");
		act(() => root.unmount());
		host.remove();
	});

	it("原始消息行可展开为 JSON,并复制整条消息", async () => {
		const { host, root } = mount([
			assistant({ input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 2600, cost: 0.25 }),
		]);
		let copied = "";
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					copied = text;
				},
			},
		});
		await act(async () => {
			host.querySelector<HTMLButtonElement>(".gui-ctx-raw-expand")?.click();
		});
		expect(host.querySelector<HTMLButtonElement>(".gui-ctx-raw-expand")?.getAttribute("aria-expanded")).toBe("true");
		expect(host.querySelector(".gui-ctx-raw-json")?.textContent).toContain('"role": "assistant"');
		await act(async () => {
			host.querySelector<HTMLButtonElement>(".gui-ctx-raw-copy")?.click();
			await Bun.sleep(0);
		});
		expect(copied).toContain('"totalTokens": 2600');
		expect(host.querySelector(".gui-ctx-raw-copy")?.getAttribute("aria-label")).toBe(t("settings.copied"));
		act(() => root.unmount());
		host.remove();
	});

	it("不再重复标题栏的 cwd/模型/模式,也不带复制路径与会话维护", () => {
		const html = render([]);
		expect(html).not.toContain("C:/workspace");
		expect(html).not.toContain("provider/model");
		expect(html).not.toContain(t("general.copyWorkspacePath"));
		expect(html).not.toContain(t("tools.sessionMaintenance"));
		expect(html).not.toContain(t("tools.shakeContext"));
	});

	it("无会话时给出选择会话的空态,而不是一屏 0 统计", () => {
		const html = render([], null);
		expect(html).toContain(t("settings.selectSession"));
		expect(html).toContain(t("settings.contextEmptyHint"));
		expect(html).not.toContain(t("general.stats"));
	});
});
