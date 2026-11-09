import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConnectorsSection } from "../src/components/settings-sections/connectors";
import type { RpcClient, StreamEvent } from "../src/lib/rpc";

/**
 * Settings → 连接器: catalog rows and the connect/OAuth hand-off.
 *
 * Pinned contracts:
 *  1. `connectors.catalog.list` drives one row per connector with auth and
 *     live status, and the search box filters locally.
 *  2. Connecting calls `connectors.connect`; when the result asks for auth the
 *     same `mcp.oauth.start`/`status` flow the MCP page uses is started with
 *     the returned `connector:<id>` server name.
 *  3. A connector with `authMode: "none"` connects without starting OAuth.
 *  4. Disconnecting calls `connectors.disconnect`.
 */

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});
interface CannedRequest {
	method: string;
	params: unknown;
}

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
		return this.requests.filter(request => request.method === method).map(request => request.params);
	}
}

const asRpc = (fake: FakeRpc): RpcClient => fake as unknown as RpcClient;

function catalogResponse(): Record<string, unknown> {
	return {
		connectors: [
			{
				id: "alpha",
				name: "Alpha Meetings",
				description: "Schedule meetings",
				server: { transport: "http", url: "https://alpha.example/mcp" },
				authMode: "oauth",
				enabled: false,
				status: "disconnected",
			},
			{
				id: "beta",
				name: "Beta Docs",
				description: "Search documents",
				server: { transport: "http", url: "https://beta.example/mcp" },
				authMode: "none",
				enabled: true,
				status: "connected",
			},
			{
				id: "echo-cli",
				name: "Echo CLI",
				description: "Managed CLI",
				kind: "cli",
				cliAuth: true,
				authMode: "none",
				tokenSet: true,
				enabled: false,
				status: "disconnected",
			},
			{
				id: "delta",
				name: "Delta Stdio",
				description: "Local process",
				server: { transport: "stdio", command: "node" },
				authMode: "none",
				tokenSet: true,
				enabled: false,
				status: "disconnected",
			},
			{
				id: "gamma",
				name: "Gamma API",
				description: "Token protected",
				server: { transport: "http", url: "https://gamma.example/mcp" },
				authMode: "token",
				tokenSet: false,
				tokenSchema: {
					fields: [{ key: "API_KEY", label: "API key", type: "password", required: true }],
				},
				enabled: false,
				status: "disconnected",
			},
		],
	};
}

const mounted = new Set<Root>();

async function mount(fake: FakeRpc): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.add(root);
	await act(async () => root.render(createElement(ConnectorsSection, { rpc: asRpc(fake) })));
	await flush();
	return host;
}

async function flush(frames = 6): Promise<void> {
	await act(async () => {
		for (let index = 0; index < frames; index++) await Bun.sleep(10);
	});
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
	const found = [...host.querySelectorAll("button")].find(candidate => candidate.textContent?.trim() === label);
	if (!found) throw new Error(`button not found: ${label}`);
	return found as HTMLButtonElement;
}

function rowFor(host: HTMLElement, name: string): HTMLElement {
	const found = [...host.querySelectorAll<HTMLElement>(".gui-connector-card")].find(row =>
		row.textContent?.includes(name),
	);
	if (!found) throw new Error(`connector row not found: ${name}`);
	return found;
}

function typeInto(input: HTMLInputElement, value: string): void {
	// The DOM suites drive the React onChange through the props key; native
	// "input" events are ignored by this harness.
	const key = Object.keys(input).find(name => name.startsWith("__reactProps$"));
	const props = key ? (input as unknown as Record<string, { onChange?: (event: unknown) => void }>)[key] : undefined;
	if (!props?.onChange) throw new Error("no React onChange handler");
	input.value = value;
	props.onChange({ target: input, currentTarget: input });
}

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

