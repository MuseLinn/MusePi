/**
 * Host plugin lifecycle contract.
 *
 * A `musepi.scope: "host"` package registers process-wide facts, so its `apply`
 * must run once per process and never once per session. The contract is pinned
 * by executing the pipeline twice, not by reading a scope flag: the second
 * `ensureHostPlugins` call (concurrent or later) must not run the entry again,
 * and the session discovery surface must not offer the entry as a candidate.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability, invalidateCapabilityCache, listCapabilities } from "../src/capability";
import { discoverExtensionPaths } from "../src/extensibility/extensions/loader";
import { loadAllExtensions } from "../src/extensibility/extensions-center/state-manager";
import { createHmrService } from "../src/extensibility/plugins/hmr/service";
import {
	ensureHostPlugins,
	inspectHostPlugins,
	reloadHostPlugins,
	resetHostPlugins,
} from "../src/extensibility/plugins/runtime/host-runtime";
import {
	clearHostServices,
	getHostService,
	provideHostService,
} from "../src/extensibility/plugins/runtime/host-services";
import { findMemoryBackendProvider } from "../src/memory-backend/providers";

const APPLY_COUNT = "__musepiHostPluginApplyCount";

function applyCount(): number | undefined {
	return (globalThis as Record<string, unknown>)[APPLY_COUNT] as number | undefined;
}

const HOST_ENTRY_SOURCE = `
	import { fixtureTone } from "./lib/helper";

	export const name = "fixture-host";
	export const inject = [];

	export function apply(ctx, config) {
		globalThis.${APPLY_COUNT} = (globalThis.${APPLY_COUNT} ?? 0) + 1;
		globalThis.__musepiHostPluginTone = config?.["fixture.tone"];
		globalThis.__musepiHostPluginHelper = fixtureTone;
		ctx.memory.registerBackendProvider({
			id: "fixture-host",
			label: "Fixture Host",
			create() {
				throw new Error("the fixture backend is never constructed");
			},
		});
	}
`;

const SESSION_ENTRY_SOURCE = `
	export const name = "fixture-session";
	export const inject = [];
	export function apply() {}
`;

async function writePackage(dir: string, manifest: Record<string, unknown>, source: string): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, "package.json"), JSON.stringify(manifest));
	const entry = path.join(dir, "index.ts");
	await Bun.write(entry, source);
	return entry;
}

describe("host plugin mount contract", () => {
	let root = "";
	let hostEntry = "";
	let sessionEntry = "";
	const previousRoots = process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-host-plugin-"));
		hostEntry = await writePackage(
			path.join(root, "bundled-plugins", "fixture-host"),
			{
				name: "fixture-host",
				musepi: {
					scope: "host",
					extensions: ["./index.ts"],
					config: [{ key: "fixture.tone", type: "string", default: "warm" }],
				},
			},
			HOST_ENTRY_SOURCE,
		);
		await fs.mkdir(path.join(path.dirname(hostEntry), "lib"), { recursive: true });
		await Bun.write(path.join(path.dirname(hostEntry), "lib", "helper.ts"), 'export const fixtureTone = "warm";\n');
		sessionEntry = await writePackage(
			path.join(root, "bundled-plugins", "fixture-session"),
			{ name: "fixture-session", musepi: { extensions: ["./index.ts"] } },
			SESSION_ENTRY_SOURCE,
		);
		process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS = path.join(root, "bundled-plugins");
		invalidateCapabilityCache();
	});

	afterEach(async () => {
		await resetHostPlugins();
		clearHostServices();
		if (previousRoots === undefined) delete process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS;
		else process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS = previousRoots;
		delete (globalThis as Record<string, unknown>)[APPLY_COUNT];
		delete (globalThis as Record<string, unknown>).__musepiHostPluginTone;
		delete (globalThis as Record<string, unknown>).__musepiHostPluginHelper;
		delete (globalThis as Record<string, unknown>).__musepiHostCleanupGate;
		delete (globalThis as Record<string, unknown>).__musepiHostCleanupStarted;
		delete (globalThis as Record<string, unknown>).__musepiHostRejectedCleanups;
		delete (globalThis as Record<string, unknown>).__musepiHostApplied;
		delete (globalThis as Record<string, unknown>).__musepiHostFailApply;
		invalidateCapabilityCache();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("applies a host package exactly once across repeated and concurrent ensures", async () => {
		const [first, second] = await Promise.all([ensureHostPlugins(process.cwd()), ensureHostPlugins(process.cwd())]);

		expect([first, second]).toEqual([true, false]);
		expect(applyCount()).toBe(1);
		// Manifest-declared fields reach `apply`'s second argument; the host
		// pipeline must not depend on an exported `Config`.
		expect((globalThis as Record<string, unknown>).__musepiHostPluginTone).toBe("warm");
		expect(findMemoryBackendProvider("fixture-host" as never)).toMatchObject({ id: "fixture-host" });

		expect(await ensureHostPlugins(process.cwd())).toBe(false);
		expect(applyCount()).toBe(1);
	});

	it("reloads a changed host package in place and re-registers its provider", async () => {
		await ensureHostPlugins(process.cwd());
		expect(applyCount()).toBe(1);

		const reloaded = await reloadHostPlugins([hostEntry]);

		expect(reloaded).toEqual(["fixture-host"]);
		expect(applyCount()).toBe(2);
		expect(findMemoryBackendProvider("fixture-host" as never)).toMatchObject({ id: "fixture-host" });
		expect(inspectHostPlugins().find(entry => entry.name === "fixture-host")?.fiberState).toBe("ACTIVE");
	});

	it("reloads when a plugin-owned dependency changes", async () => {
		await ensureHostPlugins(process.cwd());
		const helperPath = path.join(path.dirname(hostEntry), "lib", "helper.ts");
		await Bun.write(helperPath, 'export const fixtureTone = "fresh";\n');

		const reloaded = await reloadHostPlugins([helperPath]);

		expect(reloaded).toEqual(["fixture-host"]);
		expect(applyCount()).toBe(2);
		expect((globalThis as Record<string, unknown>).__musepiHostPluginHelper).toBe("fresh");
	});

	it("reloads when only the package manifest changes", async () => {
		await ensureHostPlugins(process.cwd());
		const manifestPath = path.join(path.dirname(hostEntry), "package.json");
		const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
			musepi: { config: Array<{ default: string }> };
		};
		manifest.musepi.config[0]!.default = "cool";
		await Bun.write(manifestPath, JSON.stringify(manifest));

		await reloadHostPlugins([manifestPath]);

		expect(applyCount()).toBe(2);
		expect((globalThis as Record<string, unknown>).__musepiHostPluginTone).toBe("cool");
	});

	it("does not reload when a file outside the package changes", async () => {
		await ensureHostPlugins(process.cwd());
		const outside = path.join(root, "host-code.ts");
		await Bun.write(outside, "export const hostValue = 1;\n");

		expect(await reloadHostPlugins([outside])).toEqual([]);
		expect(applyCount()).toBe(1);
	});

	it("keeps the previous instance when a replacement cannot be imported", async () => {
		await ensureHostPlugins(process.cwd());
		await Bun.write(hostEntry, "export const name = 'fixture-host';\nexport function apply( {\n");

		const reloaded = await reloadHostPlugins([hostEntry]);

		expect(reloaded).toEqual([]);
		expect(applyCount()).toBe(1);
		expect(findMemoryBackendProvider("fixture-host" as never)).toMatchObject({ id: "fixture-host" });
	});

	it("keeps host packages out of the session extension candidates", async () => {
		const candidates = (await discoverExtensionPaths([], process.cwd())).map(entry => path.resolve(entry));

		expect(candidates).toContain(path.resolve(sessionEntry));
		expect(candidates).not.toContain(path.resolve(hostEntry));
	});

	it("keeps the host surface out of the user-facing capability list", () => {
		expect(listCapabilities()).not.toContain("host-plugins");
		// Hidden is a listing decision, not a capability removal: the loader and
		// the extension center still resolve it by ID.
		expect(getCapability("host-plugins")).toBeDefined();
	});

	it("lists both lifecycles in the extension center as plugin modules", async () => {
		const entries = await loadAllExtensions(process.cwd(), []);
		const host = entries.find(entry => path.resolve(entry.path) === path.resolve(hostEntry));
		const session = entries.find(entry => path.resolve(entry.path) === path.resolve(sessionEntry));

		expect(host).toMatchObject({
			kind: "plugin-module",
			state: "active",
			builtin: true,
			source: { level: "native" },
		});
		// A bundled session package is on the cordis track too; what separates the
		// two rows is which capability listed them, not their kind.
		expect(session).toMatchObject({ kind: "plugin-module", state: "active" });
	});

	it("waits for reset disposal before allowing a concurrent ensure", async () => {
		await Bun.write(
			hostEntry,
			`export const name = "fixture-host";
			export const inject = [];
			export function apply(ctx) {
				globalThis.${APPLY_COUNT} = (globalThis.${APPLY_COUNT} ?? 0) + 1;
				ctx.effect(async () => {
					globalThis.__musepiHostCleanupStarted?.();
					await globalThis.__musepiHostCleanupGate;
				});
			}`,
		);
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const globals = globalThis as Record<string, unknown>;
		globals.__musepiHostCleanupGate = gate.promise;
		globals.__musepiHostCleanupStarted = () => started.resolve();
		await ensureHostPlugins(process.cwd());
		const resetting = resetHostPlugins();
		await started.promise;
		let ensureSettled = false;
		const ensuring = ensureHostPlugins(process.cwd()).then(value => {
			ensureSettled = true;
			return value;
		});
		try {
			await Bun.sleep(20);
			expect(ensureSettled).toBe(false);
			expect(applyCount()).toBe(1);
		} finally {
			gate.resolve();
			await resetting;
			await ensuring;
		}
		expect(applyCount()).toBe(2);
	});

	it("rejects a conflicting service mount and cleans its effects", async () => {
		const source = (name: string) => `export const name = "${name}";
			export const inject = [];
			export const provide = ["${name}-extra", "shared"];
			export function apply(ctx) {
				globalThis.__musepiHostApplied = [...(globalThis.__musepiHostApplied ?? []), "${name}"];
				ctx.effect(() => {
					globalThis.__musepiHostRejectedCleanups = (globalThis.__musepiHostRejectedCleanups ?? 0) + 1;
				});
				return { ["${name}-extra"]: { name: "${name}-extra" }, shared: { name: "${name}" } };
			}`;
		await Bun.write(hostEntry, source("fixture-a"));
		await writePackage(
			path.join(root, "bundled-plugins", "fixture-b"),
			{ name: "fixture-b", musepi: { scope: "host", extensions: ["./index.ts"] } },
			source("fixture-b"),
		);

		await ensureHostPlugins(process.cwd());

		const applied = (globalThis as Record<string, unknown>).__musepiHostApplied as string[];
		expect(applied).toHaveLength(2);
		expect(getHostService<{ name: string }>("shared")).toMatchObject({ name: applied[0] });
		expect(getHostService(`${applied[0]}-extra`)).toMatchObject({ name: `${applied[0]}-extra` });
		expect(getHostService(`${applied[1]}-extra`)).toBeUndefined();
		expect((globalThis as Record<string, unknown>).__musepiHostRejectedCleanups).toBe(1);
	});

	it("keeps the previous instance without replaying apply when replacement fails", async () => {
		await Bun.write(
			hostEntry,
			`export const name = "fixture-host";
			export const inject = [];
			export const provide = ["fixture"];
			export function apply(ctx) {
				globalThis.${APPLY_COUNT} = (globalThis.${APPLY_COUNT} ?? 0) + 1;
				ctx.memory.registerBackendProvider({
					id: "fixture-host",
					label: "Fixture Host",
					create() { throw new Error("the fixture backend is never constructed"); },
				});
				if (globalThis.__musepiHostFailApply) throw new Error("intentional apply failure");
				return { fixture: { version: globalThis.${APPLY_COUNT} } };
			}`,
		);
		const hmr = createHmrService([], 0);
		provideHostService("hmr", hmr);
		await ensureHostPlugins(process.cwd());
		(globalThis as Record<string, unknown>).__musepiHostFailApply = true;

		const reloaded = await reloadHostPlugins([hostEntry]);

		expect(reloaded).toEqual([]);
		expect(applyCount()).toBe(2);
		expect(hmr.restartRequired).toBeNull();
		expect(getHostService("fixture")).toMatchObject({ version: 1 });
		expect(findMemoryBackendProvider("fixture-host" as never)).toMatchObject({ id: "fixture-host" });
		expect(inspectHostPlugins().find(entry => entry.name === "fixture-host")?.error).toContain(
			"intentional apply failure",
		);
	});
});

describe("shipped host plugins", () => {
	it("are listed by the extension center as active plugin modules", async () => {
		const roots = process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS;
		delete process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS;
		invalidateCapabilityCache();
		try {
			await expectShippedHostPluginsListed();
		} finally {
			if (roots !== undefined) process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS = roots;
			invalidateCapabilityCache();
		}
	}, 120_000);
});

async function expectShippedHostPluginsListed(): Promise<void> {
	const entries = await loadAllExtensions(process.cwd(), []);

	for (const name of ["hmr", "memory-sharpshooter"] as const) {
		const entry = entries.find(candidate => candidate.name === name && candidate.path.includes("bundled-plugins"));
		expect(entry, `${name} must be listed`).toBeDefined();
		expect(entry).toMatchObject({ kind: "plugin-module", state: "active", source: { level: "native" } });
	}
}
