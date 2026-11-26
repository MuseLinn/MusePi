import { t } from "@musepi/client-core";
import { useCallback, useEffect, useState } from "react";
import { reportRequestFailure } from "./report-request-failure";
import type { RpcClient, StreamEvent } from "./rpc";
import { PROVIDER_LOGIN_TIMEOUT_MS } from "./rpc";
import { cancelProviderLogin, logoutProvider, submitProviderLoginInput } from "./rpc-commands";

/** One OAuth/CLI provider row (daemon `providers.list` → `oauth`). */
export interface ProviderInfo {
	id: string;
	name: string;
	available: boolean;
	storeCredentialsAs?: string;
	loginKind?: "oauth" | "api-key";
	loggedIn: boolean;
}

/** One API-key provider row (daemon `providers.list` → `api`). */
export interface ApiProviderInfo {
	id: string;
	name: string;
	modelCount: number;
	models: string[];
	configured: boolean;
}

export interface CustomProvider {
	name: string;
	models: { id: string; name?: string }[];
}

/** Inline login panel state for whichever provider flow is on screen. */
export interface ProviderLoginState {
	providerId: string;
	url?: string;
	launchUrl?: string;
	instructions?: string;
	message?: string;
	waitingInput?: boolean;
}

export interface ProviderCatalog {
	providers: ProviderInfo[] | null;
	apiProviders: ApiProviderInfo[];
	custom: CustomProvider[];
	loginState: ProviderLoginState | null;
	pendingLogins: string[];
	login(providerId: string): Promise<void>;
	logout(providerId: string): Promise<void>;
	submitLoginInput(value: string): Promise<void>;
	cancelLogin(): Promise<void>;
	reload(): Promise<void>;
}

/**
 * The provider catalog and its login flows — one implementation shared by every
 * surface that lists providers (the model settings page and the media page's
 * sign-in rows). Reading `providers.list` and `models.listCustom` separately is
 * deliberate: a failed custom-model read must not wipe the providers that just
 * loaded.
 */
