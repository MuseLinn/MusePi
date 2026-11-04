/**
 * Contract: the design/asset briefs are owned by the `design-guidance` bundled
 * plugin, not by the host's rebuild path.
 *
 * The plugin registers FUNCTION prompt sections: the brief is rendered from the
 * selection the host passes into assembly, so switching the selection changes
 * the one visible section instead of stacking another. Disabling the plugin
 * removes its source and therefore the brief.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	clearExtensionDesignSystems,
	registerExtensionDesignSystem,
} from "@musepi/pi-coding-agent/presets/design-systems";
import { PromptComposer } from "@musepi/pi-coding-agent/prompts/composer";
import { ExtensionRuntime } from "../src/extensibility/extensions/loader";
import { mountPlugin } from "../src/extensibility/plugins/runtime/mount";
import { EventBus } from "../src/utils/event-bus";

const ENTRY = path.join(import.meta.dir, "..", "src", "bundled-plugins", "design-guidance", "index.ts");
const SOURCE = "ext:design-guidance";
const GLASS_HEAD = "设计体系「玻璃拟态」";
const MINIMAL_HEAD = "设计体系「极简留白」";
const PLACEHOLDER_HEAD = "素材策略（色块占位）";
const AI_IMAGE_HEAD = "素材策略（AI 生图）";

async function mountGuidance() {
	const result = await mountPlugin({
		entryPath: ENTRY,
		cwd: path.dirname(ENTRY),
		eventBus: new EventBus(),
		runtime: new ExtensionRuntime() as never,
		readConfig: async () => ({ fields: [], values: {} }),
	});
	if (!result.ok) throw new Error(result.message);
	return result.extension;
}

function install(composer: PromptComposer, sections: readonly { name: string; order: number; text: unknown }[]): void {
	composer.removeBySource(SOURCE);
	for (const section of sections) composer.add({ ...section, source: SOURCE } as never);
}

afterEach(() => {
	clearExtensionDesignSystems("design-guidance-test");
});

describe("design-guidance bundled plugin", () => {
	it("registers function prompt sections at the original orders", async () => {
		const extension = await mountGuidance();
		expect(extension.promptSections.map(section => section.name)).toEqual(["design-system", "asset-policy"]);
		expect(extension.promptSections.map(section => section.order)).toEqual([40, 41]);
		for (const section of extension.promptSections) expect(typeof section.text).toBe("function");
	});

	it("renders the selected brief from host selection state, never both selections", async () => {
		const extension = await mountGuidance();
		const composer = new PromptComposer();
		install(composer, extension.promptSections);

		const glass = composer.compose(["core"], { designSystemId: "glass", assetPolicy: "placeholder" }).join("\n");
		expect(glass).toContain(GLASS_HEAD);
		expect(glass).toContain(PLACEHOLDER_HEAD);
		expect(glass.indexOf(GLASS_HEAD)).toBeLessThan(glass.indexOf(PLACEHOLDER_HEAD));

		const minimal = composer.compose(["core"], { designSystemId: "minimal", assetPolicy: "ai-image" }).join("\n");
		expect(minimal).toContain(MINIMAL_HEAD);
		expect(minimal).toContain(AI_IMAGE_HEAD);
		expect(minimal).not.toContain(GLASS_HEAD);
		expect(minimal.split("设计体系「").length - 1).toBe(1);
		expect(minimal.split("素材策略（").length - 1).toBe(1);
	});

	it("omits both sections when the selection is absent or unknown", async () => {
		const extension = await mountGuidance();
		const composer = new PromptComposer();
		install(composer, extension.promptSections);

		expect(composer.compose(["core"], {})).toEqual(["core"]);
		expect(composer.compose(["core"], { designSystemId: "no-such", assetPolicy: "stock" })).toEqual(["core"]);
	});

	it("resolves extension-registered design systems through the registry", async () => {
		registerExtensionDesignSystem(
			{
				id: "test-brand",
				label: "Test Brand",
				description: "test",
				swatches: ["#112233"],
				tokens: { "--accent": "#112233" },
				promptSection: { name: "design-system", order: 40, text: "TEST-BRAND-BRIEF" },
			},
			"design-guidance-test",
		);
		const extension = await mountGuidance();
		const composer = new PromptComposer();
		install(composer, extension.promptSections);

		expect(composer.compose(["core"], { designSystemId: "test-brand" }).join("\n")).toContain("TEST-BRAND-BRIEF");
	});

	it("unmounting the plugin source removes the brief even with a live selection", async () => {
		const extension = await mountGuidance();
		const composer = new PromptComposer();
		install(composer, extension.promptSections);
		expect(composer.compose(["core"], { designSystemId: "glass", assetPolicy: "placeholder" })).not.toEqual(["core"]);

		composer.removeBySource(SOURCE);
		expect(composer.compose(["core"], { designSystemId: "glass", assetPolicy: "placeholder" })).toEqual(["core"]);
		expect(composer.size).toBe(0);
	});
});
