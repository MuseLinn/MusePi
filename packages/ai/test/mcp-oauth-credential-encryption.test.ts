import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore, serializeCredential } from "../src/auth/sqlite-credential-store";
import type { OAuthCredentials } from "../src/registry/oauth/types";

const MCP = "mcp_oauth:profile:default:https://mcp.example/mcp";
const OTHER = "anthropic";

function creds(access: string): OAuthCredentials {
	return { access, refresh: "refresh-token", expires: Date.now() + 3_600_000 };
}

const dirs: string[] = [];
const stores: SqliteAuthCredentialStore[] = [];

async function tempDb(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "musepi-mcp-oauth-enc-"));
	dirs.push(dir);
	return path.join(dir, "agent.db");
}

async function openStore(dbPath: string): Promise<SqliteAuthCredentialStore> {
	const store = await SqliteAuthCredentialStore.open(dbPath);
	stores.push(store);
	return store;
}

function rawRow(dbPath: string, provider: string): { id: number; data: string; secret: string | null } {
	const db = new Database(dbPath);
	try {
		return db
			.prepare("SELECT id, data, secret FROM auth_credentials WHERE provider = ? ORDER BY id DESC")
			.get(provider) as { id: number; data: string; secret: string | null };
	} finally {
		db.close();
	}
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

describe("MCP OAuth credential encryption", () => {
	it("stores MCP OAuth tokens encrypted and reads them back after reopen", async () => {
		const dbPath = await tempDb();
		const store = await openStore(dbPath);
		store.saveOAuth(MCP, creds("access-secret"));

		const row = rawRow(dbPath, MCP);
		expect(row.data).not.toContain("access-secret");
		expect(row.data).not.toContain("refresh-token");
		expect(row.data.startsWith("enc:v1:")).toBe(true);
		expect(row.secret).not.toBeNull();
		expect(row.secret).not.toContain("access-secret");
		expect(store.getOAuth(MCP)?.access).toBe("access-secret");

		store.close();
		stores.splice(stores.indexOf(store), 1);
		const reopened = await openStore(dbPath);
		expect(reopened.getOAuth(MCP)?.access).toBe("access-secret");
	});

	it("leaves non-MCP providers on the plaintext path", async () => {
		const dbPath = await tempDb();
		const store = await openStore(dbPath);
		store.saveOAuth(OTHER, creds("other-secret"));

		const row = rawRow(dbPath, OTHER);
		expect(row.data).toContain("other-secret");
		expect(row.secret).toBeNull();
	});

	it("keeps compare-and-swap refresh semantics with the plaintext expectation", async () => {
		const dbPath = await tempDb();
		const store = await openStore(dbPath);
		const original = creds("old-access");
		store.saveOAuth(MCP, original);

		const row = rawRow(dbPath, MCP);
		const expected = serializeCredential(MCP, { type: "oauth", ...original });
		expect(expected).not.toBeNull();
		expect(
			store.tryUpdateAuthCredentialIfMatches(row.id, expected!.data, { type: "oauth", ...creds("new-access") }),
		).toBe(true);
		expect(store.getOAuth(MCP)?.access).toBe("new-access");

		// A stale expectation must not overwrite the rotated token.
		expect(
			store.tryUpdateAuthCredentialIfMatches(row.id, expected!.data, { type: "oauth", ...creds("stale-access") }),
		).toBe(false);
		expect(store.getOAuth(MCP)?.access).toBe("new-access");
	});

	it("migrates a legacy plaintext MCP OAuth row on open", async () => {
		const dbPath = await tempDb();
		const legacy = new Database(dbPath);
		try {
			legacy.run(`
				CREATE TABLE auth_credentials (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					provider TEXT NOT NULL,
					credential_type TEXT NOT NULL,
					data TEXT NOT NULL,
					disabled_cause TEXT DEFAULT NULL,
					identity_key TEXT DEFAULT NULL,
					created_at INTEGER,
					updated_at INTEGER
				)
			`);
			legacy.run(
				"INSERT INTO auth_credentials (provider, credential_type, data, identity_key, created_at, updated_at) VALUES (?, 'oauth', ?, NULL, 1, 1)",
				[MCP, JSON.stringify(creds("legacy-access"))],
			);
		} finally {
			legacy.close();
		}

		const store = await openStore(dbPath);
		expect(store.getOAuth(MCP)?.access).toBe("legacy-access");
		const row = rawRow(dbPath, MCP);
		expect(row.data).not.toContain("legacy-access");
		expect(row.secret).not.toBeNull();
	});

	it("fails closed when the key changes and keeps the ciphertext", async () => {
		const dbPath = await tempDb();
		const store = await openStore(dbPath);
		store.saveOAuth(MCP, creds("access-secret"));
		store.close();
		stores.splice(stores.indexOf(store), 1);

		await fs.writeFile(path.join(path.dirname(dbPath), "mcp-oauth.key"), Buffer.alloc(32, 9), { mode: 0o600 });
		const reopened = await openStore(dbPath);
		expect(reopened.getOAuth(MCP)).toBeNull();
		expect(rawRow(dbPath, MCP).secret).not.toBeNull();
	});
});
