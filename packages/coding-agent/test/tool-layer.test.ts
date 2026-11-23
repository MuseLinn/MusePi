import { afterEach, describe, expect, test } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import {
	activateCapability,
	isCapabilityActive,
	resetCapabilityActivations,
} from "@musepi/pi-coding-agent/extensibility/capability-activation";
import { BUILTIN_TOOLS, createTools, type ToolSession } from "@musepi/pi-coding-agent/tools";
import {
	extensionOwnsTool,
	isToolOwnerActive,
	pluginOwnsTool,
	pluginProvidesTool,
	providedToolNames,
	registerToolProvider,
	resolveToolImplementation,
	runWithToolProviderOwner,
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

	test("a released activation does not hide a tool the plugin layer still provides", () => {
		provide("bash", { packageName: "tool-bash" });
		const deactivate = activateCapability("tool", "bash");
		deactivate();
		expect(isCapabilityActive("tool", "bash")).toBe(false);
		// The preload/re-mount transient must not remove the whole family.
		expect(isToolOwnerActive("bash")).toBe(true);
		for (const release of releases.splice(0)) release();
		expect(isToolOwnerActive("bash")).toBe(false);
	});

	test("a re-mount by the same entry joins the existing registration", () => {
		const releaseFirst = runWithToolProviderOwner("scope-1", "/pkg/tool-bash", () =>
			registerToolProvider("bash", () => null),
		);
		const releaseSecond = runWithToolProviderOwner("scope-1", "/pkg/tool-bash", () =>
			registerToolProvider("bash", () => null),
		);
		expect(toolProviderFor("bash")).toBeDefined();
		releaseSecond();
		expect(toolProviderFor("bash")).toBeDefined();
		releaseFirst();
		expect(toolProviderFor("bash")).toBeUndefined();
	});

	test("a different mount claiming the same name still fails", () => {
		const release = runWithToolProviderOwner("scope-1", "/pkg/first", () => registerToolProvider("grep", () => null));
		expect(() =>
			runWithToolProviderOwner("scope-1", "/pkg/second", () => registerToolProvider("grep", () => null)),
		).toThrow(/already provided by the plugin layer/);
		release();
	});

	test("the mount owner survives awaits inside apply", async () => {
		await runWithToolProviderOwner("scope-async", "/pkg/async", async () => {
			await Promise.resolve();
			releases.push(registerToolProvider("web_search", () => null));
		});
		expect(toolProviderFor("web_search")).toBeDefined();
	});

	test("a generation shadows the global default in its own scope", () => {
		const implA = () => null;
		const implB = () => null;
		const releaseA = runWithToolProviderOwner("scope-a", "/pkg/a", () => registerToolProvider("web_search", implA));
		const releaseB = runWithToolProviderOwner("scope-b", "/pkg/a", () => registerToolProvider("web_search", implB));
		const scopeA = { pluginScope: "scope-a" } as never;
		const scopeB = { pluginScope: "scope-b" } as never;
		const unscoped = {} as never;
		expect(resolveToolImplementation(scopeA, "web_search")).toBe(implA);
		expect(resolveToolImplementation(scopeB, "web_search")).toBe(implB);
		// A scope that never mounted the package sees the first generation's default.
		expect(resolveToolImplementation(unscoped, "web_search")).toBe(implA);
		releaseB();
		expect(resolveToolImplementation(scopeB, "web_search")).toBe(implA);
		releaseA();
		expect(resolveToolImplementation(scopeA, "web_search")).toBeUndefined();
	});

	test("createTools keeps the owned tool after a released activation", async () => {
		releases.push(registerToolProvider("bash", BUILTIN_TOOLS.bash, { packageName: "tool-bash" }));
		const deactivate = activateCapability("tool", "bash");
		deactivate();
		const session = {
			cwd: process.cwd(),
			settings: Settings.isolated({}),
			enableLsp: false,
			skipPythonPreflight: true,
		} as unknown as ToolSession;
		const names = (await createTools(session)).map(tool => tool.name);
		expect(names).toContain("bash");
	});
});
