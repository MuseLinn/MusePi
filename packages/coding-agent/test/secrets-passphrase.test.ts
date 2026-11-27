import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnifiedKeyLockedError, unifiedKeyPath, unifiedWrappedKeyPath } from "@musepi/pi-utils/unified-master-key";
import { AgentSecretStore } from "../src/secrets/agent-store";
import {
	clearUnlockedMasterKeysForTests,
	MASTER_KEY_PASSPHRASE_ENV,
	MASTER_KEY_PASSPHRASE_FILE_ENV,
} from "../src/secrets/encrypted-store";

const PASSPHRASE = "correct horse battery";
const VALUE = "sk-passphrase-secret-123";

function makeAgentDir(): string {
	return mkdtempSync(join(tmpdir(), "musepi-agent-passphrase-"));
}

function keyPaths(agentDir: string): { plain: string; wrapped: string } {
	return {
		plain: unifiedKeyPath(agentDir),
		wrapped: unifiedWrappedKeyPath(agentDir),
	};
}

/** A second store in a fresh "process": the in-memory unlock cache is cleared. */
function lockedStore(agentDir: string): AgentSecretStore {
	clearUnlockedMasterKeysForTests();
	return new AgentSecretStore(agentDir);
}

afterEach(() => {
	clearUnlockedMasterKeysForTests();
	delete process.env[MASTER_KEY_PASSPHRASE_ENV];
	delete process.env[MASTER_KEY_PASSPHRASE_FILE_ENV];
});

describe("agent secret store passphrase", () => {
	it("wraps the master key and locks the store for a new process", async () => {
		const agentDir = makeAgentDir();
		const store = new AgentSecretStore(agentDir);
		await store.set("API_TOKEN", VALUE, "test");
		await store.encrypt(PASSPHRASE);

		const paths = keyPaths(agentDir);
		expect(existsSync(paths.plain)).toBe(false);
		expect(existsSync(paths.wrapped)).toBe(true);
		expect(await store.status()).toMatchObject({ protectedBy: "passphrase", locked: false });

		const locked = lockedStore(agentDir);
		expect(await locked.status()).toEqual({
			mode: "encrypted",
			count: 1,
			protectedBy: "passphrase",
			locked: true,
			reason: "missing-passphrase",
		});
		// Metadata stays readable so the page can still show what is stored.
		expect((await locked.list()).map(entry => entry.name)).toEqual(["API_TOKEN"]);
		expect(await locked.getValue("API_TOKEN")).toBeUndefined();
		await expect(locked.set("OTHER_TOKEN", "another-value-123")).rejects.toBeInstanceOf(UnifiedKeyLockedError);

		await expect(locked.unlock("not the passphrase")).rejects.toBeInstanceOf(UnifiedKeyLockedError);
		await expect(locked.unlock(PASSPHRASE)).resolves.toBeUndefined();
		expect(await locked.getValue("API_TOKEN")).toBe(VALUE);
		expect(await locked.status()).toMatchObject({ locked: false });
	});

	it("restores the plain key file when the passphrase is removed", async () => {
		const agentDir = makeAgentDir();
		const store = new AgentSecretStore(agentDir);
		await store.set("API_TOKEN", VALUE, "test");
		await store.encrypt(PASSPHRASE);

		const locked = lockedStore(agentDir);
		await expect(locked.decrypt(PASSPHRASE)).resolves.toBeUndefined();

		const paths = keyPaths(agentDir);
		expect(existsSync(paths.plain)).toBe(true);
		expect(existsSync(paths.wrapped)).toBe(false);
		expect(await locked.status()).toMatchObject({ protectedBy: "key-file", locked: false });
		expect(await lockedStore(agentDir).getValue("API_TOKEN")).toBe(VALUE);
	});

	it("unlocks from the passphrase environment variable", async () => {
		const agentDir = makeAgentDir();
		const store = new AgentSecretStore(agentDir);
		await store.set("API_TOKEN", VALUE, "test");
		await store.encrypt(PASSPHRASE);

		process.env[MASTER_KEY_PASSPHRASE_ENV] = PASSPHRASE;
		const unattended = lockedStore(agentDir);
		expect(await unattended.status()).toMatchObject({ locked: false });
		expect(await unattended.getValue("API_TOKEN")).toBe(VALUE);

		process.env[MASTER_KEY_PASSPHRASE_ENV] = "not the passphrase";
		const wrong = lockedStore(agentDir);
		expect(await wrong.status()).toEqual({
			mode: "encrypted",
			count: 1,
			protectedBy: "passphrase",
			locked: true,
			reason: "wrong-passphrase",
		});
	});

	it("reads the passphrase from a file without its trailing newline", async () => {
		const agentDir = makeAgentDir();
		const store = new AgentSecretStore(agentDir);
		await store.set("API_TOKEN", VALUE, "test");
		await store.encrypt(PASSPHRASE);

		const file = join(agentDir, "passphrase.txt");
		writeFileSync(file, `${PASSPHRASE}\n`, "utf8");
		process.env[MASTER_KEY_PASSPHRASE_FILE_ENV] = file;

		expect(await lockedStore(agentDir).getValue("API_TOKEN")).toBe(VALUE);
	});

	it("changes the passphrase without ever writing the plain key", async () => {
		const agentDir = makeAgentDir();
		const store = new AgentSecretStore(agentDir);
		await store.set("API_TOKEN", VALUE, "test");
		await store.encrypt(PASSPHRASE);

		const locked = lockedStore(agentDir);
		await expect(locked.rephrase("not the passphrase", "another passphrase")).rejects.toBeInstanceOf(
			UnifiedKeyLockedError,
		);
		await expect(locked.rephrase(PASSPHRASE, "another passphrase")).resolves.toBeUndefined();
		// The two-step alternative would leave the key unprotected here.
		expect(existsSync(keyPaths(agentDir).plain)).toBe(false);
		expect(await locked.getValue("API_TOKEN")).toBe(VALUE);

		const next = lockedStore(agentDir);
		expect(await next.status()).toMatchObject({ protectedBy: "passphrase", locked: true });
		await expect(next.unlock(PASSPHRASE)).rejects.toBeInstanceOf(UnifiedKeyLockedError);
		await next.unlock("another passphrase");
		expect(await next.getValue("API_TOKEN")).toBe(VALUE);
	});

	it("rejects short, repeated and empty passphrases", async () => {
		const agentDir = makeAgentDir();
		const store = new AgentSecretStore(agentDir);
		await store.set("API_TOKEN", VALUE, "test");

		await expect(store.encrypt("short")).rejects.toThrow(/at least 8/u);
		await expect(store.encrypt("")).rejects.toThrow(/at least 8/u);
		await store.encrypt(PASSPHRASE);
		await expect(store.encrypt("another passphrase")).rejects.toThrow(/already protected/u);
	});
});
