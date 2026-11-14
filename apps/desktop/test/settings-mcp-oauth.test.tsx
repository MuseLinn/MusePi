import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { setLocale, t } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { McpSection } from "../src/components/settings-sections/mcp";
import type { RpcClient, StreamEvent } from "../src/lib/rpc";

/**
 * Settings → MCP: configured-server rows + browser OAuth login.
 *
 * Pinned contracts:
 *  1. `mcp.servers.list` drives one row per configured server with transport,
 *     URL and auth kind; token-auth rows say the token lives in mcp.json and
 *     no input field is offered (the pre-OAuth "paste a token" dead end).
 *  2. The login button starts `mcp.oauth.start`, the row switches to the
 *     waiting state, and `mcp.oauth.status` is polled until the daemon reports
 *     success — then the row shows completion and the server list is reloaded.
 *  3. Cancel calls `mcp.oauth.cancel` and stops polling with cancelled copy.
 *  4. A rejected start surfaces the daemon's reason instead of hanging.
 */

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

interface CannedRequest {
	method: string;
	params: unknown;
}

/** Minimal RpcClient double: per-method handlers + recorded requests. */
class FakeRpc {
	requests: CannedRequest[] = [];
	handlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();

	request<T>(method: string, params?: unknown): Promise<T> {
		this.requests.push({ method, params: params ?? {} });
		const handler = this.handlers.get(method);
		if (!handler) return Promise.resolve(undefined as T);
		try {
			return Promise.resolve(handler(params) as T);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	addEventListener(_handler: (event: StreamEvent) => void): () => void {
		return () => {};
	}

	calls(method: string): unknown[] {
		return this.requests.filter(r => r.method === method).map(r => r.params);
	}
}

const asRpc = (fake: FakeRpc): RpcClient => fake as unknown as RpcClient;

function serversResponse(): Record<string, unknown> {
	return {
		servers: [
			{ name: "oauth-server", transport: "http", url: "https://mcp.example.com/mcp", auth: "oauth" },
			{ name: "token-server", transport: "http", url: "https://token.example.com/mcp", auth: "apikey" },
			{ name: "local-server", transport: "stdio", command: "node", enabled: false },
		],
	};
}

function extensionsResponse(state: "active" | "disabled" = "active"): Record<string, unknown> {
	return {
		extensions: [
			{
				id: "mcp:oauth-server",
				name: "oauth-server",
				displayName: "oauth-server",
				kind: "mcp",
				state,
				source: { provider: "native", providerName: "MusePi", level: "user" },
			},
		],
		tabs: [],
		providers: [],
		components: [],
		toolViews: [],
		statusBarSegments: [],
		slots: { exact: [], prefixes: [] },
	};
}

const mounted = new Set<Root>();

async function mount(fake: FakeRpc): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.add(root);
	await act(async () => root.render(createElement(McpSection, { rpc: asRpc(fake) })));
	await flush();
	return host;
}

async function flush(frames = 6): Promise<void> {
	await act(async () => {
		for (let index = 0; index < frames; index++) await Bun.sleep(10);
	});
}

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

describe("MCP settings", () => {
	test("lists configured servers with transport/url/auth and never offers a token field", async () => {
		const fake = new FakeRpc();
		fake.handlers.set("extensions.list", () => extensionsResponse());
		fake.handlers.set("mcp.servers.list", () => serversResponse());
		const host = await mount(fake);

		expect(host.textContent).toContain(t("settings.mcpConfiguredServers"));
		expect(host.textContent).toContain("oauth-server");
		expect(host.textContent).toContain("https://mcp.example.com/mcp");
		expect(host.textContent).toContain("token-server");
		expect(host.textContent).toContain("local-server");
		expect(host.textContent).toContain(t("settings.mcpAuthOauth"));
		expect(host.textContent).toContain(t("settings.mcpTokenManagedByConfig"));
		expect(host.textContent).toContain(t("settings.mcpStdioCredentials"));

		// Exactly one login button: token- and stdio-managed rows must not offer
		// a fake credential input or an OAuth button.
		const loginButtons = [...host.querySelectorAll<HTMLButtonElement>("button")].filter(
			button => button.textContent?.trim() === t("settings.login"),
		);
		expect(loginButtons).toHaveLength(1);
		expect(host.querySelector("input")).toBeNull();
	});

	test("login starts the daemon flow, waits, polls status, and reports success", async () => {
		const fake = new FakeRpc();
		fake.handlers.set("extensions.list", () => extensionsResponse());
		fake.handlers.set("mcp.servers.list", () => serversResponse());
		fake.handlers.set("mcp.oauth.start", () => ({
			flowId: "flow-1",
			authorizationUrl: "https://auth.example.com/authorize?state=st&code_challenge=cc",
		}));
		fake.handlers.set("mcp.oauth.status", () => ({
			flowId: "flow-1",
			server: "oauth-server",
			status: "success",
		}));
		const host = await mount(fake);

		const login = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
			button => button.textContent?.trim() === t("settings.login"),
		)!;
		await act(async () => login.click());
		await flush();

		expect(fake.calls("mcp.oauth.start")).toEqual([{ name: "oauth-server" }]);
		expect(host.textContent).toContain(t("settings.mcpOauthLoginWaiting"));

		// The poll interval is 1s: wait long enough for the first status tick.
		await act(async () => {
			await Bun.sleep(1150);
		});
		await flush();

		expect(fake.calls("mcp.oauth.status")).toContainEqual({ flowId: "flow-1" });
		expect(host.textContent).toContain(t("settings.authorizationDone"));
		// Success reloads the list so the row reflects the stored grant.
		expect(fake.calls("mcp.servers.list").length).toBeGreaterThanOrEqual(2);
	});

	test("cancel stops a waiting login and reports the cancellation", async () => {
		const fake = new FakeRpc();
		fake.handlers.set("extensions.list", () => extensionsResponse());
		fake.handlers.set("mcp.servers.list", () => serversResponse());
		fake.handlers.set("mcp.oauth.start", () => ({
			flowId: "flow-2",
			authorizationUrl: "https://auth.example.com/authorize?state=st",
		}));
		fake.handlers.set("mcp.oauth.status", () => ({ flowId: "flow-2", server: "oauth-server", status: "pending" }));
		const host = await mount(fake);

		const login = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
			button => button.textContent?.trim() === t("settings.login"),
		)!;
		await act(async () => login.click());
		await flush();

		const cancel = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
			button => button.textContent?.trim() === t("settings.cancel"),
		)!;
		await act(async () => cancel.click());
		await flush();

		expect(fake.calls("mcp.oauth.cancel")).toEqual([{ flowId: "flow-2" }]);
		expect(host.textContent).toContain(t("settings.mcpLoginCancelled"));
		// Polling is stopped: no status tick lands after the cancel.
		const after = fake.calls("mcp.oauth.status").length;
		await act(async () => {
			await Bun.sleep(1100);
		});
		expect(fake.calls("mcp.oauth.status").length).toBe(after);
	});

	test("a rejected start surfaces the daemon reason instead of hanging", async () => {
		const fake = new FakeRpc();
		fake.handlers.set("extensions.list", () => extensionsResponse());
		fake.handlers.set("mcp.servers.list", () => serversResponse());
		fake.handlers.set("mcp.oauth.start", () => Promise.reject(new Error("Could not discover OAuth endpoints")));
		const host = await mount(fake);

		const login = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
			button => button.textContent?.trim() === t("settings.login"),
		)!;
		await act(async () => login.click());
		await flush();

		expect(host.textContent).toContain(
			t("settings.mcpOauthLoginFailed", { error: "Could not discover OAuth endpoints" }),
		);
		expect(fake.calls("mcp.oauth.status")).toEqual([]);
	});

	test("status polling gives up after repeated RPC failures instead of waiting out the deadline", async () => {
		const fake = new FakeRpc();
		fake.handlers.set("extensions.list", () => extensionsResponse());
		fake.handlers.set("mcp.servers.list", () => serversResponse());
		fake.handlers.set("mcp.oauth.start", () => ({
			flowId: "flow-3",
			authorizationUrl: "https://auth.example.com/authorize?state=st",
		}));
		fake.handlers.set("mcp.oauth.status", () => Promise.reject(new Error("Unknown MCP OAuth flow: flow-3")));
		const host = await mount(fake);

		const login = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
			button => button.textContent?.trim() === t("settings.login"),
		)!;
		await act(async () => login.click());
		await flush();

		// Three consecutive failures at the 1s poll interval end the wait.
		await act(async () => {
			await Bun.sleep(3300);
		});
		await flush();

		expect(host.textContent).toContain(
			t("settings.mcpOauthLoginFailed", { error: "Unknown MCP OAuth flow: flow-3" }),
		);
		expect(host.textContent).not.toContain(t("settings.mcpOauthLoginWaiting"));
	});

	test("desktop login asks for the custom-scheme deep-link callback", async () => {
		Object.defineProperty(window, "electronAPI", {
			value: { openExternal: async () => true },
			configurable: true,
		});
		try {
			const fake = new FakeRpc();
			fake.handlers.set("extensions.list", () => extensionsResponse());
			fake.handlers.set("mcp.servers.list", () => serversResponse());
			fake.handlers.set("mcp.oauth.start", () => ({
				flowId: "flow-4",
				authorizationUrl: "https://auth.example.com/authorize?state=st",
			}));
			fake.handlers.set("mcp.oauth.status", () => ({
				flowId: "flow-4",
				server: "oauth-server",
				status: "pending",
			}));
			const host = await mount(fake);

			const login = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
				button => button.textContent?.trim() === t("settings.login"),
			)!;
			await act(async () => login.click());
			await flush();

			expect(fake.calls("mcp.oauth.start")).toEqual([
				{ name: "oauth-server", redirectUri: "musepi://oauth/callback" },
			]);
		} finally {
			Reflect.deleteProperty(window, "electronAPI");
		}
	});
});
