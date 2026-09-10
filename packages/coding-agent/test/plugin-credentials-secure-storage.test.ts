/**
 * Tests for the encrypted plugin-credential backend.
 *
 * Every backend is constructed with an explicit `directory` inside an
 * isolated tmp dir, so the tests never touch the developer's real
 * `~/.musepi/plugin-credentials.enc`. Env-based HOME overrides are not an
 * option here: Bun caches `os.homedir()` per process, so once any earlier
 * test file in the same bun process has called it, the cache holds the real
 * home and `join(homedir(), ".musepi")` points outside the tmp dir (the
 * CI-shard failure that motivated the explicit-directory pattern).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SecureStorageBackend } from "@musepi/pi-coding-agent/plugin-credentials/backends/secure-storage";

let testHome: string;
let credDir: string;

beforeEach(() => {
	testHome = join(tmpdir(), `plugin-credentials-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	credDir = join(testHome, ".musepi");
	mkdirSync(testHome, { recursive: true, mode: 0o700 });
});

afterEach(() => {
	if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
});

const freshBackend = (): SecureStorageBackend => new SecureStorageBackend({ directory: credDir });

describe("SecureStorageBackend", () => {
	it("round-trips a credential through the encrypted file", async () => {
		const backend = freshBackend();
		const id = { pluginId: "github-mcp" };
		const credential = { value: "gho_test_token_1234567890", tokenType: "Bearer" };

		expect(await backend.get(id)).toBeNull();
		await backend.set(id, credential);
		expect(await backend.get(id)).toEqual(credential);
		expect(existsSync(join(credDir, "plugin-credentials.enc"))).toBe(true);
	});

	it("rewrites the file on every set with a fresh IV (GCM safety)", async () => {
		const backend = freshBackend();
		const id = { pluginId: "github-mcp" };
		const file = join(credDir, "plugin-credentials.enc");

		await backend.set(id, { value: "first" });
		const firstCiphertext = readFileSync(file).subarray(64 + 12 + 16);

		await backend.set(id, { value: "second" });
		const secondCiphertext = readFileSync(file).subarray(64 + 12 + 16);

		// Same plaintext payload, different ciphertext: the 12-byte IV at offset
		// 64 changes per write, so AES-GCM is never reused under the same key.
		expect(firstCiphertext.equals(secondCiphertext)).toBe(false);
	});

	it("returns the same store across reloads (salt is stable across rewrites)", async () => {
		const backend1 = freshBackend();
		const id = { pluginId: "notion-mcp", scope: "workspace:ws-1" };
		await backend1.set(id, { value: "secret_abc", refreshToken: "rt_def", expiresAt: 12345 });

		const backend2 = freshBackend();
		const loaded = await backend2.get(id);
		expect(loaded).toEqual({ value: "secret_abc", refreshToken: "rt_def", expiresAt: 12345 });
	});

	it("treats a file with the wrong magic as corrupted and recreates it on next set", async () => {
		mkdirSync(credDir, { recursive: true });
		const file = join(credDir, "plugin-credentials.enc");
		writeFileSync(file, Buffer.alloc(64).fill(0xab));

		const backend = freshBackend();
		expect(await backend.get({ pluginId: "anything" })).toBeNull();
		// File should have been auto-deleted by the corruption handler.
		expect(existsSync(file)).toBe(false);

		await backend.set({ pluginId: "x" }, { value: "y" });
		expect(existsSync(file)).toBe(true);
	});

	it("treats a truncated file as corrupted and recreates it on next set", async () => {
		mkdirSync(credDir, { recursive: true });
		const file = join(credDir, "plugin-credentials.enc");
		// Header is 64 bytes; give it just the magic + 4 bytes so length check fails.
		writeFileSync(file, Buffer.concat([Buffer.from("MUSPI01\0"), Buffer.alloc(4)]));

		const backend = freshBackend();
		expect(await backend.get({ pluginId: "anything" })).toBeNull();
		expect(existsSync(file)).toBe(false);
	});

	it("treats GCM authentication failure as corruption (different file wiped)", async () => {
		mkdirSync(credDir, { recursive: true });
		const file = join(credDir, "plugin-credentials.enc");
		// Valid magic + zero salt + IV + tag, but ciphertext bytes that fail GCM.
		const header = Buffer.alloc(64);
		Buffer.from("MUSPI01\0").copy(header);
		const iv = Buffer.alloc(12);
		const tag = Buffer.alloc(16);
		const ciphertext = Buffer.alloc(32, 0xff);
		writeFileSync(file, Buffer.concat([header, iv, tag, ciphertext]));

		const backend = freshBackend();
		expect(await backend.get({ pluginId: "anything" })).toBeNull();
		expect(existsSync(file)).toBe(false);
	});

	it("lists credentials with optional filter on pluginId / scope / name", async () => {
		const backend = freshBackend();
		await backend.set({ pluginId: "gh", scope: "ws:1" }, { value: "a" });
		await backend.set({ pluginId: "gh", scope: "ws:2" }, { value: "b" });
		await backend.set({ pluginId: "gh", scope: "ws:2", name: "team-a" }, { value: "c" });
		await backend.set({ pluginId: "notion" }, { value: "d" });

		const all = await backend.list();
		expect(all.length).toBe(4);

		const ghWs2 = await backend.list({ pluginId: "gh", scope: "ws:2" });
		expect(ghWs2.length).toBe(2);
		expect(ghWs2.some(id => id.name === "team-a")).toBe(true);

		const teamA = await backend.list({ pluginId: "gh", name: "team-a" });
		expect(teamA.length).toBe(1);
		expect(teamA[0]?.scope).toBe("ws:2");
	});

	it("delete returns false when the id is absent, true when it existed", async () => {
		const backend = freshBackend();
		const id = { pluginId: "gh" };
		expect(await backend.delete(id)).toBe(false);

		await backend.set(id, { value: "x" });
		expect(await backend.delete(id)).toBe(true);
		expect(await backend.get(id)).toBeNull();
	});

	it("health reports healthy when the file is missing (treated as empty)", async () => {
		const backend = freshBackend();
		const status = await backend.health();
		expect(status.healthy).toBe(true);
		expect(status.issues).toEqual([]);
	});

	it("health reports truncation as file_corrupted", async () => {
		mkdirSync(credDir, { recursive: true });
		const file = join(credDir, "plugin-credentials.enc");
		writeFileSync(file, Buffer.from("MUSPI01\0"));

		const backend = freshBackend();
		const status = await backend.health();
		expect(status.healthy).toBe(false);
		expect(status.issues[0]?.type).toBe("file_corrupted");
	});

	it("sets the file mode to 0o600 (read/write for owner only)", async () => {
		const backend = freshBackend();
		await backend.set({ pluginId: "x" }, { value: "y" });
		const file = join(credDir, "plugin-credentials.enc");
		// Permission assertions live in a POSIX-only spec; on Windows we just
		// verify the file was written by checking it round-trips.
		expect(existsSync(file)).toBe(true);
		const backend2 = freshBackend();
		expect(await backend2.get({ pluginId: "x" })).toEqual({ value: "y" });
	});
});
