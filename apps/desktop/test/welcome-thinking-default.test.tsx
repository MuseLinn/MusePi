import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HeroComposer } from "../src/components/HeroComposer";
import { thinkingLabel } from "../src/components/thinking-selector-shared";
import type { RpcClient } from "../src/lib/rpc";

const DETAILS: Record<string, { efforts: string[]; defaultLevel?: string }> = {
	// The model from the report: medium is not in its ladder.
	"p/alpha": { efforts: ["low", "high", "max"], defaultLevel: "high" },
	"p/beta": { efforts: ["low", "medium", "high"], defaultLevel: "medium" },
	"p/no-default": { efforts: ["low", "high", "max"] },
};

const rpc = {
	request: async (method: string, params?: unknown) => {
		if (method === "models.detail") {
			const id = (params as { id?: string } | undefined)?.id ?? "";
			return DETAILS[id] ?? null;
		}
		if (method.startsWith("models.list")) return [];
		if (method === "git.branches") return { error: "not a repository" };
		return null;
	},
	addEventListener: () => () => {},
} as unknown as RpcClient;

const roots = new Set<Root>();
afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
	localStorage.clear();
});

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

function chip(container: HTMLElement): string {
	return container.querySelector(".gui-model-capsule-seg-text--thinking")?.textContent ?? "";
}

describe("empty-state thinking level follows the selected model", () => {
	it("shows the model's own default, then re-defaults and re-clamps on a model switch", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		roots.add(root);

		const render = async (modelId: string): Promise<void> => {
			await act(async () => root.render(<HeroComposer onSubmit={() => {}} rpc={rpc} presetModelId={modelId} />));
			await flush();
		};

		await render("p/alpha");
		expect(chip(container)).toBe(thinkingLabel("high"));

		await render("p/beta");
		expect(chip(container)).toBe(thinkingLabel("medium"));

		// No declared default: the global default does not exist in this ladder,
		// so the chip falls to the first supported rung instead of keeping 中.
		await render("p/no-default");
		expect(chip(container)).toBe(thinkingLabel("low"));
	});

	it("capsule trigger carries neither the chevron nor the thinking icon", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		roots.add(root);

		await act(async () => root.render(<HeroComposer onSubmit={() => {}} rpc={rpc} presetModelId="p/alpha" />));
		await flush();

		const capsule = container.querySelector(".gui-model-capsule");
		expect(capsule).not.toBeNull();
		expect(capsule!.querySelector('use[href="#oc-arrow-down-s"]')).toBeNull();
		expect(capsule!.querySelector('use[href="#oc-brain"]')).toBeNull();
	});
});
