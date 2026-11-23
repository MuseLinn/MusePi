import { afterEach, describe, expect, test } from "bun:test";
import { resetCapabilityActivations } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import {
	extensionOwnsTool,
	pluginOwnsTool,
	pluginProvidesTool,
	providedToolNames,
	registerToolProvider,
	resolveToolImplementation,
	toolLayerOf,
	toolProviderFor,
} from "@musepi/pi-coding-agent/tools/tool-ownership";

const releases: Array<() => void> = [];

function provide(name: string, options: { packageName?: string } = {}): void {
	releases.push(registerToolProvider(name, () => null, options));
}

afterEach(() => {
	for (const release of releases.splice(0)) release();
	resetCapabilityActivations();
});

/** A session stub whose extension runner may register names. */
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

describe("layered tool resolution", () => {
	test("the core table answers when neither layer provides a name", () => {
		const session = sessionWith();
		expect(pluginProvidesTool("read")).toBe(false);
		expect(extensionOwnsTool(session, "read")).toBe(false);
		expect(toolLayerOf(session, "read")).toBeUndefined();
		expect(resolveToolImplementation(session, "read")).toBeUndefined();
	});

	test("a package-provided tool resolves from the plugin layer", () => {
		const session = sessionWith();
		provide("read", { packageName: "musepi-file-tools" });
		expect(pluginProvidesTool("read")).toBe(true);
		expect(toolLayerOf(session, "read")).toBe("plugin");
		expect(resolveToolImplementation(session, "read")).toBeDefined();
		expect(providedToolNames()).toContain("read");
	});

	test("a session registration shadows the plugin layer", () => {
		const session = sessionWith([{ name: "read", track: "plugin" }]);
		provide("read");
		expect(pluginOwnsTool(session, "read")).toBe(true);
		expect(toolLayerOf(session, "read")).toBe("session");
		// The nearer layer owns it, so construction is not redirected to the package.
		expect(resolveToolImplementation(session, "read")).toBeUndefined();
	});

	test("the two tracks answer for their own registrations only", () => {
		const session = sessionWith([
			{ name: "from_plugin", track: "plugin" },
			{ name: "from_extension", track: "extension" },
		]);
		// Track A owns the plugin's tool, not the extension's.
		expect(pluginOwnsTool(session, "from_plugin")).toBe(true);
		expect(pluginOwnsTool(session, "from_extension")).toBe(false);
		// Track B owns the extension's tool, not the plugin's.
		expect(extensionOwnsTool(session, "from_extension")).toBe(true);
		expect(extensionOwnsTool(session, "from_plugin")).toBe(false);
		// Both are session-layer registrations for resolution purposes.
		expect(toolLayerOf(session, "from_plugin")).toBe("session");
		expect(toolLayerOf(session, "from_extension")).toBe("session");
	});

	test("a duplicate inside the plugin layer fails instead of replacing", () => {
		provide("grep", { packageName: "first" });
		expect(() => registerToolProvider("grep", () => null, { packageName: "second" })).toThrow(
			/already provided by the plugin layer/,
		);
	});

	test("releasing restores the core table", () => {
		provide("write");
		expect(toolProviderFor("write")).toBeDefined();
		for (const release of releases.splice(0)) release();
		expect(toolProviderFor("write")).toBeUndefined();
		expect(toolLayerOf(sessionWith(), "write")).toBeUndefined();
	});
});
