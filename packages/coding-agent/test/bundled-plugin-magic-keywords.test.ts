/**
 * The bundled magic-keywords plugin package.
 *
 * This is the first first-party unit migrated from the static built-in
 * registry into plugin form, so the contract under test is the migration's own
 * safety property: the package contributes EXACTLY the three keywords the
 * registry declares, with the same names, the same setting keys, and the same
 * gradients. If the package drifts from the registry — a keyword renamed, a
 * gradient changed, one dropped — the two faces of the same feature disagree,
 * and the migration is not safe to complete.
 *
 * Discovery is exercised too: the package must be found the way a host finds
 * it (a directory under bundled-plugins with a musepi.extensions manifest), not
 * handed to the loader by the test.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";
import { discoverBundledPluginPaths } from "../src/discovery/builtin";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { resolvePluginEntry, toFactory } from "../src/extensibility/plugins/runtime/cordis-entry";
import { resetMagicKeywordRegistry } from "../src/modes/magic-keyword-registry";

/** Load a bundled package through the same entry resolution the host uses. */
async function loadEntry(entry: string): Promise<ExtensionRuntime> {
	const mod = await import(entry);
	const resolved = resolvePluginEntry(mod as never);
	if (!resolved) throw new Error(`bundled plugin exports nothing loadable: ${entry}`);
	const runtime = new ExtensionRuntime();
	await loadExtensionFromFactory(
		toFactory(resolved) as never,
		process.cwd(),
		new (await import("../src/utils/event-bus")).EventBus(),
		runtime,
		entry,
	);
	return runtime;
}

beforeEach(() => {
	resetMagicKeywordRegistry();
});

describe("bundled magic-keywords package", () => {
	it("is discovered as a bundled plugin package", async () => {
		const paths = await discoverBundledPluginPaths();

		// The bundled tree ships one package; its entry resolves to this repo's
		// src (dev layout).
		expect(paths.length).toBeGreaterThanOrEqual(1);
		expect(paths.some(p => p.replaceAll("\\", "/").includes("bundled-plugins/magic-keywords"))).toBe(true);
	});

	it("contributes exactly the three registry keywords, matched field for field", async () => {
		const paths = await discoverBundledPluginPaths();
		const entry = paths.find(p => p.replaceAll("\\", "/").includes("magic-keywords"));
		if (!entry) throw new Error("magic-keywords package should be discovered");

		const runtime = await loadEntry(entry);

		const registered = runtime.pendingMagicKeywordRegistrations;
		// One keyword per schema key, by name. The third keyword's identity is
		// `workflow` (settings key) whose trigger word is "workflowz" — the
		// package must carry that separation too.
		const registryNames = ["ultrathink", "orchestrate", "workflow"];
		expect(registered.map(k => k.name).sort()).toEqual([...registryNames].sort());
		expect(registered.find(k => k.name === "workflow")?.trigger).toBe("workflowz");

		// The registry no longer declares these (that would be a second face of
		// the same feature); the SETTINGS SCHEMA is the parity anchor now — each
		// keyword's toggle key must be a real schema key, since the schema is
		// what gives it its default.
		for (const keyword of registered) {
			expect(Object.keys(SETTINGS_SCHEMA)).toContain(`magicKeywords.${keyword.name}`);
		}
		expect(registered.find(k => k.name === "ultrathink")?.highlight).toEqual({ from: 0, to: 330 });
		expect(registered.find(k => k.name === "orchestrate")?.highlight).toEqual({ from: 150, to: 280 });
		expect(registered.find(k => k.name === "workflow")?.highlight).toEqual({ from: 30, to: 150 });
	});

	it("carries real notice content for every keyword", async () => {
		const paths = await discoverBundledPluginPaths();
		const entry = paths.find(p => p.replaceAll("\\", "/").includes("magic-keywords"));
		if (!entry) throw new Error("magic-keywords package should be discovered");

		const runtime = await loadEntry(entry);

		for (const keyword of runtime.pendingMagicKeywordRegistrations) {
			// A notice template rendered to nothing means the registration is a
			// husk — the model would receive an empty nudge.
			expect(keyword.notice.trim().length).toBeGreaterThan(40);
		}
	});
});
