import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcClient } from "../src/lib/rpc";
import ModelSettingsPage from "../src/plugins/ui-settings-models/page";

const mounted = new Set<Root>();

async function flush(frames = 5): Promise<void> {
	await act(async () => {
		for (let index = 0; index < frames; index++) await Bun.sleep(5);
	});
}

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

/** Mount the model page with its catalog served by the given rpc — the page
 *  reads `providers.list` / `models.listCustom` itself since it moved into the
 *  settings-model package. */
async function renderProviders(
	rpc: RpcClient,
	options: {
		oauth?: unknown[];
		api?: unknown[];
	} = {},
): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	const catalog = {
		oauth: options.oauth ?? [
			{
				id: "agnes-global",
				name: "Sapiens AI (Agnes) (Global)",
				available: true,
				loggedIn: false,
				loginKind: "api-key",
			},
		],
		api: options.api ?? [
			{
				id: "agnes-global",
				name: "Sapiens AI (Agnes) (Global)",
				modelCount: 5,
				models: ["agnes-3.0-flash"],
				configured: false,
			},
		],
	};
	const original = rpc.request.bind(rpc);
	(rpc as unknown as { request: typeof rpc.request }).request = (async (method: string, params?: unknown) => {
		if (method === "providers.list") return catalog;
		if (method === "models.listCustom") return { providers: {} };
		return original(method, params as never);
	}) as typeof rpc.request;
	await act(async () => root.render(<ModelSettingsPage rpc={rpc} sessionId={null} />));
	await flush(10);
	const providersTab = [...document.body.querySelectorAll<HTMLButtonElement>("[role=tab]")].find(
		tab => tab.textContent === t("settings.providers"),
	);
	await act(async () => providersTab?.click());
	await flush();
	const actions = document.body.querySelector<HTMLButtonElement>(`[aria-label="${t("general.providerActions")}"]`);
	await act(async () => actions?.click());
	await flush();
}

function rpcWithImportError(): RpcClient {
	return {
		request: async (method: string) => {
			if (method === "providers.importApiKey") throw new Error("Cannot use a closed database");
			if (method === "models.list" || method === "models.catalog") return [];
			return null;
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
}

describe("provider setup actions", () => {
	it("offers one API-key action instead of duplicate login and import actions", async () => {
		await renderProviders(rpcWithImportError());
		const menu = document.body.querySelector(".gui-creds-menu");
		expect(menu?.textContent).toContain(t("general.importApiKey"));
		expect(menu?.textContent).not.toContain(t("settings.login"));
	});

	it("keeps the real OAuth action when it shares a credential store with an API-key flow", async () => {
		// The page issues the login itself now, so the assertion watches the RPC
		// the click produces rather than a host callback.
		const logins: string[] = [];
		const rpc = rpcWithImportError();
		const originalRequest = rpc.request.bind(rpc);
		(rpc as unknown as { request: typeof rpc.request }).request = (async (method: string, params?: unknown) => {
			if (method === "providers.login") logins.push(String((params as { providerId?: string })?.providerId));
			return originalRequest(method, params as never);
		}) as typeof rpc.request;
		await renderProviders(rpc, {
			oauth: [
				{ id: "zai", name: "Z.AI", available: true, loggedIn: false, loginKind: "api-key" },
				{
					id: "zai-coding-plan",
					name: "Z.AI Coding Plan",
					available: true,
					loggedIn: false,
					loginKind: "oauth",
					storeCredentialsAs: "zai",
				},
			],
			api: [{ id: "zai", name: "Z.AI", modelCount: 1, models: ["glm-5.2"], configured: false }],
		});
		const login = [...document.body.querySelectorAll<HTMLButtonElement>(".gui-creds-menu button")].find(button =>
			button.textContent?.includes(t("settings.login")),
		);
		expect(login).toBeDefined();
		await act(async () => login?.click());
		// Selecting an action closes the menu; its exit animation timer updates
		// MenuPopup after CLOSE_MS, so let it land inside act before leaving.
		await flush(30);
		expect(logins).toEqual(["zai-coding-plan"]);
	});

	it("keeps an import failure visible in the dialog", async () => {
		await renderProviders(rpcWithImportError());
		const importAction = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(button =>
			button.textContent?.includes(t("general.importApiKey")),
		);
		await act(async () => importAction?.click());
		// Same exit-animation window as the login action above: the menu closes
		// while the import dialog opens.
		await flush(30);
		const input = document.body.querySelector<HTMLInputElement>(".gui-provider-flow-dialog input");
		expect(input).not.toBeNull();
		await act(async () => {
			Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, "sk-test");
			const propsKey = Object.keys(input!).find(key => key.startsWith("__reactProps$"));
			const props = input![propsKey as keyof HTMLInputElement] as unknown as {
				onChange(event: { target: HTMLInputElement }): void;
			};
			props.onChange({ target: input! });
			await Bun.sleep(0);
		});
		const submit = [...document.body.querySelectorAll<HTMLButtonElement>(".gui-provider-flow-dialog button")].find(
			button => button.textContent === t("general.import"),
		);
		expect(submit?.disabled).toBe(false);
		await act(async () => submit?.click());
		await flush(10);
		expect(document.body.querySelector(".gui-provider-flow-dialog")?.textContent).toContain(
			"Cannot use a closed database",
		);
	});
});
