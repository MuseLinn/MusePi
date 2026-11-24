import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { clearUnlockedMasterKeysForTests } from "../secrets/encrypted-store";
import {
	connectorKeyLocked,
	connectorKeyState,
	connectorMasterKeyPath,
	connectorSecretsPath,
	decryptConnectorKey,
	deleteConnectorSecrets,
	encryptConnectorKey,
	hasConnectorSecrets,
	mergeConnectorSecrets,
	readConnectorSecrets,
	rephraseConnectorKey,
	unlockConnectorKey,
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

	it("locks the connector tokens behind the same passphrase", async () => {
		const agentDir = await tempAgentDir();
		await mergeConnectorSecrets("alpha", { API_KEY: "super-secret-value" }, agentDir);
		await encryptConnectorKey("correct horse battery", agentDir);

		// The plain key is gone, so a copied store file alone cannot be read.
		await expect(fs.access(connectorMasterKeyPath(agentDir))).rejects.toThrow();
		expect((await connectorKeyState(agentDir)).mode).toBe("passphrase");

		// This process already holds the key from wrapping it; a fresh process
		// (no environment passphrase) reads it as locked.
		clearUnlockedMasterKeysForTests();
		delete process.env.MUSEPI_AGENT_SECRET_PASSPHRASE;
		expect(await connectorKeyLocked(agentDir)).toBe(true);
		expect(await readConnectorSecrets("alpha", agentDir)).toBeUndefined();

		await unlockConnectorKey("correct horse battery", agentDir);
		expect(await connectorKeyLocked(agentDir)).toBe(false);
		expect(await readConnectorSecrets("alpha", agentDir)).toEqual({ API_KEY: "super-secret-value" });
	});

	it("refuses the wrong passphrase without touching the file", async () => {
		const agentDir = await tempAgentDir();
		await mergeConnectorSecrets("alpha", { API_KEY: "value" }, agentDir);
		await encryptConnectorKey("correct horse battery", agentDir);
		clearUnlockedMasterKeysForTests();

		await expect(unlockConnectorKey("wrong passphrase", agentDir)).rejects.toThrow();
		const onDisk = await fs.readFile(connectorSecretsPath(agentDir), "utf8");
		expect(onDisk).toContain('"alpha"');
	});

	it("restores the plain key file when the passphrase is removed", async () => {
		const agentDir = await tempAgentDir();
		await mergeConnectorSecrets("alpha", { API_KEY: "value" }, agentDir);
		await encryptConnectorKey("correct horse battery", agentDir);
		clearUnlockedMasterKeysForTests();

		await decryptConnectorKey("correct horse battery", agentDir);
		expect((await connectorKeyState(agentDir)).mode).toBe("plain");
		expect(await readConnectorSecrets("alpha", agentDir)).toEqual({ API_KEY: "value" });
	});

	it("re-wraps the same key under a new passphrase", async () => {
		const agentDir = await tempAgentDir();
		await mergeConnectorSecrets("alpha", { API_KEY: "value" }, agentDir);
		await encryptConnectorKey("first passphrase", agentDir);

		await rephraseConnectorKey("first passphrase", "second passphrase", agentDir);
		clearUnlockedMasterKeysForTests();

		await expect(unlockConnectorKey("first passphrase", agentDir)).rejects.toThrow();
		await unlockConnectorKey("second passphrase", agentDir);
		// The values are unchanged: the master key was re-wrapped, not replaced.
		expect(await readConnectorSecrets("alpha", agentDir)).toEqual({ API_KEY: "value" });
	});
});
