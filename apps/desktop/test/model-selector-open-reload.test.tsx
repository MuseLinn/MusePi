import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModelSelector } from "../src/components/ModelSelector";
import type { RpcClient } from "../src/lib/rpc";

const mounted = new Set<Root>();

async function flush(frames = 8): Promise<void> {
	await act(async () => {
		for (let index = 0; index < frames; index++) await Bun.sleep(5);
	});
}

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

describe("model selector catalog pull", () => {
	it("re-reads models.list when an already-mounted menu opens", async () => {
		const calls: string[] = [];
		const rows = [
			{
				id: "a",
				name: "Model A",
				provider: "gateway",
				providerLabel: "Gateway",
				contextWindow: null,
				maxTokens: null,
				costInput: 0,
				costOutput: 0,
				reasoning: false,
				text: true,
				vision: false,
				video: false,
				imageGen: false,
				videoGen: false,
				efforts: [],
				defaultLevel: null,
			},
		];
		const rpc = {
			request: async (method: string) => {
				calls.push(method);
				if (method === "models.list") return rows;
				return null;
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;

		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		await act(async () => root.render(<ModelSelector rpc={rpc} sessionId="session-1" currentModelId="gateway/a" />));
		await flush();

		const listCalls = () => calls.filter(method => method === "models.list").length;
		expect(listCalls()).toBe(1);

		const trigger = container.querySelector<HTMLButtonElement>(".gui-model-btn");
		expect(trigger).not.toBeNull();
		await act(async () => trigger?.click());
		await flush();

		// The mount fetch happened before the external models.yml edit; the
		// open is the pull that makes the daemon re-check the file.
		expect(listCalls()).toBe(2);
	});
});
