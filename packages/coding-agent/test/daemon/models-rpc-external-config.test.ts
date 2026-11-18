import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync, utimesSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@musepi/pi-utils";
import type { DaemonConnection } from "../../src/daemon/server";
import { DaemonServer, DaemonSessionHost } from "../../src/daemon/server";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

interface ModelRow {
	id: string;
	provider: string;
}

/**
 * The user-visible scenario behind the picker going stale: a provider plugin
 * rewrites `models.yml` while the daemon keeps running, and the next catalog
 * RPC must answer from the new file — no daemon restart, no new session.
 */
describe("models RPC after an external models.yml edit", () => {
	let isolatedAgentDir = "";
	let modelsPath = "";

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

	beforeAll(async () => {
		isolatedAgentDir = await isolateAgentDirForTest("models-rpc-external-");
		modelsPath = path.join(getAgentDir(), "models.yml");
		writeModels(["first-model"]);
	}, 30_000);

	afterAll(async () => {
		await restoreAgentDirForTest(isolatedAgentDir);
	}, 30_000);

	test("models.listAvailable reflects a models.yml rewrite without a restart", async () => {
		const host = new DaemonSessionHost({ cwd: isolatedAgentDir });
		const registry = await host.ensureRegistry();
		const server = new DaemonServer(host);
		const conn = { id: "c1" } as unknown as DaemonConnection;
		try {
			const before = (await server.handle("models.listAvailable", {}, conn)) as ModelRow[];
			expect(before.some(row => row.provider === "gateway" && row.id === "first-model")).toBe(true);

			const bumped = new Date(statSync(modelsPath).mtimeMs + 1_000);
			writeModels(["first-model", "added-model"]);
			utimesSync(modelsPath, bumped, bumped);

			const after = (await server.handle("models.listAvailable", {}, conn)) as ModelRow[];
			expect(after.some(row => row.provider === "gateway" && row.id === "added-model")).toBe(true);
		} finally {
			host.dispose();
			registry?.authStorage.close();
		}
	}, 60_000);
});
