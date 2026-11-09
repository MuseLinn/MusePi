import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	connectorMasterKeyPath,
	connectorSecretsPath,
	deleteConnectorSecrets,
	hasConnectorSecrets,
	mergeConnectorSecrets,
	readConnectorSecrets,
} from "./secrets";

async function tempAgentDir(): Promise<string> {
	return fs.mkdtemp(path.join(tmpdir(), "musepi-connector-secrets-"));
}

describe("connector secrets", () => {
	it("round-trips encrypted values without writing plaintext", async () => {
		const agentDir = await tempAgentDir();
		await mergeConnectorSecrets("alpha", { API_KEY: "super-secret-value" }, agentDir);

		expect(await readConnectorSecrets("alpha", agentDir)).toEqual({ API_KEY: "super-secret-value" });
		const onDisk = await fs.readFile(connectorSecretsPath(agentDir), "utf8");
		expect(onDisk).not.toContain("super-secret-value");
		expect(onDisk).toContain('"iv"');
		expect(onDisk).toContain('"tag"');
	});

	it("keeps stored values when the form sends blanks and removes on delete", async () => {
		const agentDir = await tempAgentDir();
		await mergeConnectorSecrets("alpha", { API_KEY: "first" }, agentDir);
		await mergeConnectorSecrets("alpha", { API_KEY: "", SECOND: "two" }, agentDir);

		expect(await readConnectorSecrets("alpha", agentDir)).toEqual({ API_KEY: "first", SECOND: "two" });
		expect(await hasConnectorSecrets("alpha", ["API_KEY"], agentDir)).toBe(true);

		await deleteConnectorSecrets("alpha", agentDir);
		expect(await readConnectorSecrets("alpha", agentDir)).toBeUndefined();
	});

	it("does not delete the vault when the master key no longer matches", async () => {
		const agentDir = await tempAgentDir();
		await mergeConnectorSecrets("alpha", { API_KEY: "first" }, agentDir);
		await fs.writeFile(connectorMasterKeyPath(agentDir), Buffer.alloc(32, 7), { mode: 0o600 });

		expect(await readConnectorSecrets("alpha", agentDir)).toBeUndefined();
		// The envelope is still there; a restored key can decrypt it again.
		const onDisk = await fs.readFile(connectorSecretsPath(agentDir), "utf8");
		expect(onDisk).toContain('"alpha"');
	});

	it("serializes concurrent writes for different connectors", async () => {
		const agentDir = await tempAgentDir();
		await Promise.all([
			mergeConnectorSecrets("alpha", { API_KEY: "a" }, agentDir),
			mergeConnectorSecrets("beta", { API_KEY: "b" }, agentDir),
		]);

		expect(await readConnectorSecrets("alpha", agentDir)).toEqual({ API_KEY: "a" });
		expect(await readConnectorSecrets("beta", agentDir)).toEqual({ API_KEY: "b" });
	});
});
