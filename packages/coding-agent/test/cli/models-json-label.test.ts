import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runModelsListing } from "../../src/cli/models-cli";
import { ModelRegistry } from "../../src/config/model-registry";
import { discoverAuthStorage } from "../../src/sdk";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Windows keeps the auth SQLite handles open until process exit.
		}
	}
});

/** Capture the listing's stdout for one call (the CLI writes lines itself). */
async function listingJson(registry: ModelRegistry, cwd: string): Promise<{ models: Record<string, unknown>[] }> {
	const chunks: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		await runModelsListing({ modelRegistry: registry, cwd, json: true, disableExtensionDiscovery: true });
	} finally {
		process.stdout.write = original;
	}
	return JSON.parse(chunks.join("")) as { models: Record<string, unknown>[] };
}

describe("musepi models ls --json", () => {
	test("names each model's provider and the provider's display label", async () => {
		// The JSON shape is the machine-readable inventory external tools read;
		// the label is what the picker shows, the id what refs use.
		const dir = mkdtempSync(path.join(os.tmpdir(), "models-json-"));
		dirs.push(dir);
		const modelsPath = path.join(dir, "models.yml");
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
				"",
			].join("\n"),
		);
		const auth = await discoverAuthStorage(dir);
		const registry = new ModelRegistry(auth, modelsPath);
		try {
			expect(registry.getError()).toBeUndefined();

			const json = await listingJson(registry, dir);
			const row = json.models.find(model => model.provider === "my-gw" && model.id === "m1");
			expect(row).toBeDefined();
			expect(row?.providerLabel).toBe("My Gateway");
			expect(row?.selector).toBe("my-gw/m1");
		} finally {
			auth.close();
		}
	});
});
