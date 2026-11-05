import "./happy-dom-shim";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { INTEGRATION_CATALOG } from "../src/plugins/integrations/catalog";
import { apply } from "../src/plugins/integrations/index";
import IntegrationsPage from "../src/plugins/integrations/page";

/**
 * The integrations page is the only writer of the user-scope connector file
 * besides `/mcp add`, so these tests pin the externally visible contract:
 * catalog coverage, filtering, and the exact RPC payloads an install/remove
 * sends (a token must travel as the entry's header, OAuth as `auth.type`).
 */

const roots = new Set<Root>();
const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
});

afterAll(() => setLocale(previousLocale));

interface Call {
	method: string;
	params?: Record<string, unknown>;
}

interface ServerRow {
	name: string;
	transport?: "stdio" | "http" | "sse";
	url?: string;
	auth?: "oauth" | "apikey";
}

function rpcStub(initial: string[]) {
	const calls: Call[] = [];
	const servers: ServerRow[] = initial.map(name => ({ name, transport: "http" }));
	return {
		calls,
		rpc: {
			async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
				calls.push({ method, params });
				if (method === "mcp.servers.list") return { servers: [...servers] };
				if (method === "mcp.servers.add") {
					servers.push({ name: String(params?.name), transport: "http" });
					return { ok: true };
				}
				if (method === "mcp.servers.remove") {
					const index = servers.findIndex(server => server.name === params?.name);
					if (index >= 0) servers.splice(index, 1);
					return { ok: true };
				}
				return {};
			},
			addEventListener: () => () => {},
		} as never,
	};
}

async function mount(rpc: unknown): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.add(root);
	await act(async () => root.render(<IntegrationsPage rpc={rpc as never} />));
	await act(async () => Bun.sleep(20));
	return container;
}

function card(container: HTMLElement, id: string): HTMLElement | null {
	return container.querySelector<HTMLElement>(`[data-integration-id="${id}"]`);
}

function typeInto(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("integrations catalog", () => {
	it("registers the integrations settings tab", () => {
		const components: unknown[] = [];
		apply({
			setLabel() {},
			registerComponent(component: unknown) {
				components.push(component);
			},
		} as never);
		expect(components).toEqual([
			expect.objectContaining({ slot: "settings.tab.integrations", moduleUrl: "./page.tsx", label: "集成" }),
		]);
	});

	it("ships exactly the twelve vetted connectors with their transport facts", () => {
		expect(INTEGRATION_CATALOG.map(entry => entry.id)).toEqual([
			"linear",
			"atlassian",
			"notion",
			"asana",
			"github",
			"figma",
			"supabase",
			"neon",
			"sentry",
			"cloudflare",
			"vercel",
			"dropbox",
		]);
		const github = INTEGRATION_CATALOG.find(entry => entry.id === "github");
		expect(github).toMatchObject({
			auth: "token",
			url: "https://api.githubcopilot.com/mcp/",
			tokenHeader: { name: "Authorization", valuePrefix: "Bearer " },
		});
		expect(INTEGRATION_CATALOG.find(entry => entry.id === "linear")).toMatchObject({
			auth: "oauth",
			url: "https://mcp.linear.app/mcp",
		});
	});
});

describe("integrations page", () => {
	it("renders every catalog card and filters by search", async () => {
		const { rpc } = rpcStub([]);
		const container = await mount(rpc);

		expect(container.querySelectorAll("[data-integration-id]")).toHaveLength(INTEGRATION_CATALOG.length);

		const search = container.querySelector<HTMLInputElement>(".gui-integrations-search");
		expect(search).not.toBeNull();
		await act(async () => typeInto(search!, "notion"));

		const ids = [...container.querySelectorAll("[data-integration-id]")].map(node =>
			node.getAttribute("data-integration-id"),
		);
		expect(ids).toEqual(["notion"]);
	});

	it("filters by category chip", async () => {
		const { rpc } = rpcStub([]);
		const container = await mount(rpc);

		await act(async () => container.querySelector<HTMLButtonElement>('[data-category="data"]')?.click());

		const ids = [...container.querySelectorAll("[data-integration-id]")].map(node =>
			node.getAttribute("data-integration-id"),
		);
		expect(ids).toEqual(["supabase", "neon"]);
	});

	it("installs an OAuth connector as auth.type=oauth and then offers removal", async () => {
		const { rpc, calls } = rpcStub([]);
		const container = await mount(rpc);

		await act(async () =>
			card(container, "linear")?.querySelector<HTMLButtonElement>(".gui-integrations-install")?.click(),
		);
		await act(async () => Bun.sleep(20));

		const add = calls.find(call => call.method === "mcp.servers.add");
		expect(add?.params).toMatchObject({
			name: "linear",
			url: "https://mcp.linear.app/mcp",
			auth: { type: "oauth" },
		});
		expect(add?.params?.headers).toBeUndefined();

		expect(card(container, "linear")?.textContent).toContain("已安装");
		expect(card(container, "linear")?.querySelector(".gui-integrations-remove")).not.toBeNull();

		await act(async () =>
			card(container, "linear")?.querySelector<HTMLButtonElement>(".gui-integrations-remove")?.click(),
		);
		await act(async () => Bun.sleep(20));

		expect(calls.find(call => call.method === "mcp.servers.remove")?.params).toEqual({ name: "linear" });
		expect(card(container, "linear")?.querySelector(".gui-integrations-install")).not.toBeNull();
	});

	it("requires a token and sends it as the GitHub Authorization header", async () => {
		const { rpc, calls } = rpcStub([]);
		const container = await mount(rpc);
		const github = card(container, "github");
		const install = github?.querySelector<HTMLButtonElement>(".gui-integrations-install");
		expect(install?.disabled).toBe(true);

		await act(async () => typeInto(github!.querySelector<HTMLInputElement>(".gui-integrations-token")!, "ghp_test"));
		await act(async () =>
			card(container, "github")?.querySelector<HTMLButtonElement>(".gui-integrations-install")?.click(),
		);
		await act(async () => Bun.sleep(20));

		const add = calls.find(call => call.method === "mcp.servers.add");
		expect(add?.params).toMatchObject({
			name: "github",
			url: "https://api.githubcopilot.com/mcp/",
			headers: { Authorization: "Bearer ghp_test" },
		});
		expect(add?.params?.auth).toBeUndefined();
	});

	it("shows configured servers as installed on mount", async () => {
		const { rpc } = rpcStub(["figma"]);
		const container = await mount(rpc);

		expect(card(container, "figma")?.textContent).toContain("已安装");
		expect(card(container, "figma")?.querySelector(".gui-integrations-remove")).not.toBeNull();
		expect(card(container, "notion")?.querySelector(".gui-integrations-install")).not.toBeNull();
	});
});
