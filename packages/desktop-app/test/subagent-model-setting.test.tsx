import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SubagentsSection } from "../src/components/settings-sections/subagents";
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

function stubRpc(stored: Record<string, unknown>, writes: Array<{ key: string; value: unknown }>): RpcClient {
	return {
		request: async (method: string, params?: Record<string, unknown>) => {
			if (method === "settings.schema") {
				return {
					tasks: [
						{
							key: "task.subagentModel",
							type: "string",
							ui: { label: "Subagent Model", description: "Model every subagent runs on." },
						},
					],
				};
			}
			if (method === "settings.get") {
				const keys = (params?.keys as string[] | undefined) ?? [];
				return Object.fromEntries(keys.map(key => [key, stored[key]]));
			}
			if (method === "models.listAvailable") {
				return [{ id: "glm-5.2", provider: "zai", name: "GLM 5.2" }];
			}
			if (method === "settings.set") {
				writes.push({ key: String(params?.key), value: params?.value });
				return null;
			}
			return null;
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
}

async function renderSection(stored: Record<string, unknown>, writes: Array<{ key: string; value: unknown }>) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	await act(async () => root.render(<SubagentsSection rpc={stubRpc(stored, writes)} />));
	await flush();
	const trigger = () => container.querySelector<HTMLButtonElement>(`[aria-label="${t("Subagent Model")}"]`);
	return { container, trigger };
}

describe("subagent model setting", () => {
	it("offers follow-default plus role aliases and catalog models, and persists picks", async () => {
		const writes: Array<{ key: string; value: unknown }> = [];
		const { container, trigger } = await renderSection(
			{ "task.subagentModel": "@smol", knownRoleIds: ["default", "smol", "task"] },
			writes,
		);

		// The custom picker replaces the schema renderer's text input for this
		// key, so exactly one control carries the row label.
		expect(container.querySelectorAll(`[aria-label="${t("Subagent Model")}"]`)).toHaveLength(1);
		expect(trigger()?.textContent).toContain("@smol");

		await act(async () => trigger()?.click());
		const options = [...document.body.querySelectorAll<HTMLButtonElement>("[role=option]")];
		const labels = options.map(option => option.textContent);
		expect(labels[0]).toBe(t("settings.subagentModelFollowDefault"));
		expect(labels).toContain("@task");
		expect(labels).toContain("zai/glm-5.2");

		await act(async () => options.find(option => option.textContent === "zai/glm-5.2")?.click());
		expect(writes.at(-1)).toEqual({ key: "task.subagentModel", value: "zai/glm-5.2" });
		expect(trigger()?.textContent).toContain("zai/glm-5.2");

		await act(async () => trigger()?.click());
		const reopened = [...document.body.querySelectorAll<HTMLButtonElement>("[role=option]")];
		await act(async () => reopened[0]?.click());
		expect(writes.at(-1)).toEqual({ key: "task.subagentModel", value: "" });
		expect(trigger()?.textContent).toContain(t("settings.subagentModelFollowDefault"));
	});

	it("keeps a stored selector the lists no longer offer selectable", async () => {
		const writes: Array<{ key: string; value: unknown }> = [];
		const { trigger } = await renderSection(
			{ "task.subagentModel": "hand/written-pattern", knownRoleIds: ["default"] },
			writes,
		);

		expect(trigger()?.textContent).toContain("hand/written-pattern");
		await act(async () => trigger()?.click());
		const options = [...document.body.querySelectorAll<HTMLButtonElement>("[role=option]")];
		expect(options.some(option => option.textContent === "hand/written-pattern")).toBe(true);
		expect(writes).toEqual([]);
	});
});