export function useProviderCatalog({
	rpc,
	sessionId,
	providerEvent,
}: {
	rpc: RpcClient | null;
	sessionId: string | null;
	/** Daemon auth/prompt/progress envelopes for the inline login panel. */
	providerEvent: StreamEvent | null;
}): ProviderCatalog {
	const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
	const [apiProviders, setApiProviders] = useState<ApiProviderInfo[]>([]);
	const [custom, setCustom] = useState<CustomProvider[]>([]);
	const [loginState, setLoginState] = useState<ProviderLoginState | null>(null);
	// Per-provider so a pending login only disables THAT provider's buttons.
	const [pendingLogins, setPendingLogins] = useState<string[]>([]);

	const loadProviders = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		try {
			const raw = (await rpc.request<unknown>("providers.list", {
				sessionId: sessionId ?? undefined,
			})) as { oauth?: unknown; api?: unknown } | ProviderInfo[] | null;
			// Pre-{oauth,api} daemons return the bare OAuth array — degrade to the
			// auth section only instead of crashing the page.
			if (Array.isArray(raw)) {
				setProviders(raw as ProviderInfo[]);
				setApiProviders([]);
			} else {
				setProviders(Array.isArray(raw?.oauth) ? (raw.oauth as ProviderInfo[]) : []);
				setApiProviders(Array.isArray(raw?.api) ? (raw.api as ApiProviderInfo[]) : []);
			}
		} catch (err) {
			// An empty list is the honest fallback for "the read failed", but
			// without this trace it is indistinguishable from "nothing is
			// configured" — the login/logout entry points then look deleted.
			console.error("[gui] providers.list failed", err);
			setProviders([]);
		}
		try {
			const cfg = await rpc.request<{
				providers?: Record<
					string,
					{
						label?: string;
						baseUrl?: string;
						models?: {
							id: string;
							name?: string;
							api?: string;
							supportsTools?: boolean;
							input?: string[];
							contextWindow?: number;
							maxTokens?: number;
						}[];
					}
				>;
			}>("models.listCustom", { sessionId: sessionId ?? undefined });
			setCustom(
				Object.entries(cfg?.providers ?? {}).map(([name, v]) => ({
					name,
					...(v?.label ? { label: v.label } : {}),
					...(v?.baseUrl ? { baseUrl: v.baseUrl } : {}),
					models: Array.isArray(v?.models) ? v.models : [],
				})),
			);
		} catch (err) {
			console.warn("[gui] models.listCustom failed", err);
		}
	}, [rpc, sessionId]);

	useEffect(() => {
		void loadProviders();
	}, [loadProviders]);

	useEffect(() => {
		if (!providerEvent) return;
		const p = providerEvent.payload as {
			providerId?: string;
			url?: string;
			launchUrl?: string;
			instructions?: string;
			message?: string;
			placeholder?: string;
		};
		if (providerEvent.kind === "provider-auth") {
			setLoginState({
				providerId: p.providerId ?? "",
				url: p.url,
				...(p.launchUrl ? { launchUrl: p.launchUrl } : {}),
				...(p.instructions ? { instructions: p.instructions } : {}),
				...(p.message ? { message: p.message } : {}),
			});
		} else if (providerEvent.kind === "provider-prompt") {
			setLoginState(s => ({
				providerId: p.providerId ?? s?.providerId ?? "",
				...(s?.url ? { url: s.url } : {}),
				...(s?.message ? { message: s.message } : {}),
				waitingInput: true,
			}));
		} else if (providerEvent.kind === "provider-progress") {
			setLoginState(s => ({
				providerId: s?.providerId ?? "",
				...(s?.url ? { url: s.url } : {}),
				...(p.message ? { message: p.message } : {}),
				...(s?.waitingInput ? { waitingInput: true } : {}),
			}));
		}
	}, [providerEvent]);

	const login = async (providerId: string): Promise<void> => {
		// `providers.login` only needs providerId — a session is NOT required.
		// The old `!sessionId` guard silently swallowed clicks from the settings
		// page opened without an active session.
		if (!rpc) return;
		setPendingLogins(p => (p.includes(providerId) ? p : [...p, providerId]));
		setLoginState({ providerId });
		try {
			const result = await rpc.request<{ ok: boolean }>(
				"providers.login",
				{ sessionId, providerId },
				{ timeoutMs: PROVIDER_LOGIN_TIMEOUT_MS },
			);
			if (result?.ok) {
				// Only clear the panel if THIS provider's flow still holds it.
				setLoginState(s => (s?.providerId === providerId ? null : s));
				await loadProviders();
			}
		} catch (err) {
			// Keep the auth URL/instructions on screen so the user can still open
			// the link or cancel — the daemon flow may still be running.
			setLoginState(s =>
				s?.providerId === providerId ? { ...s, message: err instanceof Error ? err.message : String(err) } : s,
			);
		} finally {
			setPendingLogins(p => p.filter(x => x !== providerId));
		}
	};

	const submitLoginInput = async (value: string): Promise<void> => {
		if (!rpc || !loginState) return;
		try {
			await submitProviderLoginInput(rpc, loginState.providerId, value);
			setLoginState(s => (s ? { ...s, waitingInput: false } : s));
		} catch (err) {
			// Keep the input open and say why it did not take — an unanswered
			// prompt looked like a dead button.
			const message = err instanceof Error ? err.message : String(err);
			setLoginState(s => (s ? { ...s, message } : s));
		}
	};

	const cancelLogin = async (): Promise<void> => {
		if (!rpc || !loginState) return;
		try {
			await cancelProviderLogin(rpc, loginState.providerId);
		} catch (err) {
			// The dialog closes either way; a failed abort would otherwise leave
			// the daemon flow running with no trace.
			console.warn("[gui] providers.loginCancel failed", err);
		}
		setLoginState(null);
		// `loginCancel` aborts the daemon flow, which settles the login RPC —
		// but the reply can race the dialog close. Clear the pending flag HERE as
		// well: a stuck flag left the provider's buttons disabled for the full
		// 5-minute timeout.
		const id = loginState.providerId;
		setPendingLogins(p => p.filter(x => x !== id));
	};

	const logout = async (providerId: string): Promise<void> => {
		if (!rpc) return;
		try {
			await logoutProvider(rpc, { providerId });
			await loadProviders();
		} catch (err) {
			// A failed logout used to write loginState, which renders the
			// "Login to …" panel — i.e. failure looked like a login prompt.
			reportRequestFailure(t("settings.logout"), err);
		}
	};

	return {
		providers,
		apiProviders,
		custom,
		loginState,
		pendingLogins,
		login,
		logout,
		submitLoginInput,
		cancelLogin,
		reload: loadProviders,
	};
}

/** Subscribe to the daemon's provider auth envelopes, for a surface that is
 *  mounted on its own and receives no `providerEvent` prop from a parent. */
export function useProviderEvents(rpc: RpcClient | null): StreamEvent | null {
	const [event, setEvent] = useState<StreamEvent | null>(null);
	useEffect(() => {
		if (!rpc) return;
		return rpc.addEventListener(next => {
			if (next.kind.startsWith("provider-")) setEvent(next);
		});
	}, [rpc]);
	return event;
}
