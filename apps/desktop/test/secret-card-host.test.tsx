import "./happy-dom-shim"; // MUST be first: component module graphs define DOM-backed modules at evaluation time.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatView } from "../src/components/ChatView";
import { invalidateGitStatus } from "../src/lib/git-status-cache";
import type { RpcClient, StreamEvent } from "../src/lib/rpc";
import { GuiSessionStore } from "../src/lib/session-store";

// 宿主角色的契约（M35 返工）：卡片刻在它所属的会话上；会话切换即消失；
// 并发 secret-request 各自独占一张卡并独立 resolve。
setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

const mounted = new Set<Root>();
const stores = new Set<GuiSessionStore>();

async function flush(frames = 4): Promise<void> {
	await act(async () => {
		for (let index = 0; index < frames; index++) await Bun.sleep(5);
	});
}

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	for (const store of stores) store.dispose();
	stores.clear();
	invalidateGitStatus();
	localStorage.clear();
	document.body.innerHTML = "";
});

function makeRpc(): {
	rpc: RpcClient;
	answers: { requestId: string; action: string; value?: string; scope?: string }[];
	emit(event: StreamEvent): void;
} {
	const answers: { requestId: string; action: string; value?: string; scope?: string }[] = [];
	let listener: ((event: StreamEvent) => void) | null = null;
	const rpc = {
		request: async (method: string, params?: unknown) => {
			if (method === "secret.answer") {
				answers.push(params as { requestId: string; action: string; value?: string; scope?: string });
				return { ok: true };
			}
			if (method.startsWith("models.list")) return [];
			if (method === "git.branches") return { error: "not a repository" };
			return {};
		},
		addEventListener: (handler: (event: StreamEvent) => void) => {
			listener = handler;
			return () => {
				if (listener === handler) listener = null;
			};
		},
	} as unknown as RpcClient;
	return {
		rpc,
		answers,
		emit: (event: StreamEvent) => listener?.(event),
	};
}

function view(store: GuiSessionStore | null, rpc: RpcClient): ReturnType<typeof ChatView> {
	return (
		<ChatView
			store={store}
			rpc={rpc}
			onSend={() => {}}
			onStop={() => {}}
			onDecideApproval={() => {}}
			busy={false}
			project="C:/workspace"
			onProject={() => {}}
			onSubmitNewSession={() => {}}
			rightPanelOpen={false}
			terminalOpen={false}
			focusMode={false}
			onToggleFocus={() => {}}
			sessionInfoOpen
			onToggleSessionInfo={() => {}}
		/>
	);
}

function makeStore(sessionId: string): GuiSessionStore {
	const store = new GuiSessionStore(sessionId, { entries: [], cursor: 0 }, "C:/workspace");
	stores.add(store);
	return store;
}

function requestEvent(
	sessionId: string | undefined,
	requestId: string,
	name: string,
	kind: "fill" | "allow" = "allow",
): StreamEvent {
	return {
		kind: "secret-request",
		seq: 1,
		...(sessionId ? { sessionId } : {}),
		payload: { requestId, name, purpose: `Need ${name}`, kind },
	};
}

async function emit(emitEvent: (event: StreamEvent) => void, event: StreamEvent): Promise<void> {
	await act(async () => emitEvent(event));
	await flush();
}

function cards(host: HTMLElement): HTMLElement[] {
	return [...host.querySelectorAll<HTMLElement>(".gui-secret-card")];
}

function buttonIn(card: HTMLElement, text: string): HTMLButtonElement {
	const found = [...card.querySelectorAll<HTMLButtonElement>("button")].find(
		candidate => candidate.textContent?.trim() === text,
	);
	if (!found) throw new Error(`no button ${text}`);
	return found;
}

describe("SecretCard host 会话归属", () => {
	test("只挂当前会话的请求；切换会话后旧卡消失", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		mounted.add(root);
		const { rpc, emit: emitEvent } = makeRpc();
		const a = makeStore("session-a");
		const b = makeStore("session-b");

		await act(async () => root.render(view(a, rpc)));
		// 带别的会话 id、或完全没有 sessionId 的事件都不落到当前会话。
		await emit(emitEvent, requestEvent("session-b", "foreign", "FOREIGN_KEY"));
		await emit(emitEvent, requestEvent(undefined, "ownerless", "OWNERLESS_KEY"));
		expect(cards(host)).toHaveLength(0);
		await emit(emitEvent, requestEvent("session-a", "r1", "A_KEY"));
		expect(cards(host)).toHaveLength(1);
		expect(host.textContent).toContain("$MUSEPI_SECRET_A_KEY");

		// ChatView 在会话间复用：切到 B 时 A 的未决卡必须清空。
		await act(async () => root.render(view(b, rpc)));
		await flush();
		expect(cards(host)).toHaveLength(0);
		expect(host.textContent).not.toContain("$MUSEPI_SECRET_A_KEY");

		// B 自己的请求照常出现。
		await emit(emitEvent, requestEvent("session-b", "r2", "B_KEY"));
		expect(cards(host)).toHaveLength(1);
		expect(host.textContent).toContain("$MUSEPI_SECRET_B_KEY");
	});
});

describe("SecretCard host 并发请求", () => {
	test("两个请求同时可见，各自 resolve 自己的 secret.answer", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		mounted.add(root);
		const { rpc, answers, emit: emitEvent } = makeRpc();
		const store = makeStore("session-a");

		await act(async () => root.render(view(store, rpc)));
		await emit(emitEvent, requestEvent("session-a", "r1", "FIRST_KEY"));
		await emit(emitEvent, requestEvent("session-a", "r2", "SECOND_KEY"));
		// 后到的请求不覆盖先到的：两张卡同时存在。
		expect(cards(host)).toHaveLength(2);
		expect(host.textContent).toContain("$MUSEPI_SECRET_FIRST_KEY");
		expect(host.textContent).toContain("$MUSEPI_SECRET_SECOND_KEY");

		const first = cards(host)[0]!;
		await act(async () => buttonIn(first, "允许").click());
		await flush();
		expect(answers).toEqual([{ requestId: "r1", action: "allow", scope: "all" }]);
		// 第一张已决，第二张仍在等待自己的回答。
		expect(cards(host)).toHaveLength(2);
		expect(cards(host)[1]!.textContent).toContain("$MUSEPI_SECRET_SECOND_KEY");
		expect(buttonIn(cards(host)[1]!, "允许").disabled).toBe(false);

		await act(async () => buttonIn(cards(host)[1]!, "允许").click());
		await flush();
		expect(answers).toEqual([
			{ requestId: "r1", action: "allow", scope: "all" },
			{ requestId: "r2", action: "allow", scope: "all" },
		]);
		expect(host.textContent).toContain("已允许 FIRST_KEY");
		expect(host.textContent).toContain("已允许 SECOND_KEY");
	});
});
