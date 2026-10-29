import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModelSection } from "../src/components/settings-sections/model";
import type { RpcClient } from "../src/lib/rpc";

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

type ModelSectionProps = Parameters<typeof ModelSection>[0];

async function renderProviders(
	rpc: RpcClient,
	options: {
		oauth?: ModelSectionProps["providers"];
		api?: ModelSectionProps["apiProviders"];
		onLogin?: ModelSectionProps["onLogin"];
	} = {},
): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	await act(async () =>
		root.render(
			<ModelSection
				providers={
					options.oauth ?? [
						{
							id: "agnes-global",
							name: "Sapiens AI (Agnes) (Global)",
							available: true,
							loggedIn: false,
							loginKind: "api-key",
						},
					]
				}
				apiProviders={
					options.api ?? [
						{
							id: "agnes-global",
							name: "Sapiens AI (Agnes) (Global)",
							modelCount: 5,
							models: ["agnes-3.0-flash"],
							configured: false,
						},
					]
				}
				custom={[]}
				loginState={null}
				pendingLogins={[]}
				onLogin={options.onLogin ?? (() => {})}
				onLogout={() => {}}
				onSubmitInput={() => {}}
				onCancelLogin={() => {}}
				onChanged={() => {}}
				rpc={rpc}
				sessionId={null}
			/>,
		),
	);
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
		const logins: string[] = [];
		await renderProviders(rpcWithImportError(), {
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
			onLogin: id => logins.push(id),
		});
		const login = [...document.body.querySelectorAll<HTMLButtonElement>(".gui-creds-menu button")].find(button =>
			button.textContent?.includes(t("settings.login")),
		);
		expect(login).toBeDefined();
		await act(async () => login?.click());
		expect(logins).toEqual(["zai-coding-plan"]);
	});

	it("keeps an import failure visible in the dialog", async () => {
		await renderProviders(rpcWithImportError());
		const importAction = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(button =>
			button.textContent?.includes(t("general.importApiKey")),
		);
		await act(async () => importAction?.click());
		await flush();
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
