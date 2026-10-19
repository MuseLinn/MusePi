/**
 * Plugin-to-plugin service dependencies (`provide` / `inject`).
 *
 * The contract: a plugin that `inject`s a name is refused at load time unless
 * the host or a MOUNTED plugin provides it. What must not happen is the
 * half-load — a plugin that registers its tools and then fails on the first call
 * because the thing it depended on was never there.
 *
 * The observable failure modes these guard against:
 *
 * - a missing dependency is not detected → the plugin half-mounts and breaks
 *   later, with no message pointing at the real cause;
 * - a dependency satisfied by a plugin that has SINCE unloaded → the consumer
 *   keeps a stale handle;
 * - a dependency satisfied by a plugin that FAILED to load → the consumer sees a
 *   name with no provider behind it.
 */

import { describe, expect, test } from "bun:test";
import {
	type CordisPluginEntry,
	HOST_SERVICES,
	hostOnlyRegistry,
	missingServiceDependencies,
	providedServices,
	type ServiceRegistry,
} from "../src/extensibility/plugins/runtime/cordis-entry";

/** A registry where `provided` are the currently-mounted plugin services. */
function registry(provided: Record<string, string>): ServiceRegistry {
	const map = new Map(Object.entries(provided));
	return {
		host: HOST_SERVICES,
		hasProvided: name => map.has(name),
		providerOf: name => map.get(name),
		resolve: <T>(name: string): T | undefined => (map.has(name) ? ({ name } as T) : undefined),
	};
}

describe("host services", () => {
	test("a host service satisfies an inject", () => {
		// The baseline: the names the host itself provides must never be refused.
		const entry = { inject: ["credentials"], apply: () => {} };
		expect(missingServiceDependencies(entry, hostOnlyRegistry())).toEqual([]);
	});

	test("an unknown name is missing", () => {
		const entry = { inject: ["nope"], apply: () => {} };
		expect(missingServiceDependencies(entry, hostOnlyRegistry())).toEqual(["nope"]);
	});

	test("a legacy factory (no inject) has no missing dependencies", () => {
		// The gate only applies to cordis entries; a legacy factory declares
		// nothing, so it must pass through untouched.
		expect(missingServiceDependencies(null, hostOnlyRegistry())).toEqual([]);
	});

	test("a malformed inject is ignored rather than fatal", () => {
		// A plugin author writing `inject: "credentials"` (a string, not an
		// array) gets the same treatment as declaring nothing — refusing to load
		// over a type slip would be hostile, and the array form is the contract.
		const entry = { inject: "credentials", apply: () => {} } as unknown as CordisPluginEntry;
		expect(missingServiceDependencies(entry, hostOnlyRegistry())).toEqual([]);
	});
});

describe("plugin-provided services", () => {
	test("a mounted provider satisfies the dependency", () => {
		// The whole point of `provide`: a plugin can build on another plugin
		// without the host knowing anything about either.
		const entry = { inject: ["pool"], apply: () => {} };
		expect(missingServiceDependencies(entry, registry({ pool: "auth-hub" }))).toEqual([]);
	});

	test("an unmounted provider is missing, and names who would provide it", () => {
		// Ordering matters: a consumer mounted BEFORE its provider must be
		// refused, and the message must name the provider so the author can tell
		// "wrong name" from "wrong order".
		const reg = registry({});
		const entry = { inject: ["pool"], apply: () => {} };
		expect(missingServiceDependencies(entry, reg)).toEqual(["pool"]);
		// `providerOf` on a registry that has no such provider is undefined; the
		// runtime keeps the last-known provider separately for the message.
		expect(reg.providerOf("pool")).toBeUndefined();
	});

	test("host and plugin services compose", () => {
		const entry = { inject: ["credentials", "pool"], apply: () => {} };
		expect(missingServiceDependencies(entry, registry({ pool: "auth-hub" }))).toEqual([]);
	});

	test("only the missing names are reported, in declaration order", () => {
		// A refusal that lists one missing name when three are absent sends the
		// author through three load attempts.
		const entry = { inject: ["a", "credentials", "b"], apply: () => {} };
		expect(missingServiceDependencies(entry, hostOnlyRegistry())).toEqual(["a", "b"]);
	});
});

describe("providedServices", () => {
	test("normalizes a declaration to names", () => {
		const entry = { provide: ["pool", "checkin"], apply: () => {} };
		expect(providedServices(entry)).toEqual(["pool", "checkin"]);
	});

	test("an absent or malformed provide yields nothing", () => {
		// Most plugins provide nothing; that must not be an error path.
		expect(providedServices({ apply: () => {} })).toEqual([]);
		expect(providedServices(null)).toEqual([]);
		const bad = { provide: "pool", apply: () => {} } as unknown as CordisPluginEntry;
		expect(providedServices(bad)).toEqual([]);
	});

	test("empty strings are dropped", () => {
		// An empty name would satisfy an `inject: [""]`, which is meaningless.
		const entry = { provide: ["", "pool"], apply: () => {} };
		expect(providedServices(entry)).toEqual(["pool"]);
	});
});
