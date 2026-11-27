import "./happy-dom-shim";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale, t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HeroComposer } from "../src/components/HeroComposer";
import type { RpcClient } from "../src/lib/rpc";

/**
 * The creator mode has ONE Chinese name across the product.
 *
 * The mode's own preset text says 创造模式 (`presets/resolve.ts`,
 * `commands.presetCreatorName`), so every surface that names the mode must say
 * the same word. The empty-state chip and the picker both read
 * `resolveModeLabel` → i18n `mode creator`; the labelling table also carries
 * `general.modeCreator`. A regression here is visible to the user as the chip
 * disagreeing with the preset itself, so the assertion is on RENDERED text —
 * a key existing with any string would pass a key-set parity test.
 */

const roots = new Set<Root>();
const previousLocale = getLocaleSnapshot();

setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
});

const rpc = {
	request: async (method: string) => (method === "settings.get" ? {} : null),
	addEventListener: () => () => {},
} as unknown as RpcClient;

const MODES = [
	{ id: "work", label: "Work" },
	{ id: "creator", label: "Creator" },
];

async function mountCreator(): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.add(root);
	await act(async () =>
		root.render(
			<HeroComposer
				onSubmit={() => {}}
				rpc={rpc}
				modes={MODES}
				agentPreset="creator"
				onModeChange={() => {}}
				onProject={() => {}}
			/>,
		),
	);
	await act(async () => Bun.sleep(60));
	return container;
}

describe("creator mode naming", () => {
	it("the empty-state chip renders 创造模式, the same word the preset uses", async () => {
		const container = await mountCreator();
		const chip = container.querySelector(".gui-project-chip");
		expect(chip).not.toBeNull();
		const texts = [...container.querySelectorAll(".gui-project-chip")].map(node => node.textContent ?? "");
		expect(texts.some(text => text.includes("创造模式"))).toBe(true);
		expect(texts.some(text => text.includes("创作模式"))).toBe(false);
	});

	it("the i18n label and the mode's own name are one word", () => {
		expect(t("general.modeCreator")).toBe("创造模式");
		expect(t("mode creator")).toBe("创造模式");
	});
});
