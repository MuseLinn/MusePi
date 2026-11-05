import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openExternalUrl } from "../../lib/electron";
import { tapFeedback } from "../../lib/haptic";
import type { RpcClient } from "../../lib/rpc";
import { useExtensionRegistry } from "../../lib/slot-host";
import type { McpItem } from "./shared";

/** One row of daemon `mcp.servers.list` (headers/tokens never cross the wire). */
interface ConfiguredMcpServer {
	name: string;
	transport: "stdio" | "http" | "sse";
	url?: string;
	command?: string;
	auth?: "oauth" | "apikey";
	enabled?: boolean;
}

interface OAuthFlowStatus {
	flowId: string;
	server: string;
	status: "pending" | "success" | "error";
	error?: string;
	cancelled?: boolean;
}

/** Per-server login presentation; `starting` covers the start RPC itself. */
type FlowState =
	| { kind: "starting" }
	| { kind: "waiting"; flowId: string; authorizationUrl: string }
	| { kind: "success" }
	| { kind: "error"; message: string };

/** Matches the daemon flow's own 5-minute callback window. */
const POLL_INTERVAL_MS = 1000;
const FLOW_DEADLINE_MS = 5 * 60 * 1000;
/** Consecutive status RPC failures before the wait is declared lost. */
const POLL_FAILURE_LIMIT = 3;

/** Settings → 智能体 → MCP 服务器.
 *
 * Two data sources, one page:
 * - `extensions.list` (mcp-kind extensions) keeps the existing enable toggles
 *   on the mcp.json denylist path;
 * - `mcp.servers.list` adds what the toggles cannot show — transport, URL and
 *   auth kind per configured server — plus the browser OAuth login
 *   (`mcp.oauth.start/status/cancel`) for http/sse servers.
 *
 * Token-auth servers keep their token in mcp.json: the row says so instead of
 * offering a field that would have nowhere to persist. The authorization URL
 * stays in component state (opened through the OS handler, never rendered),
 * so a secret-bearing URL does not leak into the settings DOM or logs. */
