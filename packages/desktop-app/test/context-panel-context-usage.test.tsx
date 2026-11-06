import "./dom-shim";
import { describe, expect, it } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import type { SessionEntry } from "@musepi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextPanel } from "../src/components/ContextPanel";
import type { RpcClient } from "../src/lib/rpc";
import type { GuiSessionState } from "../src/lib/session-store";
import type { UsePanelTabsResult } from "../src/lib/use-panel-tabs";

// context surface 收敛为「上下文用量」后的契约:token 分桶与缓存命中率来自
// snap.entries 里助手消息的 usage 求和;cwd / 模型 / 模式三行、复制路径与会话维护
// 区块不再出现在这个面板里(它们属于标题栏与信息卡)。

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

function render(entries: readonly SessionEntry[], sessionId: string | null = "s1"): string {
	return renderToStaticMarkup(
		<ContextPanel
			snap={snapshot(entries, sessionId)}
			rpc={rpc}
			onViewChange={() => {}}
			panelTabs={contextPanelTabs}
			agentId={null}
			onAgentSelect={() => {}}
		/>,
	);
}

describe("ContextPanel context 视图", () => {
	it("按助手消息 usage 汇总 token 分桶与缓存命中率", () => {
		const html = render([
			assistant({ input: 1000, output: 400, cacheRead: 1000, cacheWrite: 200, totalTokens: 2600, cost: 0.25 }),
			assistant({ input: 500, output: 100, cacheRead: 1500, cacheWrite: 0, totalTokens: 2100, cost: 0.5 }),
		]);
		// input 1.5K / output 0.5K / cache read 2.5K / cache write 200 / total 4.7K
		expect(html).toContain("1.5K");
		expect(html).toContain("2.5K");
		expect(html).toContain("4.7K");
		expect(html).toContain(t("sessionInfo.input"));
		expect(html).toContain(t("sessionInfo.cacheHitRate"));
		// cacheRead 2500 / (2500 + 1500) = 62.5%
		expect(html).toContain("62.5%");
		expect(html).toContain("$0.750");
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
