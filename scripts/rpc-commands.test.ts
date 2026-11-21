import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	addProviderModels,
	cancelProviderLogin,
	logoutProvider,
	type RpcInvoker,
	setSessionModel,
	submitProviderLoginInput,
} from "../apps/desktop/src/lib/rpc-commands";
import { dispatchedRoutes } from "./check-rpc-method-names";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

interface Sent {
	method: string;
	params: unknown;
}

/** Mock transport: records the wire call and resolves like the daemon would. */
function mockRpc(result: unknown = { ok: true }): { rpc: RpcInvoker; sent: Sent[] } {
	const sent: Sent[] = [];
	return {
		sent,
		rpc: {
			request<T = unknown>(method: string, params?: unknown): Promise<T> {
				sent.push({ method, params });
				return Promise.resolve(result as T);
			},
		},
	};
}

describe("rpc-commands", () => {
	test("session.setModel switches the exact provider/id the row showed", async () => {
		const { rpc, sent } = mockRpc();
		const params = { sessionId: "s1", model: { id: "deepseek-v4-flash", provider: "opencode-go" } };
		await setSessionModel(rpc, params);
		expect(sent).toEqual([{ method: "session.setModel", params }]);
	});

	test("providers.loginInput carries the answer to a pending prompt", async () => {
		const { rpc, sent } = mockRpc();
		await submitProviderLoginInput(rpc, "anthropic", "123456");
		expect(sent).toEqual([{ method: "providers.loginInput", params: { providerId: "anthropic", value: "123456" } }]);
	});

	test("providers.loginCancel aborts by provider", async () => {
		const { rpc, sent } = mockRpc();
		await cancelProviderLogin(rpc, "anthropic");
		expect(sent).toEqual([{ method: "providers.loginCancel", params: { providerId: "anthropic" } }]);
	});

	test("providers.logout removes one credential or all of them", async () => {
		const { rpc, sent } = mockRpc();
		await logoutProvider(rpc, { providerId: "anthropic" });
		await logoutProvider(rpc, { providerId: "anthropic", credentialId: 2 });
		expect(sent).toEqual([
			{ method: "providers.logout", params: { providerId: "anthropic" } },
			{ method: "providers.logout", params: { providerId: "anthropic", credentialId: 2 } },
		]);
	});

	test("models.add registers the custom provider, with the session when one is live", async () => {
		const { rpc, sent } = mockRpc();
		const provider = {
			name: "local",
			label: "Local",
			baseUrl: "http://localhost:11434/v1",
			api: "openai-completions",
			models: [{ id: "llama" }],
		};
		await addProviderModels(rpc, provider);
		await addProviderModels(rpc, provider, "s1");
		expect(sent).toEqual([
			{ method: "models.add", params: { sessionId: undefined, provider } },
			{ method: "models.add", params: { sessionId: "s1", provider } },
		]);
	});

	test("every command names a route the dispatcher answers", async () => {
		const routes = dispatchedRoutes(REPO_ROOT);
		const { rpc, sent } = mockRpc();
		await setSessionModel(rpc, { sessionId: "s1", model: { id: "m" } });
		await submitProviderLoginInput(rpc, "p", "v");
		await cancelProviderLogin(rpc, "p");
		await logoutProvider(rpc, { providerId: "p" });
		await addProviderModels(rpc, { name: "n", label: null, baseUrl: "", models: [] });
		expect(sent.map(entry => entry.method)).toEqual([
			"session.setModel",
			"providers.loginInput",
			"providers.loginCancel",
			"providers.logout",
			"models.add",
		]);
		for (const { method } of sent) expect(routes.has(method)).toBe(true);
	});

	test("a daemon rejection reaches the caller instead of being swallowed", async () => {
		const rpc: RpcInvoker = { request: () => Promise.reject(new Error("Unknown method: settings.sessionSetmodel")) };
		await expect(setSessionModel(rpc, { sessionId: "s1", model: { id: "m" } })).rejects.toThrow("Unknown method");
	});
});
