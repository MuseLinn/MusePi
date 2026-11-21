import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@musepi/pi-ai/auth-storage";
import { getEnvApiKey } from "@musepi/pi-ai/stream";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

// Neutralize every provider env leg under test so ambient shell / ~/.env state
// cannot supply the value a precedence assertion is meant to attribute.
const SUPPRESS_ENV = {
	OPENAI_API_KEY: undefined,
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_OAUTH_TOKEN: undefined,
} as const;

const ENV_AT_OPENAI = { ...SUPPRESS_ENV, OPENAI_API_KEY: "sk-env" } as const;

describe("AuthStorage stored-credential precedence", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let auth: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-stored-precedence-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		auth = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		auth = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("a stored api key outranks a same-named env var on every read path", async () => {
		if (!auth) throw new Error("test setup failed");
		const storage = auth;
		await withEnv(ENV_AT_OPENAI, async () => {
			await storage.set("openai", [{ type: "api_key", key: "sk-stored" }]);

			expect(await storage.getApiKey("openai")).toBe("sk-stored");
			expect(await storage.peekApiKey("openai")).toBe("sk-stored");
			expect(storage.getCredentialOrigin("openai")).toEqual({ kind: "api_key" });
			expect(storage.describeCredentialSource("openai")).toContain("api_key");
			expect(storage.describeCredentialSource("openai")).not.toContain("env");
		});
	});

	test("an imported key outranks a same-named env var and survives a reload", async () => {
		if (!auth || !store) throw new Error("test setup failed");
		const storage = auth;
		const credentialStore = store;
		await withEnv(ENV_AT_OPENAI, async () => {
			await storage.importApiKey("openai", "sk-imported");

			expect(await storage.getApiKey("openai")).toBe("sk-imported");
			expect(storage.getCredentialOrigin("openai")).toEqual({ kind: "api_key" });

			// Imported rows carry no `source`; a fresh instance reads the same row
			// from disk and must still prefer it over the environment.
			const reloaded = new AuthStorage(credentialStore);
			await reloaded.reload();
			expect(await reloaded.getApiKey("openai")).toBe("sk-imported");
			expect(reloaded.getCredentialOrigin("openai")).toEqual({ kind: "api_key" });
		});
	});

	test("a legacy row without a source is read and outranks the env var", async () => {
		if (!auth || !store) throw new Error("test setup failed");
		const credentialStore = store;

		// `saveApiKey` is the pre-source writer shape: the row persists as
		// `{ type: "api_key", key }` with no provenance field.
		credentialStore.saveApiKey("openai", "sk-legacy");
		expect(credentialStore.listAuthCredentials("openai").map(row => row.credential)).toEqual([
			{ type: "api_key", key: "sk-legacy" },
		]);

		const reloaded = new AuthStorage(credentialStore);
		await reloaded.reload();
		await withEnv(ENV_AT_OPENAI, async () => {
			expect(await reloaded.getApiKey("openai")).toBe("sk-legacy");
			expect(reloaded.getCredentialOrigin("openai")).toEqual({ kind: "api_key" });
		});
	});

	test("stored OAuth outranks a co-stored api key and the env var", async () => {
		if (!auth) throw new Error("test setup failed");
		const storage = auth;
		await withEnv(ENV_AT_OPENAI, async () => {
			await storage.set("openai", [
				{ type: "api_key", key: "sk-stored" },
				{ type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 10 * 60_000 },
			]);

			expect(await storage.getApiKey("openai")).toBe("oauth-access");
			expect(storage.getCredentialOrigin("openai")).toEqual({ kind: "oauth" });
		});
	});

	test("login and imported stored keys both outrank the env var", async () => {
		if (!auth) throw new Error("test setup failed");
		const storage = auth;
		await withEnv(ENV_AT_OPENAI, async () => {
			await storage.set("openai", [
				{ type: "api_key", key: "sk-login", source: "login" },
				{ type: "api_key", key: "sk-imported" },
			]);

			// Login-sourced keys keep their existing preference inside the store.
			expect(await storage.getApiKey("openai")).toBe("sk-login");
			expect(storage.getCredentialOrigin("openai")).toEqual({ kind: "api_key" });
		});
	});

	test("runtime and config overrides still beat stored keys and the env var", async () => {
		if (!auth) throw new Error("test setup failed");
		const storage = auth;
		await withEnv(ENV_AT_OPENAI, async () => {
			await storage.set("openai", [{ type: "api_key", key: "sk-stored" }]);

			storage.setConfigApiKey("openai", "gateway-bearer");
			expect(await storage.getApiKey("openai")).toBe("gateway-bearer");
			expect(await storage.peekApiKey("openai")).toBe("gateway-bearer");

			storage.setRuntimeApiKey("openai", "cli-bearer");
			expect(await storage.getApiKey("openai")).toBe("cli-bearer");
			expect(await storage.peekApiKey("openai")).toBe("cli-bearer");
		});
	});

	test("environment applies only while storage holds no key for the provider", async () => {
		if (!auth) throw new Error("test setup failed");
		const storage = auth;
		await withEnv(ENV_AT_OPENAI, async () => {
			expect(getEnvApiKey("openai")).toBe("sk-env");
			expect(await storage.getApiKey("openai")).toBe("sk-env");
			expect(storage.getCredentialOrigin("openai")).toEqual({ kind: "env", envVar: "OPENAI_API_KEY" });
		});
	});
});
