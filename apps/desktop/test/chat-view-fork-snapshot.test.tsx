/**
 * Forking while the source runs must not stop it.
 *
 * The old tree-op guard stopped the run and waited for it to unwind before
 * `session.forkAt`. The fork now asks the daemon for a snapshot instead: the
 * confirm explains that the in-flight reply is not copied, and the RPC carries
 * `snapshot: true` so the daemon cuts at the current turn's start.
 */
import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import type { SessionEntry } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatView } from "../src/components/ChatView";
import { PromptProvider } from "../src/lib/prompt-dialog";
import type { RpcClient } from "../src/lib/rpc";
import { GuiSessionStore } from "../src/lib/session-store";

function entry(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(1_700_000_000_000).toISOString(),
		message: {
			role,
			timestamp: 1_700_000_000_000,
			stopReason: role === "assistant" ? "stop" : undefined,
			content: [{ type: "text", text }],
		},
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

describe("ChatView running fork", () => {
	it("asks for a snapshot and never stops the source session", async () => {
		const forkCalls: Array<Record<string, unknown>> = [];
		const rpc = {
			request: async (method: string, params: Record<string, unknown> = {}) => {
				if (method.startsWith("models.list")) return [];
				if (method === "git.branches") return { error: "not a repository" };
				if (method === "session.forkAt") {
					forkCalls.push(params);
					return { sessionId: "fork-1", parentId: "source-1" };
				}
				return {};
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		const store = new GuiSessionStore(
			"source-1",
			{
				entries: [entry("u1", null, "user", "question"), entry("a1", "u1", "assistant", "answer")],
				cursor: 0,
				state: { isStreaming: true },
			},
			"C:/workspace",
		);
		stores.add(store);
		let stops = 0;
		const opened: string[] = [];
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.add(root);
		await act(async () =>
			root.render(
				<PromptProvider>
					<ChatView
						store={store}
						rpc={rpc}
						onSend={() => {}}
						onStop={() => {
							stops += 1;
						}}
						onForkSession={sessionId => {
							opened.push(sessionId);
						}}
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
				</PromptProvider>,
			),
		);

		const fork = host.querySelector<HTMLButtonElement>(
			`.tr-row--assistant button[aria-label="${t("general.forkSessionMessage")}"]`,
		);
		expect(fork).not.toBeNull();
		await act(async () => fork!.click());
		await act(async () => Bun.sleep(90));

		// No stop request; the confirm explains the snapshot boundary instead.
		expect(stops).toBe(0);
		expect(forkCalls).toHaveLength(0);
		const dialog = document.querySelector<HTMLElement>(".gui-dialog--confirm");
		expect(dialog).not.toBeNull();
		expect(dialog!.textContent).toContain(t("general.forkSnapshotHint"));

		const confirm = dialog!.querySelector<HTMLElement>(".gui-btn-primary");
		expect(confirm).not.toBeNull();
		expect(confirm!.textContent).toBe(t("general.continuePointNewSession"));
		await act(async () => confirm!.click());
		await act(async () => Bun.sleep(240));

		expect(stops).toBe(0);
		expect(forkCalls).toEqual([{ sessionId: "source-1", messageId: "a1", includeTarget: true, snapshot: true }]);
		expect(opened).toEqual(["fork-1"]);
	}, 20000);
});
