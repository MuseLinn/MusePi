import { afterEach, describe, expect, test } from "bun:test";
import { resetCapabilityActivations } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import {
	pluginProvidesTool,
	providedToolNames,
	registerToolProvider,
	resolveToolImplementation,
	toolLayerOf,
} from "@musepi/pi-coding-agent/tools/tool-ownership";

const releases: Array<() => void> = [];

function provide(name: string): void {
	releases.push(registerToolProvider(name, () => null, { packageName: "musepi-memory-tools" }));
}

afterEach(() => {
	for (const release of releases.splice(0)) release();
	resetCapabilityActivations();
});

function sessionWith(registered: Array<{ name: string; track?: "plugin" | "extension" }> = []): never {
	const byName = new Map(registered.map(entry => [entry.name, entry]));
	return {
		extensionRunner: {
			getAllRegisteredTools: () =>
				registered.map(entry => ({ definition: { name: entry.name }, extensionPath: "/fixture" })),
			getExtensionForTool: (name: string) => {
				const entry = byName.get(name);
				return entry === undefined ? undefined : { track: entry.track, path: "/fixture", resolvedPath: "/fixture" };
			},
		},
	} as never;
}

describe("package-provided tools", () => {
	test("a provided tool resolves from the plugin layer", () => {
		const session = sessionWith();
		provide("retain");
		expect(pluginProvidesTool("retain")).toBe(true);
		expect(toolLayerOf(session, "retain")).toBe("plugin");
		expect(resolveToolImplementation(session, "retain")).toBeDefined();
	});

	test("a session registration wins over the package that provides it", () => {
		const session = sessionWith([{ name: "retain", track: "plugin" }]);
		provide("retain");
		// The nearer registration owns the name: the package implementation is
		// not used, and the core factory yields too (toolIsRegistered).
		expect(toolLayerOf(session, "retain")).toBe("session");
		expect(resolveToolImplementation(session, "retain")).toBeUndefined();
	});

	test("releasing the package returns the name to the core table", () => {
		provide("recall");
		expect(providedToolNames()).toContain("recall");
		for (const release of releases.splice(0)) release();
		expect(pluginProvidesTool("recall")).toBe(false);
		expect(toolLayerOf(sessionWith(), "recall")).toBeUndefined();
	});
});
