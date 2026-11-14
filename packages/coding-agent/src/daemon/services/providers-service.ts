/**
 * ProvidersService — the provider login/credential surface as an L2 daemon
 * service.
 *
 * Seam:
 * - Input: `providers.*` routes, the shared model registry (`ensureRegistry`),
 *   and the connection events a login pushes (auth URL, prompt, progress).
 * - Output: the provider catalog with credential state, multi-account
 *   credential rows, and login/import/logout acks. Codes typed into the GUI
 *   arrive through `providers.loginInput` and settle the pending login.
 * - Lifecycle: stateless. The pending-login resolvers live for the duration of
 *   one `providers.login` call and are dropped in its `finally`.
 */

import { getOAuthProviders } from "@musepi/pi-ai/oauth";
import { PROVIDER_REGISTRY } from "@musepi/pi-ai/registry";
import {
	validateAnthropicCompatibleApiKey,
	validateOpenAICompatibleApiKey,
} from "@musepi/pi-ai/registry/api-key-validation";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@musepi/pi-catalog/models";
import type { StoredAuthCredential } from "../../session/auth-storage";
import { openPath } from "../../utils/open";
import type { DaemonConnection, DaemonSessionHost } from "../session-host";
import type { DaemonService } from "./types";

/** Non-empty trimmed string, else undefined (credential label helper). */
function nonEmptyLabel(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Display label for one stored credential (TUI /logout parity): email or
 * account id for OAuth rows, with the org appended when it differs so two
 * subscriptions on one email stay distinguishable; API-key rows fall back
 * to "API key #id".
 */
function storedCredentialLabel(row: StoredAuthCredential): string {
	const credential = row.credential;
	if (credential.type !== "oauth") return `API key #${row.id}`;
	const base =
		nonEmptyLabel(credential.email) ??
		nonEmptyLabel(credential.accountId) ??
		nonEmptyLabel(credential.projectId) ??
		nonEmptyLabel(credential.enterpriseUrl) ??
		`OAuth credential #${row.id}`;
	const org = nonEmptyLabel(credential.orgName) ?? nonEmptyLabel(credential.orgId);
	return org && org !== base ? `${base} (${org})` : base;
}

/** Login state the GUI's provider-auth prompt settles. */
interface PendingLogin {
	resolve(value: string): void;
	reject(error: Error): void;
	abort: AbortController;
}

export class ProvidersService implements DaemonService {
	readonly key = "providers";
	readonly routes = {
		"providers.list": "list",
		"providers.credentials": "credentials",
		"providers.setCredentialNote": "setCredentialNote",
		"providers.login": "login",
		"providers.loginInput": "loginInput",
		"providers.loginCancel": "loginCancel",
		"providers.importApiKey": "importApiKey",
		"providers.testConnection": "testConnection",
		"providers.logout": "logout",
	} as const;

	/** providerId → the login waiting on a code/URL the GUI collects. */
	readonly #promptResolvers = new Map<string, PendingLogin>();

	constructor(
		private readonly host: Pick<DaemonSessionHost, "ensureRegistry" | "emitEvent"> & {
			nextEventSeq(): number;
			broadcastModelsChanged(): void;
		},
	) {}

	async list(params: unknown): Promise<unknown> {
		// Provider catalog + credential state (login/logout parity
		// with the TUI `/login` provider selector). Two lists:
		//   oauth — providers with an interactive login flow
		//           (subscription accounts: Codex, Antigravity, …);
		//   api   — providers with bundled catalog models, configured
		//           via API-key import (the /setup path). The catalog
		//           is the static models.json, so the list is stable
		//           regardless of which providers are authenticated.
		// Works without a live session — the shared registry backs
		// the auth storage.
		const registry = await this.host.ensureRegistry();
		if (!registry) throw new Error("No model registry yet — create a session first");
		const storage = registry.authStorage;
		const oauth = getOAuthProviders().map(info => {
			const id = info.storeCredentialsAs ?? info.id;
			return {
				id: info.id,
				name: info.name,
				available: info.available,
				storeCredentialsAs: info.storeCredentialsAs,
				loginKind: info.loginKind,
				// An extension-registered provider with an OAuth flow keeps
				// its accounts in its own pool, so AuthStorage is empty while
				// the provider works. Counting only AuthStorage marked those
				// "not logged in" next to a model picker that was using them.
				loggedIn: storage.has(id) || registry.hasRuntimeCredentials(info.id) || registry.hasRuntimeCredentials(id),
			};
		});
		// Registry order (curated display order), only providers that
		// actually ship catalog models.
		const registryOrder: Record<string, number> = {};
		for (const [index, def] of PROVIDER_REGISTRY.entries()) registryOrder[def.id] = index;
		const api = getBundledProviders()
			.filter(id => registryOrder[id] !== undefined)
			.map(id => {
				const models = getBundledModels(id as GeneratedProvider);
				return {
					id,
					name: PROVIDER_REGISTRY[registryOrder[id]!]!.name,
					modelCount: models.length,
					models: models.slice(0, 5).map(model => model.id),
					configured: storage.has(id) || registry.hasRuntimeCredentials(id),
				};
			})
			.sort((a, b) => registryOrder[a.id]! - registryOrder[b.id]!);
		return { oauth, api };
	}
	async credentials(params: unknown): Promise<unknown> {
		// Per-credential list for one provider (multi-account logout
		// parity with the TUI /logout account rows). Storage may key
		// credentials under a different id (storeCredentialsAs).
		const p = (params ?? {}) as { providerId: string };
		const registry = await this.host.ensureRegistry();
		if (!registry) throw new Error("No model registry yet — create a session first");
		if (!p.providerId) throw new Error("providerId required");
		const provider = getOAuthProviders().find(info => info.id === p.providerId);
		const storageKey = provider?.storeCredentialsAs ?? p.providerId;
		return registry.authStorage.listStoredCredentials(storageKey).map(row => ({
			id: row.id,
			accountLabel: storedCredentialLabel(row),
			note: row.credential.note ?? null,
		}));
	}
	async setCredentialNote(params: unknown): Promise<unknown> {
		// User note on one credential (multi-account labeling — e.g.
		// "公司主 key" vs "测试 key").
		const p = (params ?? {}) as { providerId: string; credentialId: number; note: string };
		const registry = await this.host.ensureRegistry();
		if (!registry) throw new Error("No model registry yet — create a session first");
		if (!p.providerId) throw new Error("providerId required");
		const provider = getOAuthProviders().find(info => info.id === p.providerId);
		const storageKey = provider?.storeCredentialsAs ?? p.providerId;
		const ok = await registry.authStorage.setCredentialNote(storageKey, p.credentialId, p.note ?? "");
		if (!ok) throw new Error(`Unknown credential: ${p.credentialId}`);
		return { ok: true };
	}
	async login(params: unknown, conn: DaemonConnection): Promise<unknown> {
		// Run the provider's real OAuth flow (auth-storage owns the
		// login + credential persistence, same as the TUI). The auth URL
		// is pushed to the client as a `provider-auth` event and opened in
		// the default browser; onPrompt providers wait for a
		// `providers.loginInput` RPC with the pasted code/URL.
		const p = (params ?? {}) as { providerId: string };
		const registry = await this.host.ensureRegistry();
		if (!registry) throw new Error("No model registry yet — create a session first");
		if (!p.providerId) throw new Error("providerId required");
		const storage = registry.authStorage;
		const abort = new AbortController();
		const pending = { resolve: () => {}, reject: () => {}, abort };
		this.#promptResolvers.set(p.providerId, pending);
		try {
			const identity = await storage.login(p.providerId, {
				signal: abort.signal,
				onAuth: info => {
					try {
						this.host.emitEvent(conn, {
							kind: "provider-auth",
							seq: this.host.nextEventSeq(),
							payload: {
								providerId: p.providerId,
								url: info.url,
								launchUrl: info.launchUrl,
								instructions: info.instructions,
							},
						});
					} catch {
						// socket died
					}
					// Best-effort browser launch (same as the TUI login dialog).
					openPath(info.launchUrl ?? info.url);
				},
				onPrompt: async prompt =>
					new Promise<string>((resolve, reject) => {
						this.#promptResolvers.set(p.providerId, {
							resolve: value => {
								this.#promptResolvers.delete(p.providerId);
								resolve(value);
							},
							reject: error => {
								this.#promptResolvers.delete(p.providerId);
								reject(error);
							},
							abort,
						});
						this.host.emitEvent(conn, {
							kind: "provider-prompt",
							seq: this.host.nextEventSeq(),
							payload: {
								providerId: p.providerId,
								message: prompt.message,
								placeholder: prompt.placeholder,
							},
						});
					}),
				onProgress: message => {
					try {
						this.host.emitEvent(conn, {
							kind: "provider-progress",
							seq: this.host.nextEventSeq(),
							payload: { providerId: p.providerId, message },
						});
					} catch {
						// socket died
					}
				},
			});
			await registry.refreshProvider(p.providerId, "online");
			this.host.broadcastModelsChanged();
			return { ok: true, identity: identity ?? null };
		} finally {
			this.#promptResolvers.delete(p.providerId);
		}
	}
	async loginInput(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as { providerId: string; value: string };
		const pending = this.#promptResolvers.get(p.providerId);
		if (!pending) throw new Error(`No pending login for provider: ${p.providerId}`);
		pending.resolve(p.value ?? "");
		return { ok: true };
	}
	async loginCancel(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as { providerId: string };
		const pending = this.#promptResolvers.get(p.providerId);
		if (pending) pending.abort.abort();
		return { ok: true };
	}
	async importApiKey(params: unknown): Promise<unknown> {
		// /setup parity: import a stored API-key credential for a
		// provider without running OAuth (e.g. OpenRouter, GLM keys).
		const p = (params ?? {}) as { providerId: string; apiKey: string };
		const registry = await this.host.ensureRegistry();
		if (!registry) throw new Error("No model registry yet — create a session first");
		if (!p.providerId) throw new Error("providerId required");
		if (!p.apiKey?.trim()) throw new Error("api key required");
		const storage = registry.authStorage;
		await storage.importApiKey(p.providerId, p.apiKey.trim());
		await registry.refreshProvider(p.providerId, "online");
		this.host.broadcastModelsChanged();
		return { ok: true };
	}
	async testConnection(params: unknown): Promise<unknown> {
		// One-shot connectivity check against a user-supplied endpoint
		// (onboarding "test connection" button): validates the key and
		// the base URL with a minimal chat request, persisting nothing.
		// OpenAI-compatible and Anthropic-compatible APIs are covered;
		// other api kinds fall back to the OpenAI shape.
		const p = (params ?? {}) as {
			baseUrl: string;
			apiKey?: string;
			api?: string;
			modelId: string;
		};
		if (!p.baseUrl?.trim()) throw new Error("baseUrl required");
		if (!p.modelId?.trim()) throw new Error("modelId required");
		if (!p.apiKey?.trim()) throw new Error("api key required to test the connection");
		const api = p.api ?? "openai-completions";
		const baseUrl = p.baseUrl.trim();
		const apiKey = p.apiKey.trim();
		const model = p.modelId.trim();
		if (api === "anthropic-messages") {
			await validateAnthropicCompatibleApiKey({
				provider: "connection-test",
				baseUrl,
				apiKey,
				model,
			});
		} else {
			await validateOpenAICompatibleApiKey({
				provider: "connection-test",
				baseUrl,
				apiKey,
				model,
			});
		}
		return { ok: true };
	}
	async logout(params: unknown): Promise<unknown> {
		// Remove every stored credential for the provider, or exactly
		// one when credentialId is given (multi-account logout parity
		// with the TUI /logout rows). Storage may key credentials under
		// a different id (storeCredentialsAs), then refresh so
		// credential-gated models leave the catalog.
		const p = (params ?? {}) as { providerId: string; credentialId?: number };
		const registry = await this.host.ensureRegistry();
		if (!registry) throw new Error("No model registry yet — create a session first");
		if (!p.providerId) throw new Error("providerId required");
		const provider = getOAuthProviders().find(info => info.id === p.providerId);
		const storageKey = provider?.storeCredentialsAs ?? p.providerId;
		const storage = registry.authStorage;
		const credentials = storage.listStoredCredentials(storageKey);
		if (p.credentialId !== undefined) {
			if (!credentials.some(credential => credential.id === p.credentialId)) {
				throw new Error(`Unknown credential: ${p.credentialId}`);
			}
			await storage.removeCredential(storageKey, p.credentialId);
		} else {
			for (const credential of credentials) {
				await storage.removeCredential(storageKey, credential.id);
			}
		}
		await registry.refreshProvider(p.providerId, "online");
		this.host.broadcastModelsChanged();
		return { ok: true, removed: p.credentialId !== undefined ? 1 : credentials.length };
	}
}
