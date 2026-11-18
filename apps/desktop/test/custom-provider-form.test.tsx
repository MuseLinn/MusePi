import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	CustomProviderForm,
	type CustomProviderPayload,
	customProviderDraftFrom,
	emptyCustomProviderDraft,
} from "../src/components/CustomProviderForm";
import type { RpcClient } from "../src/lib/rpc";

const mounted = new Set<Root>();

async function flush(frames = 6): Promise<void> {
	await act(async () => {
		for (let index = 0; index < frames; index++) await Bun.sleep(5);
	});
}

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

function rpcStub(): RpcClient {
	return {
		request: async (): Promise<unknown> => ({}),
		addEventListener: () => () => {},
	} as unknown as RpcClient;
}

async function render(container: HTMLElement, element: React.ReactNode): Promise<Root> {
	const root = createRoot(container);
	mounted.add(root);
	await act(async () => root.render(element));
	await flush();
	return root;
}

/** happy-dom does not always surface native input events to React's delegated
 *  listener; drive the wired onChange through React props with the native
 *  setter (the pattern capability-panel.test.tsx uses). */
async function typeField(container: HTMLElement, ariaLabel: string, value: string): Promise<void> {
	const input = container.querySelector<HTMLInputElement>(`input[aria-label="${ariaLabel}"]`);
	if (!input) throw new Error(`no input labelled ${ariaLabel}`);
	const propsKey = Object.keys(input).find(key => key.startsWith("__reactProps$"));
	const props = (input as unknown as Record<string, { onChange?: (e: { target: Element }) => void }>)[propsKey!];
	if (!props?.onChange) throw new Error(`input ${ariaLabel} has no React onChange`);
	Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
	await act(async () => props.onChange!({ target: input }));
	await flush();
}

async function clickButton(container: HTMLElement, text: string): Promise<void> {
	const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		candidate => candidate.textContent?.trim() === text,
	);
	if (!button) throw new Error(`no button "${text}"`);
	await act(async () => button.click());
	await flush();
}

describe("custom provider form", () => {
	it("submits the display name, provider id, endpoint and model rows", async () => {
		const submitted: CustomProviderPayload[] = [];
		const container = document.createElement("div");
		document.body.appendChild(container);
		await render(
			container,
			<CustomProviderForm
				rpc={rpcStub()}
				mode="create"
				initial={emptyCustomProviderDraft()}
				submitLabel="Create"
				onSubmit={provider => {
					submitted.push(provider);
				}}
			/>,
		);

		await typeField(container, t("settings.providerLabel"), "My Gateway");
		await typeField(container, t("settings.providerName"), "my-gw");
		await typeField(container, "Base URL", "https://gw.example/v1");
		await clickButton(container, t("settings.addModel"));
		await typeField(container, t("settings.modelId"), "a/model");
		await clickButton(container, "Create");

		expect(submitted).toHaveLength(1);
		expect(submitted[0]).toEqual({
			name: "my-gw",
			label: "My Gateway",
			baseUrl: "https://gw.example/v1",
			models: [{ id: "a/model" }],
		});
	});

	it("edits with the provider id locked and re-sends the stored label and model fields", async () => {
		const submitted: CustomProviderPayload[] = [];
		const draft = customProviderDraftFrom("my-gw", {
			label: "My Gateway",
			baseUrl: "https://gw.example/v1",
			models: [{ id: "m1", name: "Model One", contextWindow: 8000 }],
		});
		const container = document.createElement("div");
		document.body.appendChild(container);
		await render(
			container,
			<CustomProviderForm
				rpc={rpcStub()}
				mode="edit"
				initial={draft}
				submitLabel="Save"
				onSubmit={provider => {
					submitted.push(provider);
				}}
			/>,
		);

		expect(
			container.querySelector<HTMLInputElement>(`input[aria-label="${t("settings.providerName")}"]`)?.disabled,
		).toBe(true);
		await clickButton(container, "Save");
		expect(submitted[0]?.label).toBe("My Gateway");
		expect(submitted[0]?.models).toEqual([{ id: "m1", name: "Model One", contextWindow: 8000 }]);
	});

	it("fetching reconciles the list: new rows added, dropped rows removed", async () => {
		const submitted: CustomProviderPayload[] = [];
		const rpc = {
			request: async (method: string): Promise<unknown> => {
				if (method === "models.discover") {
					return { models: [{ id: "a/model" }, { id: "b/model", name: "B" }] };
				}
				return {};
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		const initial = customProviderDraftFrom("my-gw", {
			baseUrl: "https://gw.example/v1",
			models: [{ id: "a/model" }, { id: "gone/model" }],
		});
		const container = document.createElement("div");
		document.body.appendChild(container);
		await render(
			container,
			<CustomProviderForm
				rpc={rpc}
				mode="edit"
				initial={initial}
				submitLabel="Save"
				onSubmit={provider => {
					submitted.push(provider);
				}}
			/>,
		);

		await clickButton(container, t("settings.fetchAvailableModels"));
		// The endpoint returns a/model (already listed) and b/model; gone/model
		// is checked for removal by default.
		const apply = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(candidate =>
			candidate.textContent?.includes(t("settings.applyModelChanges", { add: 1, remove: 1 })),
		);
		expect(apply).toBeDefined();
		await act(async () => apply!.click());
		await flush();
		await clickButton(container, "Save");

		expect(submitted[0]?.models.map(model => model.id)).toEqual(["a/model", "b/model"]);
	});

	it("refuses an empty provider before calling the daemon", async () => {
		let calls = 0;
		const container = document.createElement("div");
		document.body.appendChild(container);
		await render(
			container,
			<CustomProviderForm
				rpc={rpcStub()}
				mode="create"
				initial={emptyCustomProviderDraft()}
				submitLabel="Create"
				onSubmit={() => {
					calls += 1;
				}}
			/>,
		);

		await clickButton(container, "Create");
		expect(calls).toBe(0);
		expect(container.textContent).toContain(t("settings.providerNameBase.info2"));
	});
});
