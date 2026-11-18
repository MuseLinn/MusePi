import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@musepi/pi-ai";
import { buildModel } from "@musepi/pi-catalog/build";
import { ModelRegistry } from "../../src/config/model-registry";

/** Stub auth storage for registry lifecycle and missing-credential coverage. */
function createStubAuthStorage(): AuthStorage {
	const stub = {
		setFallbackResolver: () => {},
		clearConfigApiKeys: () => {},
		hasAuth: () => false,
		peekApiKey: () => undefined,
		getApiKey: async () => undefined,
	};
	return stub as unknown as AuthStorage;
}

const testModel = buildModel({
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
});

describe("ModelRegistry", () => {
	let tmpDir: string;
	let registry: ModelRegistry;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(os.tmpdir(), "omp-reg-"));
		// Construct with an explicit modelsPath inside the temp dir so the
		// constructor's #loadModels read returns "not-found" rather than
		// touching the host's ~/.omp/agent/models.yaml. isBunTestRuntime()
		// auto-stubs #fetch in the constructor.
		registry = new ModelRegistry(createStubAuthStorage(), path.join(tmpDir, "models.yaml"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("resolves immediately when no background refresh is in flight", async () => {
		// No refreshInBackground() called → #backgroundRefresh is undefined.
		// The awaiter must settle within a single microtask, never hanging.
		let settled = false;
		const p = registry.awaitBackgroundRefresh().then(() => {
			settled = true;
		});
		await Promise.resolve();
		await p;
		expect(settled).toBe(true);
	});

	test("blocks until the in-flight background refresh resolves, then resolves", async () => {
		// Drive refreshInBackground with a controlled refresh() return value so
		// #backgroundRefresh is captured but not yet settled.
		const { promise, resolve } = Promise.withResolvers<void>();
		const refreshSpy = vi.spyOn(registry, "refresh").mockReturnValue(promise);

		registry.refreshInBackground();
		expect(refreshSpy).toHaveBeenCalledTimes(1);

		let settled = false;
		const awaitPromise = registry.awaitBackgroundRefresh().then(() => {
			settled = true;
		});

		// Yield to the microtask queue: the awaiter must still be pending.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(settled).toBe(false);

		resolve();

		await awaitPromise;
		expect(settled).toBe(true);
	});

	test("resolves even when the underlying refresh rejects (refreshInBackground swallows)", async () => {
		// refreshInBackground wraps refresh() in .catch(...) so discovery errors
		// never reach awaitBackgroundRefresh callers. The awaiter must resolve,
		// not propagate the rejection.
		const { promise, reject } = Promise.withResolvers<void>();
		vi.spyOn(registry, "refresh").mockReturnValue(promise);

		registry.refreshInBackground();

		let settled = false;
		const awaitPromise = registry.awaitBackgroundRefresh().then(() => {
			settled = true;
		});

		reject(new Error("synthetic discovery failure"));

		await awaitPromise;
		expect(settled).toBe(true);
	});

	test("awaiter is a no-op after the in-flight refresh settles and clears #backgroundRefresh", async () => {
		// Once refreshInBackground's promise resolves, #backgroundRefresh is
		// cleared in the .finally. A subsequent awaitBackgroundRefresh must be
		// an immediate no-op (microtask), not hang waiting for a stale promise
		// or a second refresh that was never started.
		const { promise, resolve } = Promise.withResolvers<void>();
		vi.spyOn(registry, "refresh").mockReturnValue(promise);

		registry.refreshInBackground();
		resolve();
		await registry.awaitBackgroundRefresh();

		// Now #backgroundRefresh is cleared. A fresh await must resolve in a
		// single microtask — measure by asserting it settles before a second
		// microtask tick.
		let settled = false;
		const p = registry.awaitBackgroundRefresh().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(true);
		await p;
	});

	test("refreshInBackground deduplicates: a second call while in-flight starts no new refresh", async () => {
		// The guard `if (this.#backgroundRefresh) return` at the top of
		// refreshInBackground prevents concurrent refreshes. A second call
		// while the first is still pending must not invoke refresh() again.
		const { promise, resolve } = Promise.withResolvers<void>();
		const refreshSpy = vi.spyOn(registry, "refresh").mockReturnValue(promise);

		registry.refreshInBackground();
		registry.refreshInBackground();
		registry.refreshInBackground();

		expect(refreshSpy).toHaveBeenCalledTimes(1);

		resolve();
		await registry.awaitBackgroundRefresh();

		// After settle, #backgroundRefresh is cleared — a new call DOES start
		// a fresh refresh.
		const { promise: secondPromise, resolve: secondResolve } = Promise.withResolvers<void>();
		refreshSpy.mockReturnValue(secondPromise);
		registry.refreshInBackground();
		expect(refreshSpy).toHaveBeenCalledTimes(2);

		secondResolve();
		await registry.awaitBackgroundRefresh();
	});
	test("resolves API keys and provider headers for legacy extensions", async () => {
		const model = testModel;
		vi.spyOn(registry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(registry, "getProviderHeaders").mockReturnValue({ "x-test": "value" });

		expect(await registry.getApiKeyAndHeaders(model)).toEqual({
			ok: true,
			apiKey: "test-key",
			headers: { "x-test": "value" },
		});
	});

	test("returns an error when authentication resolves without a credential", async () => {
		expect(await registry.getApiKeyAndHeaders(testModel)).toEqual({
			ok: false,
			error: 'No API key found for "test"',
		});
	});

	test("maps legacy extension auth failures into the result contract", async () => {
		const model = testModel;
		vi.spyOn(registry, "getApiKey").mockRejectedValue(new Error("auth failed"));

		expect(await registry.getApiKeyAndHeaders(model)).toEqual({ ok: false, error: "auth failed" });
	});

	test("a custom provider's label names it while its id stays the identity", () => {
		const modelsPath = path.join(tmpDir, "models.yaml");
		writeFileSync(
			modelsPath,
			[
				"providers:",
				"  my-gw:",
				"    label: My Gateway",
				"    baseUrl: https://gw.example/v1",
				"    api: openai-completions",
				"    auth: none",
				"    models:",
				"      - id: m1",
				"  unlabeled:",
				"    baseUrl: https://bare.example/v1",
				"    api: openai-completions",
				"    auth: none",
				"    models:",
				"      - id: m2",
				"",
			].join("\n"),
		);
		const labeled = new ModelRegistry(createStubAuthStorage(), modelsPath);
		expect(labeled.getError()).toBeUndefined();
		// The picker's header and model rows read the label; refs, favorites and
		// role pins keep the provider id.
		expect(labeled.getProviderLabel("my-gw")).toBe("My Gateway");
		expect(labeled.find("my-gw", "m1")?.provider).toBe("my-gw");
		expect(labeled.getProviderLabel("unlabeled")).toBeUndefined();
	});

	test("an empty label fails the file instead of naming a provider with nothing", () => {
		const modelsPath = path.join(tmpDir, "models.yaml");
		writeFileSync(
			modelsPath,
			["providers:", "  my-gw:", '    label: " "', "    baseUrl: https://gw.example/v1", ""].join("\n"),
		);
		const broken = new ModelRegistry(createStubAuthStorage(), modelsPath);
		expect(broken.getError()).toBeDefined();
		expect(broken.getProviderLabel("my-gw")).toBeUndefined();
	});

	test("refreshIfStale reloads the custom catalog only after models.yml changed on disk", async () => {
		// A provider plugin (magpie) rewrites providers.magpie.models without
		// going through the registry. A read must catch up on the next call, and
		// an unchanged file must not rebuild the catalog.
		const modelsPath = path.join(tmpDir, "models.yaml");
		const writeModels = (ids: string[]) =>
			writeFileSync(
				modelsPath,
				[
					"providers:",
					"  gateway:",
					"    baseUrl: http://127.0.0.1:9991",
					"    api: openai-completions",
					"    auth: none",
					"    models:",
					...ids.map(id => `      - id: ${id}`),
					"",
				].join("\n"),
			);
		writeModels(["first-model", "removed-model"]);
		const staleRegistry = new ModelRegistry(createStubAuthStorage(), modelsPath);
		expect(staleRegistry.find("gateway", "added-model")).toBeUndefined();

		expect(await staleRegistry.refreshIfStale()).toBe(false);

		const bumped = new Date(statSync(modelsPath).mtimeMs + 1_000);
		writeModels(["first-model", "added-model"]);
		utimesSync(modelsPath, bumped, bumped);
		// The in-memory snapshot still holds the boot-time list.
		expect(staleRegistry.find("gateway", "added-model")).toBeUndefined();

		expect(await staleRegistry.refreshIfStale()).toBe(true);
		expect(staleRegistry.find("gateway", "added-model")).toBeDefined();
		expect(staleRegistry.find("gateway", "removed-model")).toBeUndefined();
		expect(await staleRegistry.refreshIfStale()).toBe(false);
	});

	test("a configured provider baseUrl wins before any model is discovered", () => {
		// A discovery-only provider has no model to read a URL from cache-cold.
		// Deriving solely from models left this `undefined`, which sent a
		// proxy-scoped credential probe to the provider's canonical host.
		writeFileSync(
			path.join(tmpDir, "models.yaml"),
			[
				"providers:",
				"  override-leads:",
				"    baseUrl: https://proxy.example.test/v1",
				"    api: anthropic-messages",
				"",
			].join("\n"),
		);
		// The registry resolves its config file through the agent dir, so the
		// lookup runs in a subprocess scoped to the temp dir.
		const script = `
			import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
			import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
			const authStorage = await AuthStorage.create(":memory:");
			try {
				const registry = new ModelRegistry(authStorage);
				process.stdout.write(JSON.stringify(registry.getProviderBaseUrl("override-leads") ?? null));
			} finally {
				authStorage.close();
			}
		`;
		const result = Bun.spawnSync([process.execPath, "-e", script], {
			cwd: path.resolve(import.meta.dir, "../.."),
			env: { ...process.env, PI_CODING_AGENT_DIR: tmpDir },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new TextDecoder().decode(result.stdout).trim();
		const stderr = new TextDecoder().decode(result.stderr).trim();

		expect(result.exitCode, stderr || stdout).toBe(0);
		expect(JSON.parse(stdout)).toBe("https://proxy.example.test/v1");
	});
});
