/**
 * Browser OAuth flow state for one settings surface.
 *
 * Extracted from the MCP section so the connector catalog uses the same
 * start/poll/cancel contract instead of a second copy. The authorization URL
 * stays in hook state and is only handed to the OS opener, never rendered.
 */
import { t } from "@musepi/client-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { isElectron, openExternalUrl } from "../../lib/electron";
import { tapFeedback } from "../../lib/haptic";
import type { RpcClient } from "../../lib/rpc";

/** Desktop custom protocol registered by the Electron shell. */
const OAUTH_DEEP_LINK = "musepi://oauth/callback";

export interface OAuthFlowStatus {
	flowId: string;
	server: string;
	status: "pending" | "success" | "error";
	error?: string;
	cancelled?: boolean;
}

/** Per-server login presentation; `starting` covers the start RPC itself. */
export type McpOAuthFlow =
	| { kind: "starting" }
	| { kind: "waiting"; flowId: string; authorizationUrl: string }
	| { kind: "success" }
	| { kind: "error"; message: string };

const POLL_INTERVAL_MS = 1000;
/** Matches the daemon flow's own 5-minute callback window. */
const FLOW_DEADLINE_MS = 5 * 60 * 1000;
/** Consecutive status RPC failures before the wait is declared lost. */
const POLL_FAILURE_LIMIT = 3;

export interface UseMcpOAuthResult {
	flows: Record<string, McpOAuthFlow>;
	login(serverName: string): Promise<void>;
	cancel(serverName: string, flowId: string): Promise<void>;
	/** Drop a settled flow so a removed row does not keep its error text. */
	reset(serverName: string): void;
}

/**
 * @param onSettled called after a successful grant so the caller can reload
 *   whatever row the grant changed (server list, catalog status).
 */
export function useMcpOAuth(rpc: RpcClient | null, onSettled?: (serverName: string) => void): UseMcpOAuthResult {
	const [flows, setFlows] = useState<Record<string, McpOAuthFlow>>({});
	const timers = useRef(new Map<string, ReturnType<typeof setInterval>>());
	const pollFailures = useRef(new Map<string, number>());
	const settled = useRef(onSettled);
	settled.current = onSettled;

	const stopPolling = useCallback((name: string): void => {
		const timer = timers.current.get(name);
		if (timer) clearInterval(timer);
		timers.current.delete(name);
	}, []);

	useEffect(
		() => () => {
			for (const timer of timers.current.values()) clearInterval(timer);
			timers.current.clear();
		},
		[],
	);

	const fail = useCallback((name: string, message: string): void => {
		setFlows(current => ({ ...current, [name]: { kind: "error", message } }));
	}, []);

	const poll = useCallback(
		(name: string, flowId: string): void => {
			stopPolling(name);
			const deadline = Date.now() + FLOW_DEADLINE_MS;
			const timer = setInterval(() => {
				if (!rpc) {
					stopPolling(name);
					return;
				}
				if (Date.now() > deadline) {
					stopPolling(name);
					fail(name, t("settings.mcpOauthLoginTimeout"));
					void rpc.request("mcp.oauth.cancel", { flowId }).catch(() => {});
					return;
				}
				void rpc
					.request<OAuthFlowStatus>("mcp.oauth.status", { flowId })
					.then(status => {
						if (status.status === "pending") return;
						stopPolling(name);
						if (status.status === "success") {
							setFlows(current => ({ ...current, [name]: { kind: "success" } }));
							settled.current?.(name);
							return;
						}
						fail(
							name,
							status.cancelled
								? t("settings.mcpLoginCancelled")
								: t("settings.mcpOauthLoginFailed", { error: status.error ?? "" }),
						);
					})
					.catch(error => {
						// One failed poll is not a failed login (the daemon may be
						// mid-exchange or briefly reconnecting), but a status call that
						// keeps failing — e.g. the daemon dropped the flow — must end the
						// wait instead of leaving the row spinning for five minutes.
						const failures = (pollFailures.current.get(name) ?? 0) + 1;
						pollFailures.current.set(name, failures);
						if (failures < POLL_FAILURE_LIMIT) return;
						stopPolling(name);
						fail(
							name,
							t("settings.mcpOauthLoginFailed", {
								error: error instanceof Error ? error.message : String(error),
							}),
						);
					});
			}, POLL_INTERVAL_MS);
			timers.current.set(name, timer);
		},
		[fail, rpc, stopPolling],
	);

	const login = useCallback(
		async (name: string): Promise<void> => {
			if (!rpc) return;
			tapFeedback();
			pollFailures.current.delete(name);
			setFlows(current => ({ ...current, [name]: { kind: "starting" } }));
			try {
				const started = await rpc.request<{ flowId: string; authorizationUrl: string }>("mcp.oauth.start", {
					name,
					...(isElectron() ? { redirectUri: OAUTH_DEEP_LINK } : {}),
				});
				setFlows(current => ({
					...current,
					[name]: { kind: "waiting", flowId: started.flowId, authorizationUrl: started.authorizationUrl },
				}));
				// Best-effort: the row keeps a "reopen" action for a missed launch.
				void openExternalUrl(started.authorizationUrl).catch(() => {});
				poll(name, started.flowId);
			} catch (error) {
				fail(
					name,
					t("settings.mcpOauthLoginFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		},
		[fail, poll, rpc],
	);

	const cancel = useCallback(
		async (name: string, flowId: string): Promise<void> => {
			stopPolling(name);
			try {
				await rpc?.request("mcp.oauth.cancel", { flowId });
			} catch {
				// Already settled on the daemon side.
			}
			fail(name, t("settings.mcpLoginCancelled"));
		},
		[fail, rpc, stopPolling],
	);

	const reset = useCallback(
		(name: string): void => {
			stopPolling(name);
			setFlows(current => {
				if (!(name in current)) return current;
				const next = { ...current };
				delete next[name];
				return next;
			});
		},
		[stopPolling],
	);

	return { flows, login, cancel, reset };
}
