import { afterEach, describe, expect, it } from "bun:test";
import {
	type ApiKeyCredential,
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { CredentialRankingStrategy, UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

function makeStore(rows: StoredAuthCredential[], blocked = new Map<number, number>()): AuthCredentialStore {
	const cache = new Map<string, CacheEntry>();
	return {
		close() {},
		listAuthCredentials: provider => rows.filter(row => provider === undefined || row.provider === provider),
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches: () => false,
		replaceAuthCredentialsForProvider: () => rows,
		upsertAuthCredentialForProvider: () => rows,
		deleteAuthCredentialsForProvider() {},
		getCredentialBlock: credentialId => blocked.get(credentialId),
		getCache(key) {
			const entry = cache.get(key);
			return entry && entry.expiresAtSec * 1000 > Date.now() ? entry.value : null;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

function oauthRow(id: number): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `access-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `account-${id}`,
	};
	return { id, provider: "anthropic", credential, disabledCause: null };
}

function apiKeyRow(id: number, source?: ApiKeyCredential["source"]): StoredAuthCredential {
	return {
		id,
		provider: "anthropic",
		credential: { type: "api_key", key: `key-${id}`, source },
		disabledCause: null,
	};
}

function limit(id: string, usedFraction: number, modelId?: string): UsageLimit {
	return {
		id,
		label: id,
		scope: { provider: "anthropic", modelId },
		window: { id, label: id, resetsAt: Date.now() + 60_000 },
		amount: { usedFraction, unit: "percent" },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function report(accountId: string, limits: UsageLimit[]): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits,
		metadata: { accountId },
	};
}

const strategy: CredentialRankingStrategy = {
	findWindowLimits: usage => ({ primary: usage.limits[0], secondary: usage.limits[1] }),
	scopeLimits: (usage, context) =>
		usage.limits.filter(entry => entry.scope.modelId === undefined || entry.scope.modelId === context?.modelId),
	blockScope: context => (context?.modelId ? `model:${context.modelId}` : undefined),
	blockScopes: context => [context?.modelId ? `model:${context.modelId}` : "model", "shared"],
	windowDefaults: { primaryMs: 60_000, secondaryMs: 60_000 },
};

function makeUsageProvider(reports: Record<string, UsageReport | null>): UsageProvider {
	return {
		id: "anthropic",
		fetchUsage: async params => {
			const account = params.credential.accountId ?? params.credential.apiKey;
			return account ? (reports[account] ?? null) : null;
		},
	};
}

describe("AuthStorage model usage health", () => {
	const storages: AuthStorage[] = [];
	afterEach(() => {
		for (const storage of storages) storage.close();
		storages.length = 0;
	});

	async function createStorage(
		rows: StoredAuthCredential[],
		reports: Record<string, UsageReport | null>,
		blocked?: Map<number, number>,
	): Promise<AuthStorage> {
		const storage = new AuthStorage(makeStore(rows, blocked), {
			usageProviderResolver: provider => (provider === "anthropic" ? makeUsageProvider(reports) : undefined),
			rankingStrategyResolver: provider => (provider === "anthropic" ? strategy : undefined),
			configValueResolver: async value => value,
		});
		await storage.reload();
		storages.push(storage);
		return storage;
	}

	it("honours every request scope when checking persisted health blocks", async () => {
		const rows = [oauthRow(1)];
		const store = makeStore(rows);
		store.getCredentialBlock = (credentialId, _providerKey, blockScope) =>
			credentialId === 1 && blockScope === "shared" ? Date.now() + 60_000 : undefined;
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider =>
				provider === "anthropic"
					? makeUsageProvider({ "account-1": report("account-1", [limit("short", 0.2)]) })
					: undefined,
			rankingStrategyResolver: provider => (provider === "anthropic" ? strategy : undefined),
			configValueResolver: async value => value,
		});
		await storage.reload();
		storages.push(storage);

		const health = await storage.getModelUsageHealth("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("depleted");
		expect(health.accounts[0]?.state).toBe("depleted");
	});

	it("keeps the model healthy while any OAuth sibling has headroom", async () => {
		const storage = await createStorage([oauthRow(1), oauthRow(2)], {
			"account-1": report("account-1", [limit("short", 1)]),
			"account-2": report("account-2", [limit("short", 0.4)]),
		});
		const health = await storage.getModelUsageHealth("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("healthy");
		expect(health.accounts.map(account => account.state)).toEqual(["depleted", "healthy"]);
	});

	it("does not declare depletion while any pooled sibling is unknown", async () => {
		const storage = await createStorage([oauthRow(1), oauthRow(2)], {
			"account-1": report("account-1", [limit("short", 1)]),
			"account-2": null,
		});
		const health = await storage.getModelUsageHealth("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("unknown");
		expect(health.accounts.map(account => account.state)).toEqual(["depleted", "unknown"]);
	});

	it("reports reserve only after every sibling is reserve or depleted", async () => {
		const storage = await createStorage([oauthRow(1), oauthRow(2)], {
			"account-1": report("account-1", [limit("short", 0.95)]),
			"account-2": report("account-2", [limit("short", 1)]),
		});
		const health = await storage.getModelUsageHealth("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("reserve");
	});

	it.each([
		["5-hour", 0.95, 0.2],
		["7-day", 0.2, 0.95],
	])("uses the most consumed active window when the %s limit reaches reserve", async (_window, short, long) => {
		const storage = await createStorage([oauthRow(1)], {
			"account-1": report("account-1", [limit("5-hour", short), limit("7-day", long)]),
		});

		const health = await storage.getModelUsageHealth("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});

		expect(health.state).toBe("reserve");
		expect(health.accounts[0]?.remainingFraction).toBeCloseTo(0.05);
	});

	it("expires short and long usage windows independently", async () => {
		const now = Date.now();
		const usageReport = report("account-1", [limit("5-hour", 1), limit("7-day", 0.95)]);
		usageReport.fetchedAt = now - 120_000;
		usageReport.limits[0].window = {
			id: "5-hour",
			label: "5-hour",
			resetsAt: now - 60_000,
		};
		usageReport.limits[1].window = {
			id: "7-day",
			label: "7-day",
			resetsAt: now + 60_000,
		};
		const storage = await createStorage([oauthRow(1)], { "account-1": usageReport });

		const health = await storage.getModelUsageHealth("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});

		expect(health.state).toBe("reserve");
		expect(health.accounts[0]?.remainingFraction).toBeCloseTo(0.05);
	});

	it("ignores reserve samples after their usage window has reset", async () => {
		const now = Date.now();
		const staleReport = report("account-1", [limit("short", 0.95)]);
		staleReport.fetchedAt = now - 120_000;
		staleReport.limits[0].window = { id: "short", label: "short", resetsAt: now - 60_000 };
		const storage = await createStorage([oauthRow(1)], { "account-1": staleReport });

		const health = await storage.getModelUsageHealth("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});

		expect(health.state).toBe("unknown");
		expect(health.accounts[0]?.state).toBe("unknown");
	});

	it("uses provider model scoping before aggregating account health", async () => {
		const usageReport = report("account-1", [limit("claude", 1, "claude"), limit("haiku", 0.2, "haiku")]);
		const storage = await createStorage([oauthRow(1)], {
			"account-1": usageReport,
		});
		const health = await storage.getModelUsageHealth("anthropic", {
			modelId: "haiku",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("healthy");
		expect(health.accounts[0]?.remainingFraction).toBeCloseTo(0.8);
		expect(storage.getUsageReportingModelIds("anthropic", ["claude", "haiku", "unmapped"], [usageReport])).toEqual([
			"claude",
			"haiku",
		]);
	});

	it("lists account-wide usage models even without a provider ranking strategy", async () => {
		const storage = new AuthStorage(makeStore([]), {
			rankingStrategyResolver: () => undefined,
		});
		storages.push(storage);
		const sharedReport: UsageReport = {
			provider: "cursor",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "monthly",
					label: "Monthly",
					scope: { provider: "cursor", shared: true },
					amount: { usedFraction: 0.4, unit: "percent" },
				},
			],
		};
		expect(storage.getUsageReportingModelIds("cursor", ["composer-1", "composer-2"], [sharedReport])).toEqual([
			"composer-1",
			"composer-2",
		]);
	});

	it("honors persisted scoped blocks without probing blocked accounts", async () => {
		const resetAt = Date.now() + 60_000;
		const storage = await createStorage(
			[oauthRow(1), oauthRow(2)],
			{ "account-1": report("account-1", [limit("short", 0.1)]), "account-2": null },
			new Map([[1, resetAt]]),
		);
		const health = await storage.getModelUsageHealth("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(health.accounts[0]).toMatchObject({ state: "depleted", resetsAt: resetAt });
		expect(health.state).toBe("unknown");
	});

	it("inspects only login API keys when that higher-precedence pool exists", async () => {
		const storage = await createStorage([apiKeyRow(1, "login"), apiKeyRow(2)], {
			"key-1": report("key-1", [limit("short", 1)]),
			"key-2": report("key-2", [limit("short", 0.1)]),
		});
		const health = await storage.getModelUsageHealth("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("depleted");
		expect(health.accounts.map(account => account.credentialId)).toEqual([1]);
	});

	it("ignores ordinary configured API keys even when a usage endpoint exists", async () => {
		const storage = await createStorage([apiKeyRow(1)], {
			"key-1": report("key-1", [limit("short", 1)]),
		});
		const health = await storage.getModelUsageHealth("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(health).toEqual({ state: "unknown", accounts: [] });
	});

	it("releases a reserve account so native ranking selects a healthy sibling", async () => {
		const store = makeStore([apiKeyRow(1, "login"), apiKeyRow(2, "login")]);
		store.setCache(
			"session:sticky:anthropic:session-1",
			JSON.stringify({ type: "api_key", index: 0, credentialId: 1, lastUsedAtMs: Date.now() }),
			Math.floor(Date.now() / 1000) + 3600,
		);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider =>
				provider === "anthropic"
					? makeUsageProvider({
							"key-1": report("key-1", [limit("short", 0.95)]),
							"key-2": report("key-2", [limit("short", 0.2)]),
						})
					: undefined,
			rankingStrategyResolver: provider => (provider === "anthropic" ? strategy : undefined),
			configValueResolver: async value => value,
		});
		await storage.reload();
		storages.push(storage);
		const health = await storage.getModelUsageHealth("anthropic", {
			modelId: "claude",
			sessionId: "session-1",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe("healthy");
		expect(health.accounts.find(account => account.selected)).toMatchObject({
			credentialId: 1,
			state: "reserve",
		});
		expect(storage.releaseSessionCredentialForReselection("anthropic", "session-1")).toBe(true);
		expect(await storage.getApiKey("anthropic", "session-1", { modelId: "claude" })).toBe("key-2");
	});

	it("does not consume the native API-key round-robin cursor", async () => {
		const storage = await createStorage([apiKeyRow(1, "login"), apiKeyRow(2, "login")], {
			"key-1": report("key-1", [limit("short", 0.2)]),
			"key-2": report("key-2", [limit("short", 0.2)]),
		});
		await storage.getModelUsageHealth("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(await storage.getApiKey("anthropic", undefined, { modelId: "claude" })).toBe("key-1");
	});

	it("returns unknown for static overrides that bypass the native pool", async () => {
		const storage = await createStorage([oauthRow(1)], {
			"account-1": report("account-1", [limit("short", 1)]),
		});
		storage.setRuntimeApiKey("anthropic", "override-key");
		const health = await storage.getModelUsageHealth("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
		});
		expect(health).toEqual({ state: "unknown", accounts: [] });
	});

	it("cancels the caller without cancelling the shared local usage fetch", async () => {
		const pending = Promise.withResolvers<UsageReport | null>();
		const storage = new AuthStorage(makeStore([apiKeyRow(1, "login")]), {
			usageProviderResolver: provider =>
				provider === "anthropic" ? { id: "anthropic", fetchUsage: () => pending.promise } : undefined,
			rankingStrategyResolver: provider => (provider === "anthropic" ? strategy : undefined),
			configValueResolver: async value => value,
		});
		await storage.reload();
		storages.push(storage);
		const controller = new AbortController();
		const health = storage.getModelUsageHealth("anthropic", {
			modelId: "claude",
			reserveFraction: 0.1,
			signal: controller.signal,
		});
		await Promise.resolve();
		controller.abort();
		await expect(health).rejects.toThrow("usage fetch aborted");
		pending.resolve(report("key-1", [limit("short", 0.2)]));
	});
});
