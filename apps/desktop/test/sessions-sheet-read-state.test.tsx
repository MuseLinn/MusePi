import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import type { WorkspaceSessionInfo } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionsSheet } from "../../../packages/client-core/src/components/shell/SessionsSheet";
import type { SessionClient } from "../../../packages/client-core/src/lib/client";

const mounted = new Set<Root>();

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

function session(id: string, title: string): WorkspaceSessionInfo {
	return {
		id,
		title,
		cwd: "/work",
		messageCount: 3,
		working: false,
		paused: false,
		live: true,
		updatedAt: 1_751_791_200_000,
	};
}

interface RpcCall {
	method: string;
	params?: unknown;
}

/** SessionClient stand-in: `sessionStatus.list` answers the host state, every
 *  other RPC only records the call. */
function fakeClient(calls: RpcCall[], states: unknown[]): SessionClient {
	return {
		rpc: async (method: string, params?: unknown) => {
			calls.push({ method, params });
			return method === "sessionStatus.list" ? { states } : { ok: true };
		},
	} as unknown as SessionClient;
}

async function mountSheet(client: SessionClient, sessions: WorkspaceSessionInfo[]): Promise<void> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.add(root);
	await act(async () => {
		root.render(
			<SessionsSheet
				client={client}
				sessions={sessions}
				currentId={null}
				onSelect={() => {}}
				open
				onClose={() => {}}
			/>,
		);
		// The read-state effect fetches once on open; let its promise settle.
		await Promise.resolve();
		await Promise.resolve();
	});
}

/** The sheet portals into `document.body`, so rows are found there. */
function rowOf(title: string): HTMLButtonElement {
	const rows = [...document.querySelectorAll<HTMLButtonElement>(".ss-item")];
	const row = rows.find(candidate => candidate.textContent?.includes(title));
	if (!row) throw new Error(`row not found: ${title}`);
	return row;
}

describe("mobile session sheet read state", () => {
	it("renders the host unread and failure markers on the leading dot", async () => {
		const calls: RpcCall[] = [];
		const client = fakeClient(calls, [
			{ sessionId: "s1", unread: true, failed: false },
			{ sessionId: "s2", unread: true, failed: true },
			{ sessionId: "s3", unread: false, failed: false },
		]);
		await mountSheet(client, [session("s1", "Unread row"), session("s2", "Failed row"), session("s3", "Read row")]);

		expect(calls[0]).toEqual({ method: "sessionStatus.list", params: undefined });
		expect(rowOf("Unread row").querySelector(".ss-item-dot--unread")).not.toBeNull();
		expect(rowOf("Failed row").querySelector(".ss-item-dot--failed")).not.toBeNull();
		// The two states are exclusive and a read session keeps the idle dot.
		expect(rowOf("Failed row").querySelector(".ss-item-dot--unread")).toBeNull();
		expect(rowOf("Read row").querySelector(".ss-item-dot--unread, .ss-item-dot--failed")).toBeNull();
		// The dot is decorative; the row's accessible name carries the state.
		const failedStatus = rowOf("Failed row").querySelector(".ss-item-status");
		const unreadStatus = rowOf("Unread row").querySelector(".ss-item-status");
		expect(failedStatus?.getAttribute("aria-label")?.trim()).not.toBe("");
		expect(failedStatus?.getAttribute("aria-label")).not.toBe(unreadStatus?.getAttribute("aria-label"));
	});

	it("opening a row marks it read through the shared RPC", async () => {
		const calls: RpcCall[] = [];
		const client = fakeClient(calls, [{ sessionId: "s1", unread: true, failed: false }]);
		await mountSheet(client, [session("s1", "Unread row")]);
		await act(async () => {
			rowOf("Unread row").click();
			await Promise.resolve();
		});
		expect(calls).toContainEqual({
			method: "sessionStatus.mark",
			params: { sessionId: "s1", read: true },
		});
	});
});
