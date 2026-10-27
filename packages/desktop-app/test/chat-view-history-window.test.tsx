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
});
