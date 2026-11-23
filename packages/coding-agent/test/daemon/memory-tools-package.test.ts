import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resetCapabilityActivations } from "../../src/extensibility/capability-activation";
import { isToolOwnerActive, pluginProvidesTool, providedToolNames } from "../../src/tools/tool-ownership";
import { createBundledPluginRuntime } from "../helpers/bundled-plugin-runtime";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

/**
 * Contract: the memory tools ship as a capability package. Mounting it makes
 * the package the provider of each tool (the plugin layer), and disabling one
 * component removes exactly that tool from the slate.
 */
describe("memory-tools capability package", () => {
	let agentDir: string;
	let bundled: ReturnType<typeof createBundledPluginRuntime>;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("memory-tools-package-");
		bundled = createBundledPluginRuntime();
		await bundled.runtime.load(
			path.resolve(import.meta.dir, "../../src/bundled-plugins/memory-tools"),
			process.cwd(),
		);
	}, 30_000);

	afterAll(async () => {
		await bundled.dispose();
		await restoreAgentDirForTest(agentDir);
		resetCapabilityActivations();
	}, 30_000);

	it("the package provides every memory tool", () => {
		const provided = providedToolNames();
		for (const name of ["retain", "recall", "reflect", "memory_edit", "learn"]) {
			expect(pluginProvidesTool(name), `${name} should be provided`).toBe(true);
			expect(provided).toContain(name);
		}
	});

	it("each tool is owned by its own component", () => {
		for (const name of ["retain", "recall", "reflect", "memory_edit", "learn"]) {
			expect(isToolOwnerActive(name), `${name} owner should be active`).toBe(true);
		}
	});

	it("disabling one component removes only that tool", async () => {
		await bundled.runtime.setComponentEnabled("memory-tools", "reflect", false);
		expect(isToolOwnerActive("reflect")).toBe(false);
		expect(isToolOwnerActive("retain")).toBe(true);
		expect(isToolOwnerActive("recall")).toBe(true);
		await bundled.runtime.setComponentEnabled("memory-tools", "reflect", true);
		expect(isToolOwnerActive("reflect")).toBe(true);
	}, 30_000);
});
