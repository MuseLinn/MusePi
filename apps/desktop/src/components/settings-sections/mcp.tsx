import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { openExternalUrl } from "../../lib/electron";
import { tapFeedback } from "../../lib/haptic";
import type { RpcClient } from "../../lib/rpc";
import { useExtensionRegistry } from "../../lib/slot-host";
import type { McpItem } from "./shared";
import { useMcpOAuth } from "./use-mcp-oauth";

/** One row of daemon `mcp.servers.list` (headers/tokens never cross the wire). */
interface ConfiguredMcpServer {
	name: string;
	transport: "stdio" | "http" | "sse";
	url?: string;
	command?: string;
	auth?: "oauth" | "apikey";
	enabled?: boolean;
}

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
 * lives in the shared OAuth hook and is opened through the OS handler, never
 * rendered, so a secret-bearing URL does not leak into the settings DOM or
 * logs. */
export function McpSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const data = useExtensionRegistry(rpc);
	const mcps = useMemo(() => (data?.extensions ?? []).filter(e => e.kind === "mcp"), [data]);
	const [servers, setServers] = useState<ConfiguredMcpServer[] | null>(null);

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

	const { flows, login, cancel: cancelLogin } = useMcpOAuth(rpc, () => void loadServers());

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
