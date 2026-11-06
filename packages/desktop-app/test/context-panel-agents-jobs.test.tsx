import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextPanel } from "../src/components/ContextPanel";
import type { RpcClient } from "../src/lib/rpc";
import type { GuiSessionState } from "../src/lib/session-store";
import type { UsePanelTabsResult } from "../src/lib/use-panel-tabs";

// 后台作业区块契约(agents surface 内的折叠段):折叠时不挂载 JobsPane —— 因此不花
// 任何 session.jobs 轮询;展开后才挂载并开始每秒刷新。无会话时不渲染该区块。

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
			column: 0,
		},
	],
	activeId: "agents::",
	split: false,
	columnActive: ["agents::", null],
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

const EMPTY_DELIVERY = { queued: 0, delivering: false, pendingJobIds: [] };

const roots: Root[] = [];
const hosts: HTMLElement[] = [];

function snapshot(sessionId: string | null): GuiSessionState {
	return {
		sessionId,
		entries: [],
		state: { cwd: "C:/workspace" } as unknown as GuiSessionState["state"],
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

function fakeRpc(calls: string[]): RpcClient {
	return {
		request: async (method: string) => {
			calls.push(method);
			if (method === "session.jobs") return { running: [], recent: [], delivery: EMPTY_DELIVERY };
			if (method === "session.agents") return { agents: [] };
			return null;
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
}

async function mount(sessionId: string | null, calls: string[]): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	hosts.push(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => {
		root.render(
			<ContextPanel
				snap={snapshot(sessionId)}
				rpc={fakeRpc(calls)}
				onViewChange={() => {}}
				panelTabs={agentsPanelTabs}
				agentId={null}
				onAgentSelect={() => {}}
			/>,
		);
	});
	await flush();
	return host;
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

function jobsToggle(host: HTMLElement): HTMLButtonElement {
	const button = [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find(candidate =>
		candidate.textContent?.includes(t("tools.jobs")),
	);
	if (!button) throw new Error("missing background jobs toggle");
	return button;
}

function jobRequests(calls: string[]): number {
	return calls.filter(method => method === "session.jobs").length;
}

beforeEach(() => setLocale("en-US"));

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop()!;
		await act(async () => root.unmount());
	}
	while (hosts.length > 0) hosts.pop()!.remove();
	vi.useRealTimers();
});

describe("ContextPanel agents 视图的后台作业区块", () => {
	it("折叠时不请求 session.jobs,展开后才开始并按秒刷新", async () => {
		vi.useFakeTimers();
		const calls: string[] = [];
		const host = await mount("s1", calls);
		expect(jobsToggle(host).getAttribute("aria-expanded")).toBe("false");
		await act(async () => {
			vi.advanceTimersByTime(3000);
		});
		expect(jobRequests(calls)).toBe(0);

		act(() => jobsToggle(host).click());
		await flush();
		expect(jobsToggle(host).getAttribute("aria-expanded")).toBe("true");
		expect(jobRequests(calls)).toBe(1);

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		expect(jobRequests(calls)).toBe(2);

		// 再折叠:JobsPane 卸载,轮询停止。
		act(() => jobsToggle(host).click());
		await flush();
		const settled = jobRequests(calls);
		await act(async () => {
			vi.advanceTimersByTime(3000);
		});
		expect(jobRequests(calls)).toBe(settled);
	});

	it("无会话时不渲染该区块", async () => {
		const calls: string[] = [];
		const host = await mount(null, calls);
		const toggles = [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].filter(candidate =>
			candidate.textContent?.includes(t("tools.jobs")),
		);
		expect(toggles).toHaveLength(0);
		expect(jobRequests(calls)).toBe(0);
	});
});
