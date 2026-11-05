import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatView } from "../src/components/ChatView";
import type { RpcClient } from "../src/lib/rpc";
import { GuiSessionStore } from "../src/lib/session-store";

function message(id: string, parentId: string | null, text: string, second: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(second * 1000).toISOString(),
		message: { role: "user", content: [{ type: "text", text }] },
	} as unknown as SessionEntry;
}

const roots = new Set<Root>();
const stores = new Set<GuiSessionStore>();

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	for (const store of stores) store.dispose();
	roots.clear();
	stores.clear();
	document.body.innerHTML = "";
});

describe("ChatView history window", () => {
	it("opens the map on the latest window and pages older entries only on demand", async () => {
		const older = message("older", null, "older map entry", 1);
		const latest = message("latest", "older", "latest map entry", 2);
		const historyCalls: Array<Record<string, unknown>> = [];
		const turnCalls: Array<Record<string, unknown>> = [];
		const rpc = {
			request: async (method: string, params: Record<string, unknown>) => {
				if (method.startsWith("models.list")) return [];
				if (method === "git.branches") return { error: "not a repository" };
				if (method === "session.turns") {
					turnCalls.push(params);
					return { turns: [] };
				}
				if (method === "session.history") {
					historyCalls.push(params);
					return { entries: [older], hasMore: false, remaining: 0, nextBeforeId: older.id, stale: false };
				}
				return {};
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		const store = new GuiSessionStore(
			"history-window",
			{ entries: [latest], cursor: 0, tail: { hasMore: true, beforeId: latest.id } },
			"C:/workspace",
		);
		stores.add(store);
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.add(root);
		await act(async () =>
			root.render(
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
				/>,
			),
		);
		const canvasTab = host.querySelectorAll<HTMLButtonElement>(".gui-surface-mode-btn")[1];
		await act(async () => canvasTab?.click());
		await act(async () => Bun.sleep(20));

		expect(historyCalls).toHaveLength(0);
		expect(turnCalls[0]).toMatchObject({ limit: 200 });
		expect(host.textContent).toContain("latest map entry");

		const loadOlder = host.querySelector<HTMLButtonElement>(".tm-load-older");
		expect(loadOlder).not.toBeNull();
		await act(async () => loadOlder?.click());
		await act(async () => Bun.sleep(20));
		expect(historyCalls).toHaveLength(1);
		expect(historyCalls[0]).toMatchObject({ beforeId: "latest" });
		expect(host.textContent).toContain("older map entry");
	});

	it("renders both transcripts when switching between snapshot-seeded sessions", async () => {
		const rpc = {
			request: async (method: string) =>
				method.startsWith("models.list") ? [] : method === "session.turns" ? { turns: [] } : {},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		// Both stores are snapshot-seeded, so both report structureRev 0 — the
		// leaf/topology memos must still re-derive on the switch.
		const alpha = new GuiSessionStore(
			"alpha-session",
			{
				entries: [
					message("alpha-1", null, "alpha first turn", 1),
					message("alpha-2", "alpha-1", "alpha second turn", 2),
				],
				cursor: 0,
			},
			"C:/workspace",
		);
		const beta = new GuiSessionStore(
			"beta-session",
			{
				entries: [
					message("beta-1", null, "beta first turn", 3),
					message("beta-2", "beta-1", "beta second turn", 4),
					message("beta-3", "beta-2", "beta third turn", 5),
				],
				cursor: 0,
			},
			"C:/workspace",
		);
		stores.add(alpha);
		stores.add(beta);
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.add(root);
		const view = (store: GuiSessionStore) => (
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
			/>
		);
		await act(async () => root.render(view(alpha)));
		expect(host.textContent).toContain("alpha first turn");
		expect(host.textContent).toContain("alpha second turn");

		await act(async () => root.render(view(beta)));
		expect(host.textContent).toContain("beta first turn");
		expect(host.textContent).toContain("beta second turn");
		expect(host.textContent).toContain("beta third turn");
		expect(host.textContent).not.toContain("alpha second turn");

		await act(async () => root.render(view(alpha)));
		expect(host.textContent).toContain("alpha second turn");
		expect(host.textContent).not.toContain("beta third turn");
	});

	it("returns from an advisor record to the main session's latest turn", async () => {
		const rpc = {
			request: async (method: string) =>
				method.startsWith("models.list") ? [] : method === "session.turns" ? { turns: [] } : {},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		const main = new GuiSessionStore(
			"main-session",
			{
				entries: [message("u1", null, "first main turn", 1), message("u2", "u1", "latest main turn", 2)],
				cursor: 0,
			},
			"C:/workspace",
		);
		const advisor = new GuiSessionStore(
			"advisor-session",
			{ entries: [message("a1", null, "advisor-only record", 3)], cursor: 0 },
			"C:/workspace",
		);
		stores.add(main);
		stores.add(advisor);
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.add(root);
		const view = (store: GuiSessionStore, readOnly = false) => (
			<ChatView
				store={store}
				rpc={rpc}
				readOnly={readOnly}
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
			/>
		);
		await act(async () => root.render(view(main)));
		expect(host.textContent).toContain("latest main turn");
		await act(async () => root.render(view(advisor, true)));
		expect(host.textContent).toContain("advisor-only record");
		await act(async () => root.render(view(main)));
		expect(host.textContent).toContain("latest main turn");
		expect(host.textContent).not.toContain("advisor-only record");
	});
});
