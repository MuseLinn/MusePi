/**
 * Contract: the design system registry behind `design.systems.list`
 * (docs/review/0.5.0-m3-mode-page-redesign.md §3).
 *
 * Why this exists: the preview rail renders straight from this RPC, and the
 * anti-collision guarantee is what keeps extension systems from shadowing the
 * five built-ins that persisted sessions already reference. A regression
 * means the rail goes empty/stale or a built-in gets silently replaced.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	BUILTIN_DESIGN_SYSTEMS,
	clearExtensionDesignSystems,
	getDesignSystem,
	registerExtensionDesignSystem,
} from "@musepi/pi-coding-agent/presets/design-systems";
import { DesignSystemsService } from "../src/daemon/services/design-systems-service";
import { ExtensionRuntime } from "../src/extensibility/extensions/loader";
import type { DesignSystemConfig } from "../src/extensibility/extensions/types";

const BUILTIN_IDS = ["minimal", "glass", "editorial", "neubrutalism", "darkneon"] as const;

/** Stub deps：无扩展运行时加载结果（pending 注册为空）。 */
function makeService(): DesignSystemsService {
	return new DesignSystemsService({
		extensionRuntimeLoad: async () => ({ extensions: [], errors: [], runtime: new ExtensionRuntime() }),
	});
}

afterEach(() => {
	// The registry is module-global; never leak extension rows into other suites.
	clearExtensionDesignSystems("test-source");
	clearExtensionDesignSystems("other-source");
});

describe("design.systems.list (builtin registry)", () => {
	it("returns the five built-ins with complete fields", async () => {
		const { systems } = await makeService().listDesignSystems();
		expect([...systems.map(s => s.id)]).toEqual([...BUILTIN_IDS]);
		for (const system of systems) {
			expect(system.source).toBe("builtin");
			expect(system.label.length).toBeGreaterThan(0);
			expect(system.description.length).toBeGreaterThan(0);
			expect(system.swatches.length).toBeGreaterThan(0);
			expect(system.swatches.length).toBeLessThanOrEqual(6);
			for (const swatch of system.swatches) expect(swatch).toMatch(/^#[0-9a-f]{6}$/i);
			expect(Object.keys(system.tokens).length).toBeGreaterThan(0);
			expect(system.promptSection.name).toBe("design-system");
			expect(system.promptSection.order).toBe(40);
			expect(system.promptSection.text.length).toBeGreaterThan(0);
		}
	});

	it("exposes the design.systems.list route for the daemon dispatcher", () => {
		expect(makeService().routes["design.systems.list"]).toBe("listDesignSystems");
	});
});

describe("design system extension registry", () => {
	const extSystem: DesignSystemConfig = {
		id: "test-brand",
		label: "Test Brand",
		description: "test",
		swatches: ["#112233"],
		tokens: { "--accent": "#112233" },
		promptSection: { name: "design-system", order: 40, text: "TEST-BRAND-BRIEF" },
	};

	it("an extension-registered system appears in the list behind extension built-ins", async () => {
		registerExtensionDesignSystem(extSystem, "test-source");
		const { systems } = await makeService().listDesignSystems();
		const row = systems.find(s => s.id === "test-brand");
		expect(row?.source).toBe("extension");
		expect(row?.promptSection.text).toBe("TEST-BRAND-BRIEF");
		expect(systems.filter(s => s.source === "builtin")).toHaveLength(BUILTIN_DESIGN_SYSTEMS.length);
	});

	it("rejects an id colliding with a built-in design system", () => {
		for (const id of BUILTIN_IDS) {
			expect(() => registerExtensionDesignSystem({ ...extSystem, id }, "test-source")).toThrow(
				`registerDesignSystem: id "${id}" collides with a built-in design system`,
			);
		}
	});

	it("rejects a duplicate extension registration", () => {
		registerExtensionDesignSystem(extSystem, "test-source");
		expect(() => registerExtensionDesignSystem(extSystem, "other-source")).toThrow(
			'registerDesignSystem: id "test-brand" is already registered',
		);
	});

	it("clear by source removes only that source's systems", () => {
		registerExtensionDesignSystem(extSystem, "test-source");
		registerExtensionDesignSystem({ ...extSystem, id: "other-brand" }, "other-source");
		clearExtensionDesignSystems("test-source");
		expect(getDesignSystem("test-brand")).toBeUndefined();
		expect(getDesignSystem("other-brand")?.label).toBe("Test Brand");
	});
});
