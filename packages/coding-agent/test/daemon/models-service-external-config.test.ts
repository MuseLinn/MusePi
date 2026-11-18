import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@musepi/pi-ai";
import { ModelRegistry } from "../../src/config/model-registry";
import { ModelsService } from "../../src/daemon/services/models-service";

/** Stub auth storage: the custom provider is `auth: none`, so no credential is read. */
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

interface ModelRow {
	id: string;
	provider: string;
}

describe("ModelsService catalog freshness", () => {
	let tmpDir: string;
	let modelsPath: string;
	let registry: ModelRegistry;
	let service: ModelsService;

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

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(os.tmpdir(), "omp-models-service-"));
		modelsPath = path.join(tmpDir, "models.yaml");
		writeModels(["first-model", "removed-model"]);
		registry = new ModelRegistry(createStubAuthStorage(), modelsPath);
		service = new ModelsService({
			get: () => undefined,
			ensureRegistry: async () => registry,
			broadcastModelsChanged: () => {},
		});
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("catalog reads reflect a provider block rewritten outside the daemon", async () => {
		const initial = (await service.list({ sessionId: "history-only" })) as ModelRow[];
		expect(initial.some(row => row.provider === "gateway" && row.id === "first-model")).toBe(true);
		expect(initial.some(row => row.provider === "gateway" && row.id === "removed-model")).toBe(true);

		const bumped = new Date(statSync(modelsPath).mtimeMs + 1_000);
		writeModels(["first-model", "added-model"]);
		utimesSync(modelsPath, bumped, bumped);

		const listed = (await service.list({ sessionId: "history-only" })) as ModelRow[];
		expect(listed.some(row => row.provider === "gateway" && row.id === "added-model")).toBe(true);
		expect(listed.some(row => row.provider === "gateway" && row.id === "removed-model")).toBe(false);

		const available = (await service.listAvailable({})) as ModelRow[];
		expect(available.some(row => row.provider === "gateway" && row.id === "added-model")).toBe(true);

		const catalog = (await service.catalog({})) as { provider: string; modelCount: number }[];
		expect(catalog.find(group => group.provider === "gateway")?.modelCount).toBe(2);
	});
});
