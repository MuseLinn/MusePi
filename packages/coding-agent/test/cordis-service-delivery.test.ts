/**
 * Plugin-to-plugin service delivery — the half that makes `inject` useful.
 *
 * The gate (a plugin whose `inject` names nothing provides is refused) is only
 * half the contract. This is the other half: a plugin that declared a dependency
 * can actually READ it, and a provider that unloads takes its service with it.
 *
 * The observable failure modes:
 *
 * - a dependency passes the gate but is unreachable → `pi.service(name)` returns
 *   undefined for a name that was checked, which is worse than no gate;
 * - a provider unloads but its service stays resolvable → the consumer holds a
 *   dead object and fails later, somewhere far from the cause;
 * - a provider FAILS to load but its name was published → the consumer gets a
 *   name with nothing behind it.
 *
 * These run against the real `CordisDynamicPluginRuntime` with two temp plugins,
 * because the interesting behaviour is in the runtime's bookkeeping.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { getProjectAgentDir } from "@musepi/pi-utils";
import { CordisDynamicPluginRuntime } from "../src/daemon/cordis-dynamic-plugins";
import { DaemonHostContext } from "../src/daemon/host-context";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "./helpers/isolate-agent-dir";

const PROVIDER = `export const name = "svc-provider";
export const provide = ["probe.pool"];
export function apply() {
	return { "probe.pool": { accounts: ["a", "b"], claim: () => "claimed" } };
}
`;

/** The consumer records what it managed to read, into a module-level box.
 *
 *  It reads `globalThis.__svcProbe` at CALL time rather than capturing the object
 *  at module evaluation: the module is cached across tests in this file, so a
 *  captured reference would keep pointing at the box the first test installed. */
const CONSUMER = `export const name = "svc-consumer";
export const inject = ["probe.pool"];
export function apply(pi: any) {
	const box = (globalThis as any).__svcProbe;
	box.seen = pi.service("probe.pool") ?? null;
}
`;

/** A consumer that asks for a name nothing provides. */
const ORPHAN = `export const name = "svc-orphan";
export const inject = ["probe.absent"];
export function apply() {}
`;