describe("connector settings", () => {
	test("lists catalog rows and filters by query", async () => {
		const fake = new FakeRpc();
		fake.handlers.set("connectors.catalog.list", () => catalogResponse());
		const host = await mount(fake);

		expect(host.textContent).toContain("Alpha Meetings");
		expect(host.textContent).toContain("Beta Docs");
		expect(host.textContent).toContain("已连接");
		expect(host.textContent).toContain("未连接");

		const input = host.querySelector("input") as HTMLInputElement;
		await act(async () => typeInto(input, "beta"));
		await flush(2);
		expect(host.textContent).toContain("Beta Docs");
		expect(host.textContent).not.toContain("Alpha Meetings");
	});

	test("connect starts the shared OAuth flow with the connector server name", async () => {
		const fake = new FakeRpc();
		fake.handlers.set("connectors.catalog.list", () => catalogResponse());
		fake.handlers.set("connectors.connect", () => ({
			ok: true,
			id: "alpha",
			name: "Alpha Meetings",
			serverName: "connector:alpha",
			needsAuth: true,
			status: "connecting",
		}));
		fake.handlers.set("mcp.oauth.start", () => ({
			flowId: "flow-1",
			authorizationUrl: "https://auth.example/authorize",
		}));
		fake.handlers.set("mcp.oauth.status", () => ({ flowId: "flow-1", server: "connector:alpha", status: "success" }));

		const host = await mount(fake);
		const connect = button(host, "连接");
		await act(async () => connect.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await flush(4);

		expect(fake.calls("connectors.connect")).toEqual([{ id: "alpha" }]);
		expect(fake.calls("mcp.oauth.start")).toEqual([{ name: "connector:alpha" }]);

		await Bun.sleep(1100);
		await flush(4);
		expect(fake.calls("connectors.catalog.list").length).toBeGreaterThan(1);
	});

	test("skips OAuth for an open connector and disconnects an enabled one", async () => {
		const fake = new FakeRpc();
		fake.handlers.set("connectors.catalog.list", () => catalogResponse());
		fake.handlers.set("connectors.connect", () => ({
			ok: true,
			id: "beta",
			name: "Beta Docs",
			serverName: "connector:beta",
			needsAuth: false,
			status: "connected",
		}));
		fake.handlers.set("connectors.disconnect", () => ({ ok: true, id: "beta" }));

		const host = await mount(fake);
		// `beta` is already enabled, so its row shows 断开; connecting it is not
		// the path under test here. `alpha` is disabled and open-auth in this
		// fake, so it exercises the no-OAuth connect path.
		fake.handlers.set("connectors.connect", () => ({
			ok: true,
			id: "alpha",
			name: "Alpha Meetings",
			serverName: "connector:alpha",
			needsAuth: false,
			status: "connected",
		}));
		const connect = button(host, "连接");
		await act(async () => connect.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await flush(4);
		expect(fake.calls("mcp.oauth.start")).toEqual([]);

		const disconnect = button(host, "断开");
		await act(async () => disconnect.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await flush(4);
		expect(fake.calls("connectors.disconnect")).toEqual([{ id: "beta" }]);
	});

	test("shows the token form when connect reports needsTokenConfig", async () => {
		const fake = new FakeRpc();
		fake.handlers.set("connectors.catalog.list", () => catalogResponse());
		let connects = 0;
		fake.handlers.set("connectors.connect", () => {
			connects += 1;
			return connects === 1
				? {
						ok: false,
						id: "gamma",
						name: "Gamma API",
						serverName: "connector:gamma",
						needsAuth: false,
						needsTokenConfig: true,
						status: "disconnected",
					}
				: {
						ok: true,
						id: "gamma",
						name: "Gamma API",
						serverName: "connector:gamma",
						needsAuth: false,
						status: "connected",
					};
		});
		fake.handlers.set("connectors.token.save", () => ({ ok: true, id: "gamma", tokenSet: true }));

		const host = await mount(fake);
		const initialRow = rowFor(host, "Gamma API");
		await act(async () => button(initialRow, "连接").dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await flush(4);

		const row = rowFor(host, "Gamma API");
		const input = row.querySelector("input") as HTMLInputElement;
		expect(input).toBeDefined();
		await act(async () => typeInto(input, "secret"));
		await act(async () => button(row, "保存并连接").dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await flush(4);

		expect(fake.calls("connectors.token.save")).toEqual([{ id: "gamma", values: { API_KEY: "secret" } }]);
		expect(fake.calls("connectors.connect")).toHaveLength(2);
	});
	test("asks for explicit approval before enabling a stdio connector", async () => {
		const fake = new FakeRpc();
		fake.handlers.set("connectors.catalog.list", () => catalogResponse());
		const calls: unknown[] = [];
		fake.handlers.set("connectors.connect", params => {
			calls.push(params);
			const id = (params as { id?: string }).id;
			if (id !== "delta") return { ok: true, id, needsAuth: false, status: "connected" };
			return (params as { approve?: boolean }).approve
				? {
						ok: true,
						id,
						name: "Delta Stdio",
						serverName: "connector:delta",
						needsAuth: false,
						status: "connected",
					}
				: {
						ok: false,
						id,
						name: "Delta Stdio",
						serverName: "connector:delta",
						needsAuth: false,
						needsApproval: true,
						command: "node",
						args: ["server.js"],
						status: "disconnected",
					};
		});

		const host = await mount(fake);
		const row = rowFor(host, "Delta Stdio");
		await act(async () => button(row, "连接").dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await flush(4);

		const approvalRow = rowFor(host, "Delta Stdio");
		expect(approvalRow.textContent).toContain("node server.js");
		const approveButton = button(approvalRow, "允许并连接");
		await act(async () => approveButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await flush(4);

		expect(calls).toEqual([{ id: "delta" }, { id: "delta", approve: true }]);
	});
	test("runs a CLI connector through approval and device-code authorization", async () => {
		const fake = new FakeRpc();
		fake.handlers.set("connectors.catalog.list", () => catalogResponse());
		const calls: unknown[] = [];
		fake.handlers.set("connectors.connect", params => {
			calls.push(params);
			const input = params as { id?: string; approve?: boolean };
			if (input.id !== "echo-cli") return { ok: true, id: input.id, needsAuth: false, status: "connected" };
			if (!input.approve) {
				return {
					ok: false,
					id: input.id,
					name: "Echo CLI",
					serverName: "connector:echo-cli",
					needsAuth: false,
					needsApproval: true,
					installCommand: "npm install -g echo-cli",
					authCommand: "echo-cli auth login",
					status: "disconnected",
				};
			}
			return {
				ok: false,
				id: input.id,
				name: "Echo CLI",
				serverName: "connector:echo-cli",
				needsAuth: false,
				needsCliAuth: true,
				flowId: "cli-flow-1",
				authorizationUrl: "https://example.com/device",
				userCode: "ABCD-1234",
				status: "connecting",
			};
		});
		fake.handlers.set("connectors.cli.status", () => ({
			flowId: "cli-flow-1",
			connectorId: "echo-cli",
			status: "success",
		}));
		fake.handlers.set("connectors.cli.cancel", () => ({ ok: true }));

		const host = await mount(fake);
		const row = rowFor(host, "Echo CLI");
		expect(row.textContent).toContain("CLI 授权");
		expect(row.textContent).not.toContain("无需授权");
		await act(async () => button(row, "连接").dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await flush(4);

		const approval = rowFor(host, "Echo CLI");
		expect(approval.textContent).toContain("允许安装或授权 CLI");
		expect(approval.textContent).toContain("npm install -g echo-cli");
		await act(async () => button(approval, "允许并连接").dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await flush(4);

		const auth = rowFor(host, "Echo CLI");
		expect(auth.textContent).toContain("ABCD-1234");
		expect(auth.textContent).toContain("https://example.com/device");
		expect(calls).toEqual([{ id: "echo-cli" }, { id: "echo-cli", approve: true }]);

		await Bun.sleep(1100);
		await flush(4);
		expect(fake.calls("connectors.cli.status").length).toBeGreaterThan(0);
	});
});