export function McpSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const data = useExtensionRegistry(rpc);
	const mcps = useMemo(() => (data?.extensions ?? []).filter(e => e.kind === "mcp"), [data]);
	const [servers, setServers] = useState<ConfiguredMcpServer[] | null>(null);
	const [flows, setFlows] = useState<Record<string, FlowState>>({});
	const timers = useRef(new Map<string, ReturnType<typeof setInterval>>());
	const pollFailures = useRef(new Map<string, number>());

	const byName = useMemo(() => new Map(mcps.map(m => [m.name, m])), [mcps]);

	const loadServers = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		try {
			const res = await rpc.request<{ servers?: ConfiguredMcpServer[] }>("mcp.servers.list", {});
			setServers(Array.isArray(res?.servers) ? res.servers : []);
		} catch {
			// A malformed mcp.json rejects the RPC; the page still shows the
			// extension toggles above instead of pretending nothing is defined.
			setServers([]);
		}
	}, [rpc]);

	useEffect(() => {
		void loadServers();
	}, [loadServers]);

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
					setFlows(f => ({ ...f, [name]: { kind: "error", message: t("settings.mcpOauthLoginTimeout") } }));
					void rpc.request("mcp.oauth.cancel", { flowId }).catch(() => {});
					return;
				}
				void rpc
					.request<OAuthFlowStatus>("mcp.oauth.status", { flowId })
					.then(status => {
						if (status.status === "pending") return;
						stopPolling(name);
						if (status.status === "success") {
							setFlows(f => ({ ...f, [name]: { kind: "success" } }));
							// The stored grant changes the row's auth kind/state.
							void loadServers();
							return;
						}
						setFlows(f => ({
							...f,
							[name]: {
								kind: "error",
								message: status.cancelled
									? t("settings.mcpLoginCancelled")
									: t("settings.mcpOauthLoginFailed", { error: status.error ?? "" }),
							},
						}));
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
						setFlows(f => ({
							...f,
							[name]: {
								kind: "error",
								message: t("settings.mcpOauthLoginFailed", {
									error: error instanceof Error ? error.message : String(error),
								}),
							},
						}));
					});
			}, POLL_INTERVAL_MS);
			timers.current.set(name, timer);
		},
		[loadServers, rpc, stopPolling],
	);

	const login = useCallback(
		async (name: string): Promise<void> => {
			if (!rpc) return;
			tapFeedback();
			pollFailures.current.delete(name);
			setFlows(f => ({ ...f, [name]: { kind: "starting" } }));
			try {
				const started = await rpc.request<{ flowId: string; authorizationUrl: string }>("mcp.oauth.start", {
					name,
				});
				setFlows(f => ({
					...f,
					[name]: { kind: "waiting", flowId: started.flowId, authorizationUrl: started.authorizationUrl },
				}));
				// Best-effort: the row keeps a "reopen" action for a missed launch.
				void openExternalUrl(started.authorizationUrl).catch(() => {});
				poll(name, started.flowId);
			} catch (error) {
				setFlows(f => ({
					...f,
					[name]: {
						kind: "error",
						message: t("settings.mcpOauthLoginFailed", {
							error: error instanceof Error ? error.message : String(error),
						}),
					},
				}));
			}
		},
		[poll, rpc],
	);

	const cancelLogin = useCallback(
		async (name: string, flowId: string): Promise<void> => {
			stopPolling(name);
			try {
				await rpc?.request("mcp.oauth.cancel", { flowId });
			} catch {
				// Already settled on the daemon side.
			}
			setFlows(f => ({ ...f, [name]: { kind: "error", message: t("settings.mcpLoginCancelled") } }));
		},
		[stopPolling, rpc],
	);

	const toggle = (e: McpItem, next: boolean): void => {
		// daemon 广播 extensions.changed → 单例重拉,不本地乐观更新。
		void rpc?.request("extensions.setEnabled", { id: e.id, enabled: next });
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("settings.mcpServers")}</h2>
			<p className="gui-settings-page-desc">{t("settings.mcpSettings")}</p>
			{mcps.length === 0 ? (
				<div className="gui-settings-row">{t("settings.noMcpServers")}</div>
			) : (
				mcps.map(m => (
					<div key={m.id} className="gui-agent-card">
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<span className="truncate text-[13px] font-medium">{m.displayName || m.name}</span>
								<span className="gui-provider-chip">MCP</span>
							</div>
							{m.description && (
								<div className="truncate text-[12px] text-[var(--color-text-muted)]">{m.description}</div>
							)}
						</div>
						<button
							type="button"
							role="switch"
							aria-checked={m.state === "active"}
							className={`gui-toggle${m.state === "active" ? " gui-toggle--on" : ""}`}
							onClick={() => {
								tapFeedback();
								toggle(m, m.state !== "active");
							}}
						>
							<span className="gui-toggle-knob" />
						</button>
					</div>
				))
			)}
			{servers !== null && servers.length > 0 && (
				<>
					<h3 className="gui-settings-nav-group">{t("settings.mcpConfiguredServers")}</h3>
					{servers.map(server => {
						const flow = flows[server.name];
						const extension = byName.get(server.name);
						// OAuth is the only browser flow; a token-auth server keeps its
						// token in mcp.json, and stdio servers own their credentials.
						const canLogin = server.transport !== "stdio" && server.auth !== "apikey";
						return (
							<div key={server.name} className="gui-agent-card">
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-1.5">
										<span className="truncate text-[13px] font-medium">{server.name}</span>
										<span className="gui-provider-chip">{server.transport}</span>
										{server.auth && (
											<span className="gui-provider-chip">
												{server.auth === "oauth" ? t("settings.mcpAuthOauth") : t("settings.mcpAuthToken")}
											</span>
										)}
										{extension ? (
											<span className="gui-provider-chip">
												{extension.state === "active" ? t("settings.active") : t("settings.disabled")}
											</span>
										) : (
											server.enabled === false && (
												<span className="gui-provider-chip">{t("settings.disabled")}</span>
											)
										)}
									</div>
									<div className="truncate font-mono text-[11.5px] text-[var(--color-text-muted)]">
										{server.url ?? server.command ?? ""}
									</div>
									{server.auth === "apikey" && (
										<div className="text-[12px] text-[var(--color-text-muted)]">
											{t("settings.mcpTokenManagedByConfig")}
										</div>
									)}
									{server.transport === "stdio" && (
										<div className="text-[12px] text-[var(--color-text-muted)]">
											{t("settings.mcpStdioCredentials")}
										</div>
									)}
									{flow?.kind === "starting" && (
										<div className="text-[12px] text-[var(--color-text-muted)]">
											{t("settings.mcpOauthLoginStarting")}
										</div>
									)}
									{flow?.kind === "waiting" && (
										<div className="text-[12px] text-[var(--color-text-muted)]">
											{t("settings.mcpOauthLoginWaiting")}
										</div>
									)}
									{flow?.kind === "success" && (
										<div className="text-[12px] text-[var(--color-success)]">
											{t("settings.authorizationDone")}
										</div>
									)}
									{flow?.kind === "error" && (
										<div className="text-[12px] text-[var(--color-danger)]">{flow.message}</div>
									)}
								</div>
								{canLogin && (
									<div className="flex flex-shrink-0 items-center gap-1.5">
										{flow?.kind === "waiting" ? (
											<>
												<button
													type="button"
													className="gui-btn"
													onClick={() => void openExternalUrl(flow.authorizationUrl).catch(() => {})}
												>
													{t("settings.mcpOpenAuthorization")}
												</button>
												<button
													type="button"
													className="gui-btn"
													onClick={() => void cancelLogin(server.name, flow.flowId)}
												>
													{t("settings.cancel")}
												</button>
											</>
										) : (
											<button
												type="button"
												className="gui-btn"
												disabled={flow?.kind === "starting"}
												onClick={() => void login(server.name)}
											>
												{t("settings.login")}
											</button>
										)}
									</div>
								)}
							</div>
						);
					})}
				</>
			)}
		</>
	);
}