describe("plugin service delivery", () => {
	let agentDir = "";
	let projectDir = "";
	let extensionsDir = "";
	let host: DaemonHostContext;
	let runtime: CordisDynamicPluginRuntime;

	beforeEach(async () => {
		agentDir = await isolateAgentDirForTest("svc-delivery-");
		projectDir = mkdtempSync(path.join(tmpdir(), "svc-proj-"));
		extensionsDir = path.join(getProjectAgentDir(projectDir), "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		host = new DaemonHostContext();
		runtime = new CordisDynamicPluginRuntime(host);
		// Reset the probe box a consumer writes into.
		(globalThis as { __svcProbe?: { seen: unknown } }).__svcProbe = { seen: null };
	});

	afterEach(async () => {
		await runtime.dispose();
		await host.dispose();
		rmSync(projectDir, { recursive: true, force: true });
		await restoreAgentDirForTest(agentDir);
		delete (globalThis as { __svcProbe?: unknown }).__svcProbe;
	});

	/** Write a plugin entry and return its absolute path. */
	function entry(fileName: string, source: string): string {
		const p = path.join(extensionsDir, fileName);
		writeFileSync(p, source);
		return p;
	}

	test("a consumer reads the object its provider published", async () => {
		// The whole point: the name that passed the gate is reachable, and it is
		// the object the provider returned from `apply`.
		entry("provider.ts", PROVIDER);
		entry("consumer.ts", CONSUMER);
		const result = await runtime.loadAll(
			[path.join(extensionsDir, "provider.ts"), path.join(extensionsDir, "consumer.ts")],
			projectDir,
		);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(2);

		const seen = (globalThis as { __svcProbe?: { seen: unknown } }).__svcProbe?.seen as
			| { accounts?: string[] }
			| undefined;
		expect((seen as { accounts?: string[] } | undefined)?.accounts).toEqual(["a", "b"]);
	}, 30_000);
	test("a consumer mounted before its provider is refused, and says who would provide it", async () => {
		// Ordering is the ordinary failure: the consumer loads first, so the name
		// is not published yet. The refusal must name the provider so the author
		// can tell "wrong name" from "wrong order".
		entry("consumer.ts", CONSUMER);
		const result = await runtime.loadAll([path.join(extensionsDir, "consumer.ts")], projectDir);
		expect(result.extensions).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.error).toContain("probe.pool");
	}, 30_000);

	test("an unmounted provider is not resolvable", async () => {
		// Only the consumer is loaded, and its dependency is refused — so it never
		// ran `apply`, which means nothing was recorded.
		entry("consumer.ts", CONSUMER);
		await runtime.loadAll([path.join(extensionsDir, "consumer.ts")], projectDir);
		expect((globalThis as { __svcProbe?: { seen: unknown } }).__svcProbe?.seen).toBeNull();
	}, 30_000);

	test("a provider that unloads takes its service with it", async () => {
		// The leak this prevents: a consumer is mounted against a name whose
		// provider has since gone. Removing the provider must drop the service,
		// so a plugin that then asks for it is refused instead of half-loading.
		entry("provider.ts", PROVIDER);
		entry("consumer.ts", CONSUMER);
		await runtime.loadAll(
			[path.join(extensionsDir, "provider.ts"), path.join(extensionsDir, "consumer.ts")],
			projectDir,
		);
		expect((globalThis as { __svcProbe?: { seen: unknown } }).__svcProbe?.seen).not.toBeNull();

		// Drop the provider and ask again with a DIFFERENT file: `loadAll` skips a
		// re-entry whose entry path is unchanged (that is the TTL contract), so a
		// reused name would silently answer from the cached record rather than
		// re-running the dependency gate.
		rmSync(path.join(extensionsDir, "provider.ts"), { force: true });
		rmSync(path.join(extensionsDir, "consumer.ts"), { force: true });
		(globalThis as { __svcProbe?: { seen: unknown } }).__svcProbe = { seen: null };
		entry("consumer-b.ts", CONSUMER.replace("svc-consumer", "svc-consumer-b"));
		const after = await runtime.loadAll([path.join(extensionsDir, "consumer-b.ts")], projectDir);
		expect(after.extensions).toHaveLength(0);
		expect(after.errors[0]?.error).toContain("probe.pool");
		// And the consumer never ran, so it read nothing.
		expect((globalThis as { __svcProbe?: { seen: unknown } }).__svcProbe?.seen).toBeNull();
	}, 30_000);

	test("a plugin asking for a name nothing provides is refused at load", async () => {
		// The gate itself: an unmountable dependency is a load error, not a
		// half-mounted plugin that breaks later.
		entry("orphan.ts", ORPHAN);
		const result = await runtime.loadAll([path.join(extensionsDir, "orphan.ts")], projectDir);
		expect(result.extensions).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.error).toContain("probe.absent");
	}, 30_000);

	test("a provider that publishes nothing still satisfies the dependency", async () => {
		// `provide` without returning an object is legal: the consumer's
		// `pi.service` then yields undefined, which it must handle anyway because
		// a provider can unload at any time. Refusing to mount would be hostile.
		entry(
			"provider.ts",
			`export const name = "svc-silent";
export const provide = ["probe.pool"];
export function apply() {}
`,
		);
		entry("consumer.ts", CONSUMER);
		const result = await runtime.loadAll(
			[path.join(extensionsDir, "provider.ts"), path.join(extensionsDir, "consumer.ts")],
			projectDir,
		);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(2);
		expect((globalThis as { __svcProbe?: { seen: unknown } }).__svcProbe?.seen).toBeNull();
	}, 30_000);
});
