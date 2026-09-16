import "./dom-shim";
import { describe, expect, it } from "bun:test";
import type { AgentSnapshot } from "@musepi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextPanel } from "../src/components/ContextPanel";
import type { RpcClient } from "../src/lib/rpc";
import type { GuiSessionState } from "../src/lib/session-store";
import type { UsePanelTabsResult } from "../src/lib/use-panel-tabs";

// 面板级 tab 状态替身（tab-primary 接线后 ContextPanel 从 panelTabs 派生 view，
// 不再收 view prop）：agents 视图只有在 agents tab 处于激活时才可达，所以替身
// 必须带上一个激活的 agents tab —— 空的 tabs 会渲染成零 tab 空态导航页。
const agentsPanelTabs: UsePanelTabsResult = {
	tabs: [
		{
			id: "agents::",
			surface: "agents",
			target: null,
			label: "Agents",
			readOnly: false,
			touchedAt: 1,
			dedupeKey: null,
			dirty: false,
		},
	],
	activeId: "agents::",
	open: () => {},
	close: () => {},
	closeMany: () => {},
	activate: () => {},
	reorder: () => {},
	setDirty: () => {},
};

// 右面板 agents 视图 SSR 冒烟:swarm 子 agent 的详情层必须渲染在面板内部(不是独立
// 浮层),且关着也保持挂载 —— 进出动效由 .gui-agent-dock--open 驱动,条件挂载会
// 让关闭没有过渡。

const rpc = { request: async () => null } as unknown as RpcClient;

function snapshot(agents: readonly AgentSnapshot[]): GuiSessionState {
	return {
		sessionId: "s1",
		entries: [],
		state: { cwd: "C:/workspace" } as unknown as GuiSessionState["state"],
		streaming: false,
		activeTools: new Map(),
		working: false,
		cursor: 0,
		agents,
		progress: new Map(),
		lifecycle: new Map(),
		unviewedCompleted: [],
		approvals: [],
		recap: null,
		roundDurations: new Map(),
	};
}

const scout: AgentSnapshot = {
	id: "a1",
	displayName: "scout",
	kind: "sub",
	status: "running",
	hasSessionFile: false,
	createdAt: 1,
	lastActivity: 2,
};

function render(agents: readonly AgentSnapshot[], agentId: string | null): string {
	return renderToStaticMarkup(
		<ContextPanel
			snap={snapshot(agents)}
			rpc={rpc}
			onViewChange={() => {}}
			panelTabs={agentsPanelTabs}
			agentId={agentId}
			onAgentSelect={() => {}}
		/>,
	);
}

describe("ContextPanel agents 视图", () => {
	it("渲染 roster,详情层始终在面板内部挂载", () => {
		const html = render([scout], null);
		expect(html).toContain("ag-row");
		expect(html).toContain("gui-agent-dock");
		// 未选中 = 关闭态(仍挂载,z 层与 panel 同栈)。
		expect(html).not.toContain("gui-agent-dock--open");
		expect(html.indexOf("gui-pane-right")).toBeLessThan(html.indexOf("gui-agent-dock"));
	});

	it("选中子 agent 时详情层打开", () => {
		const html = render([scout], scout.id);
		expect(html).toContain("gui-agent-dock--open");
		expect(html).toContain("ag-drawer");
	});

	it("无子 agent 时给出空态而不是空白视图", () => {
		const html = render([], null);
		expect(html).toContain("gui-pane-tab-empty-title");
	});
});
