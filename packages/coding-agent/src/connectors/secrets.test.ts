import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	clearUnifiedKeysForTests,
	rewrapMasterKey,
	unifiedKeyPath,
	unlockMasterKeyInMemory,
	unwrapMasterKeyToFile,
	wrapMasterKey,
} from "@musepi/pi-utils/unified-master-key";
import { clearUnlockedMasterKeysForTests } from "../secrets/encrypted-store";
import {
	connectorKeyLocked,
	connectorKeyState,
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
		// Replace the profile's shared key with different bytes, as a copied
		// store from another machine would. The store must report "no usable
		// secret" and leave the ciphertext alone rather than wiping it.
		await fs.writeFile(unifiedKeyPath(agentDir), Buffer.alloc(32, 7), { mode: 0o600 });
		clearUnifiedKeysForTests();

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

	it("follows the shared key rather than keeping its own", async () => {
		const agentDir = await tempAgentDir();
		await mergeConnectorSecrets("alpha", { API_KEY: "value" }, agentDir);

		// The passphrase lives on the profile's shared key; the connector store
		// does not write a key of its own any more.
		await wrapMasterKey(agentDir, "correct horse battery");
		await expect(fs.access(unifiedKeyPath(agentDir))).rejects.toThrow();
		expect(await connectorKeyState(agentDir)).toMatchObject({ mode: "passphrase" });

		clearUnlockedMasterKeysForTests();
		delete process.env.MUSEPI_AGENT_SECRET_PASSPHRASE;
		// Locked with the vault: the same key is what decrypts both.
		expect(await connectorKeyLocked(agentDir)).toBe(true);
		expect(await readConnectorSecrets("alpha", agentDir)).toBeUndefined();

		await unlockMasterKeyInMemory(agentDir, "correct horse battery");
		expect(await readConnectorSecrets("alpha", agentDir)).toEqual({ API_KEY: "value" });
	});

	it("refuses the wrong passphrase without touching the file", async () => {
		const agentDir = await tempAgentDir();
		await mergeConnectorSecrets("alpha", { API_KEY: "value" }, agentDir);
		await wrapMasterKey(agentDir, "correct horse battery");
		clearUnlockedMasterKeysForTests();

		expect(() => unlockMasterKeyInMemory(agentDir, "wrong passphrase")).toThrow();
		const onDisk = await fs.readFile(connectorSecretsPath(agentDir), "utf8");
		expect(onDisk).toContain('"alpha"');
	});

	it("restores the plain key file when the passphrase is removed", async () => {
		const agentDir = await tempAgentDir();
		await mergeConnectorSecrets("alpha", { API_KEY: "value" }, agentDir);
		await wrapMasterKey(agentDir, "correct horse battery");
		clearUnlockedMasterKeysForTests();

		unwrapMasterKeyToFile(agentDir, "correct horse battery");
		expect((await connectorKeyState(agentDir)).mode).toBe("plain");
		expect(await readConnectorSecrets("alpha", agentDir)).toEqual({ API_KEY: "value" });
	});

	it("re-wraps the same key under a new passphrase", async () => {
		const agentDir = await tempAgentDir();
		await mergeConnectorSecrets("alpha", { API_KEY: "value" }, agentDir);
		await wrapMasterKey(agentDir, "first passphrase");

		rewrapMasterKey(agentDir, "first passphrase", "second passphrase");
		clearUnlockedMasterKeysForTests();

		expect(() => unlockMasterKeyInMemory(agentDir, "first passphrase")).toThrow();
		unlockMasterKeyInMemory(agentDir, "second passphrase");
		// The values are unchanged: the master key was re-wrapped, not replaced.
		expect(await readConnectorSecrets("alpha", agentDir)).toEqual({ API_KEY: "value" });
	});
});
