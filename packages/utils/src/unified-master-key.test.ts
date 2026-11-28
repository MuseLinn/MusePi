import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	clearUnifiedKeysForTests,
	readMasterKey,
	rewrapMasterKey,
	unifiedKeyPath,
	unifiedKeyState,
	unlockMasterKeyInMemory,
	unwrapMasterKeyToFile,
	wrapMasterKey,
} from "./unified-master-key";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(tmpdir(), "musepi-unified-key-"));
}

describe("unified master key", () => {
	it("creates one key file per profile and reuses it", () => {
		const agentDir = tempAgentDir();
		const first = readMasterKey({ agentDir });
		const second = readMasterKey({ agentDir });
		expect(first).toHaveLength(32);
		expect(second.equals(first)).toBe(true);
		expect(fs.readFileSync(unifiedKeyPath(agentDir)).equals(first)).toBe(true);
	});

	it("adopts a store's own key so nothing has to be re-encrypted", () => {
		const agentDir = tempAgentDir();
		// A store that predates the merge wrote its own key here.
		const ownKey = Buffer.alloc(32, 7);
		const legacyPath = path.join(agentDir, "connectors", ".master.key");
		fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
		fs.writeFileSync(legacyPath, ownKey, { mode: 0o600 });

		const adopted = readMasterKey({
			agentDir,
			legacyKeyPath: path.join("connectors", ".master.key"),
		});
		// Same bytes means the store's existing ciphertext still decrypts.
		expect(adopted.equals(ownKey)).toBe(true);
		// And every later store lands on the same key.
		expect(readMasterKey({ agentDir }).equals(ownKey)).toBe(true);
	});

	it("prefers an explicit environment key over the files", () => {
		const agentDir = tempAgentDir();
		const envKey = Buffer.alloc(32, 9);
		const previous = process.env.MUSEPI_MASTER_KEY;
		process.env.MUSEPI_MASTER_KEY = envKey.toString("hex");
		try {
			expect(readMasterKey({ agentDir }).equals(envKey)).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.MUSEPI_MASTER_KEY;
			else process.env.MUSEPI_MASTER_KEY = previous;
		}
	});

	it("locks every store behind one passphrase", () => {
		const agentDir = tempAgentDir();
		const key = readMasterKey({ agentDir });
		wrapMasterKey(agentDir, "correct horse battery");

		// The plain key is gone; a copied key file alone cannot derive anything.
		expect(fs.existsSync(unifiedKeyPath(agentDir))).toBe(false);
		expect(unifiedKeyState(agentDir).mode).toBe("passphrase");

		clearUnifiedKeysForTests();
		const previous = process.env.MUSEPI_AGENT_SECRET_PASSPHRASE;
		delete process.env.MUSEPI_AGENT_SECRET_PASSPHRASE;
		try {
			expect(unifiedKeyState(agentDir)).toMatchObject({ mode: "passphrase", locked: true });
			expect(() => readMasterKey({ agentDir })).toThrow();

			unlockMasterKeyInMemory(agentDir, "correct horse battery");
			expect(readMasterKey({ agentDir }).equals(key)).toBe(true);

			clearUnifiedKeysForTests();
			unwrapMasterKeyToFile(agentDir, "correct horse battery");
			expect(unifiedKeyState(agentDir).mode).toBe("plain");
			expect(readMasterKey({ agentDir }).equals(key)).toBe(true);
		} finally {
			if (previous !== undefined) process.env.MUSEPI_AGENT_SECRET_PASSPHRASE = previous;
		}
	});

	it("refuses a wrong passphrase without touching the wrapped key", () => {
		const agentDir = tempAgentDir();
		readMasterKey({ agentDir });
		wrapMasterKey(agentDir, "correct horse battery");
		clearUnifiedKeysForTests();
		const wrappedPath = path.join(agentDir, ".master.key.wrapped");
		const before = fs.readFileSync(wrappedPath, "utf8");

		expect(() => unlockMasterKeyInMemory(agentDir, "wrong passphrase")).toThrow();
		expect(fs.readFileSync(wrappedPath, "utf8")).toBe(before);
	});

	it("re-wraps the same key under a new passphrase", () => {
		const agentDir = tempAgentDir();
		const key = readMasterKey({ agentDir });
		wrapMasterKey(agentDir, "first passphrase");

		rewrapMasterKey(agentDir, "first passphrase", "second passphrase");
		clearUnifiedKeysForTests();

		expect(() => unlockMasterKeyInMemory(agentDir, "first passphrase")).toThrow();
		unlockMasterKeyInMemory(agentDir, "second passphrase");
		// Same key bytes: no store had to re-encrypt anything.
		expect(readMasterKey({ agentDir }).equals(key)).toBe(true);
	});
});
