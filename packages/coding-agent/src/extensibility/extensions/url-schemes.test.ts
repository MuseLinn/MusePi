import { describe, expect, it } from "bun:test";
import { type ExtensionUrlHost, ExtensionUrlRegistry } from "./url-schemes";

/**
 * Extension-contributed URL schemes against a fake router: a plain Map
 * standing in for the process-global `InternalUrlRouter`. No processes,
 * no filesystem. All operations are synchronous (map + sync router calls).
 */
function fakeHost(initial: string[] = []): ExtensionUrlHost & { map: Map<string, object> } {
	const map = new Map<string, object>(initial.map(scheme => [scheme, { builtin: true }]));
	return {
		map,
		register(handler: { scheme: string }): void {
			map.set(handler.scheme, handler);
		},
		unregister(scheme: string): boolean {
			return map.delete(scheme);
		},
		getHandler(scheme: string) {
			return map.get(scheme) as never;
		},
	};
}

function def(scheme: string) {
	return {
		scheme,
		immutable: true,
		resolve: async () => ({ content: [{ type: "text", text: "x" }] }) as never,
	};
}

describe("ExtensionUrlRegistry", () => {
	it("registers, reports ownership, and unregisters", () => {
		const host = fakeHost();
		const registry = new ExtensionUrlRegistry(() => host);

		expect(registry.register(def("mine"))).toEqual({ scheme: "mine" });
		expect(registry.owned()).toEqual(["mine"]);
		expect(host.map.has("mine")).toBe(true);

		expect(registry.unregister("mine")).toBe(true);
		expect(registry.owned()).toEqual([]);
		expect(host.map.has("mine")).toBe(false);
		expect(registry.unregister("mine")).toBe(false);
	});

	it("rejects malformed definitions without touching the host", () => {
		const host = fakeHost();
		const registry = new ExtensionUrlRegistry(() => host);

		expect(() => registry.register(null as never)).toThrow(/definition object/);
		expect(() => registry.register(def("not a scheme!"))).toThrow(/valid scheme/);
		expect(() => registry.register({ scheme: "x", immutable: true } as never)).toThrow(/resolve function/);
		expect(() => registry.register({ scheme: "x", immutable: "yes", resolve: async () => null } as never)).toThrow(
			/immutable boolean/,
		);
		expect(host.map.size).toBe(0);
		expect(registry.owned()).toEqual([]);
	});

	it("refuses built-in and foreign schemes, accepts re-registration", () => {
		const host = fakeHost(["file", "other"]);
		const registry = new ExtensionUrlRegistry(() => host);

		expect(() => registry.register(def("file"))).toThrow(/already handled/);
		expect(() => registry.register(def("other"))).toThrow(/already handled/);
		expect(registry.owned()).toEqual([]);

		registry.register(def("mine"));
		// Same extension re-registering (hot reload) replaces without error.
		expect(registry.register(def("mine"))).toEqual({ scheme: "mine" });
		expect(registry.owned()).toEqual(["mine"]);
	});

	it("leaves a hijacked slot alone on unregister and release", () => {
		const host = fakeHost();
		const registry = new ExtensionUrlRegistry(() => host);
		registry.register(def("mine"));

		const hijack = { scheme: "mine" };
		host.map.set("mine", hijack);
		expect(registry.unregister("mine")).toBe(true);
		expect(host.map.get("mine")).toBe(hijack);

		registry.register(def("gone"));
		host.map.delete("gone");
		expect(registry.releaseAll()).toEqual(["gone"]);
	});

	it("requires a URL host", () => {
		const registry = new ExtensionUrlRegistry(() => undefined);
		expect(() => registry.register(def("mine"))).toThrow(/not available/);
		expect(registry.unregister("mine")).toBe(false);
		expect(registry.releaseAll()).toEqual([]);
	});
});
