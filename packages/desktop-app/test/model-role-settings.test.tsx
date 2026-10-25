import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { type TranslationKey, t } from "@musepi/client-core";
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

describe("role model thinking and fallback editors", () => {
	it("preserves auto and edits each fallback model's thinking independently", async () => {
		const writes: Array<{ key: string; value: unknown }> = [];
		const roleModels: Record<string, string> = { default: "provider/a:auto" };
		const rpc = {
			request: async (method: string, params: Record<string, unknown>) => {
				if (method === "settings.get") {
					return {
						modelRoles: roleModels,
						cycleOrder: ["default"],
						knownRoleIds: ["default"],
						resolvedRoleModels: { default: { id: "a", name: "Model A", efforts: ["low", "high"] } },
						"retry.fallbackChains": { default: ["provider/b:high", "provider/c:auto"] },
					};
				}
				if (method === "settings.set") {
					writes.push({ key: String(params.key), value: params.value });
					return { resolvedRoleModels: { default: { id: "a", name: "Model A", efforts: ["low", "high"] } } };
				}
				if (method === "models.detail") {
					return { id: params.id, name: "Fallback model", efforts: ["minimal", "low", "high"] };
				}
				if (method === "models.list" || method === "models.catalog") return [];
				if (method === "settings.projectOverrides") return { overrides: [] };
				return null;
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		await act(async () =>
			root.render(
				<ModelSection
					providers={[]}
					apiProviders={[]}
					custom={[]}
					loginState={null}
					pendingLogins={[]}
					onLogin={() => {}}
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
		const mainThinking = container.querySelector<HTMLButtonElement>(".gui-role-thinking");
		expect(mainThinking?.textContent).toContain(t("general.auto"));
		const rows = [...container.querySelectorAll<HTMLElement>(".gui-role-fallback-row")];
		expect(rows).toHaveLength(2);
		expect(rows[0]?.querySelector(".gui-role-fallback-thinking")?.textContent).toContain("high");
		expect(rows[1]?.querySelector(".gui-role-fallback-thinking")?.textContent).toContain(t("general.auto"));

		const firstTrigger = rows[0]?.querySelector<HTMLButtonElement>(".gui-role-fallback-thinking");
		await act(async () => firstTrigger?.click());
		const autoOption = [...document.body.querySelectorAll<HTMLButtonElement>("[role=option]")].find(
			option => option.textContent === t("general.auto"),
		);
		expect(autoOption).toBeDefined();
		await act(async () => autoOption?.click());
		const fallbackWrite = writes.findLast(write => write.key === "retry.fallbackChains");
		expect(fallbackWrite?.value).toEqual({ default: ["provider/b:auto", "provider/c:auto"] });

		const secondTrigger = rows[1]?.querySelector<HTMLButtonElement>(".gui-role-fallback-thinking");
		await act(async () => secondTrigger?.click());
		const lowOption = [...document.body.querySelectorAll<HTMLButtonElement>("[role=option]")].find(
			option => option.textContent === t("thinking low" as TranslationKey),
		);
		expect(lowOption).toBeDefined();
		await act(async () => lowOption?.click());
		expect(writes.findLast(write => write.key === "retry.fallbackChains")?.value).toEqual({
			default: ["provider/b:auto", "provider/c:low"],
		});
		expect(roleModels.default).toBe("provider/a:auto");
	});
});
