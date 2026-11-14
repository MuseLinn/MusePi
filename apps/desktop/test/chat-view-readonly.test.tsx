import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../src/components/ChatView";
import type { RpcClient } from "../src/lib/rpc";
import { GuiSessionStore } from "../src/lib/session-store";

const entries = [
	{
		type: "message",
		id: "user-1",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", timestamp: 1, content: "review this" },
	},
	{
		type: "custom_message",
		id: "advisor-1",
		parentId: null,
		timestamp: "2026-01-01T00:00:01.000Z",
		customType: "advisor",
		display: true,
		content: "<advisory>read-only finding</advisory>",
		details: { notes: [{ note: "read-only finding", severity: "concern" }] },
	},
	{
		type: "custom_message",
		id: "retry-1",
		parentId: null,
		timestamp: "2026-01-01T00:00:02.000Z",
		customType: "retry_failure",
		display: true,
		content: "provider exhausted retries",
		details: { attempt: 3 },
	},
] as unknown as SessionEntry[];

async function render(readOnly: boolean): Promise<string> {
	const store = new GuiSessionStore("advisor-session", { entries, cursor: 0 }, "C:/workspace");
	const rpc = {
		request: async (method: string) => (method.startsWith("models.list") ? [] : {}),
		addEventListener: () => () => {},
	} as unknown as RpcClient;
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
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
			/>,
		);
	});
	const html = host.innerHTML;
	await act(async () => root.unmount());
	host.remove();
	store.dispose();
	return html;
}

describe("ChatView advisor read-only sessions", () => {
	it("does not run the ordinary session failure dock over read-only records", async () => {
		expect(await render(false)).toContain('data-error-kind="session"');
		expect(await render(true)).not.toContain('data-error-kind="session"');
	});
});
