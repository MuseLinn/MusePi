import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterEach, describe, expect, it, vi } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../src/components/ChatView";
import { flushPendingConnectorSelection } from "../src/components/composer/connector-panel";
import type { RpcClient } from "../src/lib/rpc";
import { GuiSessionStore } from "../src/lib/session-store";

/** Persisted draft-selection key: choices made on the welcome page survive a
 *  reload, so the key is part of the storage contract. */
const PENDING_KEY = "musepi-gui-connectors-pending";
const CWD = "C:/workspace";

interface RpcCall {
	method: string;
	params?: unknown;
}

type Handler = (params: Record<string, unknown>) => unknown;

function makeRpc(handlers: Partial<Record<string, Handler>> = {}, calls: RpcCall[] = []): RpcClient {
	return {
		request: async (method: string, params?: unknown): Promise<unknown> => {
			calls.push({ method, params });
			const handler = handlers[method];
			if (handler) return handler((params ?? {}) as Record<string, unknown>);
			return method.startsWith("models.list") ? [] : {};
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
}

function stagePending(servers: string[] | null): void {
	localStorage.setItem(PENDING_KEY, JSON.stringify({ [CWD]: servers }));
}

function pendingMap(): Record<string, string[] | null> {
	return JSON.parse(localStorage.getItem(PENDING_KEY) ?? "{}") as Record<string, string[] | null>;
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.clear();
});

describe("草稿连接器选择写回", () => {
	it("并发调用共享一次请求，成功后清暂存，再调用是 no-op", async () => {
		stagePending(["fs"]);
		const calls: RpcCall[] = [];
		let resolveWrite: ((value: unknown) => void) | null = null;
		const rpc = {
			request: (method: string, params?: unknown): Promise<unknown> => {
				calls.push({ method, params });
				return new Promise(resolve => {
					resolveWrite = resolve;
				});
			},
		} as unknown as RpcClient;

		const first = flushPendingConnectorSelection(rpc, "session-1", CWD);
		// A second caller racing the first (ChatView + the info card both run
		// this on the session switch) must not send a duplicate write.
		const second = flushPendingConnectorSelection(rpc, "session-1", CWD);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.params).toEqual({ sessionId: "session-1", servers: ["fs"] });

		resolveWrite?.({ ok: true, appliedToLive: true });
		expect(await first).toBe(true);
		expect(await second).toBe(true);
		expect(pendingMap()).toEqual({});

		expect(await flushPendingConnectorSelection(rpc, "session-1", CWD)).toBe(false);
		expect(calls).toHaveLength(1);
	});

	it("写回失败保留暂存，下一次调用重试并在成功后清除", async () => {
		stagePending(null);
		const calls: RpcCall[] = [];
		let attempts = 0;
		const rpc = makeRpc(
			{
				"connectors.setSelected": () => {
					attempts += 1;
					if (attempts === 1) throw new Error("daemon offline");
					return { ok: true, appliedToLive: true };
				},
			},
			calls,
		);

		expect(await flushPendingConnectorSelection(rpc, "session-1", CWD)).toBe(false);
		expect(pendingMap()).toEqual({ [CWD]: null });

		expect(await flushPendingConnectorSelection(rpc, "session-1", CWD)).toBe(true);
		expect(pendingMap()).toEqual({});
		expect(calls.map(call => call.params)).toEqual([
			{ sessionId: "session-1", servers: null },
			{ sessionId: "session-1", servers: null },
		]);
	});

	it("没有会话或 cwd 时不写回，也不丢掉暂存", async () => {
		stagePending(["fs"]);
		const calls: RpcCall[] = [];
		const rpc = makeRpc({}, calls);

		expect(await flushPendingConnectorSelection(rpc, null, CWD)).toBe(false);
		expect(await flushPendingConnectorSelection(rpc, "session-1", null)).toBe(false);
		expect(calls).toHaveLength(0);
		expect(pendingMap()).toEqual({ [CWD]: ["fs"] });
	});

	it("会话创建后 ChatView 立即写回欢迎页的选择", async () => {
		stagePending(["fs", "web"]);
		const calls: RpcCall[] = [];
		const rpc = makeRpc(
			{
				"connectors.setSelected": () => ({ ok: true, appliedToLive: true }),
				"git.numstat": () => ({ files: [] }),
			},
			calls,
		);
		const store = new GuiSessionStore("session-1", { entries: [], cursor: 0 } as never, CWD);
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		await act(async () => {
			root.render(
				<ChatView
					store={store}
					rpc={rpc}
					onSend={() => {}}
					onStop={() => {}}
					onDecideApproval={() => {}}
					busy={false}
					project={CWD}
					onProject={() => {}}
					onSubmitNewSession={() => {}}
					rightPanelOpen={false}
					terminalOpen={false}
					focusMode={false}
					onToggleFocus={() => {}}
					sessionTitle="新会话"
					sessionInfoOpen={false}
				/>,
			);
		});
		await flush();

		const writes = calls.filter(call => call.method === "connectors.setSelected");
		expect(writes).toHaveLength(1);
		expect(writes[0]?.params).toEqual({ sessionId: "session-1", servers: ["fs", "web"] });
		expect(pendingMap()).toEqual({});

		await act(async () => root.unmount());
		host.remove();
	});
});
