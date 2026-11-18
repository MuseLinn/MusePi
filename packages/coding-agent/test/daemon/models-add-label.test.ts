import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { ModelRegistry } from "../../src/config/model-registry";
import { ModelsConfigFile } from "../../src/config/models-config";
import { ModelsService } from "../../src/daemon/services/models-service";
import { discoverAuthStorage } from "../../src/sdk";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

let isolatedAgentDir = "";

beforeAll(async () => {
	isolatedAgentDir = await isolateAgentDirForTest("models-add-label-");
}, 30_000);

afterAll(async () => {
	await restoreAgentDirForTest(isolatedAgentDir);
}, 30_000);

describe("models.add display label", () => {
	test("writes providers.<id>.label, and null takes it back out", async () => {
		const modelsPath = ModelsConfigFile.path();
		const registry = new ModelRegistry(await discoverAuthStorage(isolatedAgentDir), modelsPath);
		const service = new ModelsService({
			get: () => undefined,
			ensureRegistry: async () => registry,
			broadcastModelsChanged: () => {},
		});
		const base = {
			name: "my-gw",
			baseUrl: "https://gw.example/v1",
			apiKey: "test-key",
			api: "openai-completions",
			models: [{ id: "m1" }],
		};

		await service.add({ provider: { ...base, label: "My Gateway" } });
		const written = YAML.parse(readFileSync(modelsPath, "utf8")) as {
			providers: Record<string, { label?: string }>;
		};
		expect(written.providers["my-gw"]?.label).toBe("My Gateway");
		// The registry's next refresh reads it: the picker's provider header
		// uses this label while the id stays the identity.
		await registry.refreshIfStale();
		expect(registry.getProviderLabel("my-gw")).toBe("My Gateway");

		await service.add({ provider: { ...base, label: null } });
		const cleared = YAML.parse(readFileSync(modelsPath, "utf8")) as {
			providers: Record<string, { label?: string }>;
		};
		expect("label" in (cleared.providers["my-gw"] ?? {})).toBe(false);
	});
});
