import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionInfoCard } from "../src/components/session-info-card";
import type { RpcClient } from "../src/lib/rpc";

// 信息卡溢出菜单契约:复制工作区路径 + 会话维护(shaking / provider 流 / 清空上下文)。
// 「清空」先确认;测试里没有 PromptProvider,默认 confirm 解析 false,因此该动作不得
// 发出 RPC。维护结果落在标题下的状态行。

interface RpcCall {
	method: string;
	params?: unknown;
}

const roots: Root[] = [];
const hosts: HTMLElement[] = [];

function fakeRpc(
	calls: RpcCall[],
	shakeResult: { toolResultsDropped: number; blocksDropped: number; tokensFreed: number } = {
		toolResultsDropped: 3,
		blocksDropped: 1,
		tokensFreed: 1200,
	},
): RpcClient {
	return {
		request: async (method: string, params?: unknown): Promise<unknown> => {
			calls.push({ method, params });
			if (method === "session.contextUsage") return { model: "provider/model" };
			if (method === "git.numstat") return { files: [] };
			if (method === "session.shake") return { ...shakeResult, imagesDropped: 0, artifactId: "artifact-1" };
			if (method === "session.fresh") return { closedProviderSessions: 2 };
			if (method === "session.resetContext") return { droppedCount: 9 };
			return {};
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

async function mount(
	calls: RpcCall[],
	options: {
		working?: boolean;
		onSessionRewritten?: () => void;
		shakeResult?: { toolResultsDropped: number; blocksDropped: number; tokensFreed: number };
		onOpenArtifact?: (id: string) => void;
	} = {},
): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	hosts.push(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => {
		root.render(
			<SessionInfoCard
				sessionId="s1"
				rpc={fakeRpc(calls, options.shakeResult)}
				cwd="C:/workspace"
				title="Session"
				tabs={[]}
				working={options.working ?? false}
				onSessionRewritten={options.onSessionRewritten}
				onOpenArtifact={options.onOpenArtifact}
			/>,
		);
	});
	await flush();
	return host;
}

function openMenu(host: HTMLElement): void {
	const trigger = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
		button => button.getAttribute("aria-label") === t("tools.more"),
	);
	if (!trigger) throw new Error("missing session info menu trigger");
	act(() => trigger.click());
}

function menuItem(label: string): HTMLButtonElement {
	const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(candidate =>
		candidate.textContent?.includes(label),
	);
	if (!item) throw new Error(`missing menu item ${label}`);
	return item;
}

function rpcCalls(calls: RpcCall[], method: string): RpcCall[] {
	return calls.filter(call => call.method === method);
}

beforeEach(() => setLocale("en-US"));

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop()!;
		await act(async () => root.unmount());
	}
	while (hosts.length > 0) hosts.pop()!.remove();
});

describe("SessionInfoCard 溢出菜单", () => {
	it("列出复制路径与三条会话维护动作", async () => {
		const calls: RpcCall[] = [];
		const host = await mount(calls);
		openMenu(host);
		const labels = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map(item =>
			item.textContent?.trim(),
		);
		expect(labels).toEqual([
			t("general.copyWorkspacePath"),
			t("sessionInfo.reloadTranscript"),
			t("sessionInfo.maintenanceShake"),
			t("sessionInfo.maintenanceFresh"),
			t("sessionInfo.maintenanceClear"),
		]);
		// The consequence rides the tooltip; the row stays one line.
		expect(menuItem(t("sessionInfo.maintenanceClear")).title).toBe(t("sessionInfo.maintenanceClearHint"));
	});

	it("本轮回复进行中时三条维护动作都不可用", async () => {
		const calls: RpcCall[] = [];
		const host = await mount(calls, { working: true });
		openMenu(host);
		for (const key of [
			"sessionInfo.maintenanceShake",
			"sessionInfo.maintenanceFresh",
			"sessionInfo.maintenanceClear",
		] as const) {
			expect(menuItem(t(key)).disabled).toBe(true);
		}
		expect(menuItem(t("general.copyWorkspacePath")).disabled).toBe(false);
		expect(menuItem(t("sessionInfo.reloadTranscript")).disabled).toBe(true);
	});

	it("移除工具输出调用 session.shake,结果落进状态行并重读 transcript", async () => {
		const calls: RpcCall[] = [];
		let rewritten = 0;
		let opened: string | null = null;
		const host = await mount(calls, {
			onSessionRewritten: () => (rewritten += 1),
			onOpenArtifact: id => (opened = id),
		});
		openMenu(host);
		act(() => menuItem(t("sessionInfo.maintenanceShake")).click());
		await flush();

		expect(rpcCalls(calls, "session.shake")).toHaveLength(1);
		expect(rpcCalls(calls, "session.shake")[0]?.params).toMatchObject({ sessionId: "s1", mode: "elide" });
		expect(host.textContent).toContain(
			t("tools.shakeResultBlocksTokensWithDroppedWithTokens", { dropped: 3, tokens: 1200 }),
		);
		// Persisted entries changed in place; the transcript must re-read them.
		expect(rewritten).toBe(1);
		// The recovery snapshot stays one click away.
		const link = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button =>
			button.textContent?.includes(t("sessionInfo.viewRemovedContent")),
		);
		expect(link).toBeDefined();
		await act(async () => {
			link!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		});
		await flush();
		expect(opened).toBe("artifact-1");
	});

	it("没有可移除内容时不重读 transcript", async () => {
		const calls: RpcCall[] = [];
		let rewritten = 0;
		const host = await mount(calls, {
			onSessionRewritten: () => (rewritten += 1),
			shakeResult: { toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 },
		});
		openMenu(host);
		act(() => menuItem(t("sessionInfo.maintenanceShake")).click());
		await flush();

		expect(host.textContent).toContain(t("sessionInfo.maintenanceNothingToDo"));
		expect(rewritten).toBe(0);
	});

	it("重建模型连接调用 session.fresh", async () => {
		const calls: RpcCall[] = [];
		const host = await mount(calls);
		openMenu(host);
		act(() => menuItem(t("sessionInfo.maintenanceFresh")).click());
		await flush();

		expect(rpcCalls(calls, "session.fresh")).toHaveLength(1);
		expect(host.textContent).toContain(t("tools.freshResultSessionsWithClosed", { closed: 2 }));
	});

	it("清空模型上下文未经确认不发出 RPC", async () => {
		const calls: RpcCall[] = [];
		const host = await mount(calls);
		openMenu(host);
		act(() => menuItem(t("sessionInfo.maintenanceClear")).click());
		await flush();

		expect(rpcCalls(calls, "session.resetContext")).toHaveLength(0);
	});
});
