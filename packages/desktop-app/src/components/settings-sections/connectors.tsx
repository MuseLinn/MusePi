/**
 * Settings → 智能体 → 连接器: the connector catalog page.
 *
 * One row per catalog entry. Enablement and live status come from the daemon
 * (`connectors.catalog.list`); connecting writes the enablement state and, for
 * an OAuth connector, immediately starts the same browser flow the MCP section
 * uses. The page never renders an authorization URL, token, or static header.
 */
import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { openExternalUrl } from "../../lib/electron";
import { tapFeedback } from "../../lib/haptic";
import type { RpcClient } from "../../lib/rpc";
import { useMcpOAuth } from "./use-mcp-oauth";

interface CatalogConnector {
	id: string;
	name: string;
	description: string;
	category?: string;
	docsUrl?: string;
	examples?: string[];
	kind: "mcp" | "cli";
	cliAuth: boolean;
	server?: { transport: "http" | "sse" | "stdio"; url?: string; command?: string };
	authMode: "oauth" | "none" | "token";
	tokenSet: boolean;
	tokenSchema?: {
		title?: string;
		description?: string;
		docUrl?: string;
		fields: Array<{
			key: string;
			label: string;
			type: "password" | "text";
			required?: boolean;
			placeholder?: string;
			description?: string;
		}>;
	};
	enabled: boolean;
	status: "connected" | "connecting" | "disconnected";
}

interface ConnectResult {
	serverName: string;
	needsAuth: boolean;
	needsTokenConfig?: boolean;
	needsApproval?: boolean;
	command?: string;
	args?: string[];
	envKeys?: string[];
	needsCliAuth?: boolean;
	flowId?: string;
	authorizationUrl?: string;
	userCode?: string;
	installCommand?: string;
	authCommand?: string;
	status: CatalogConnector["status"];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function statusLabel(status: CatalogConnector["status"]): string {
	if (status === "connected") return t("settings.connectorsStatusConnected");
	if (status === "connecting") return t("settings.connectorsStatusConnecting");
	return t("settings.connectorsStatusDisconnected");
}

export function ConnectorsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [connectors, setConnectors] = useState<CatalogConnector[] | null>(null);
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState<string | null>(null);
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tokenTarget, setTokenTarget] = useState<string | null>(null);
	const [tokenValues, setTokenValues] = useState<Record<string, string>>({});
	const [approvalTarget, setApprovalTarget] = useState<string | null>(null);
	const [approvalArgs, setApprovalArgs] = useState<string[]>([]);
	const [approvalEnvKeys, setApprovalEnvKeys] = useState<string[]>([]);
	const [approvalInstall, setApprovalInstall] = useState<string | undefined>();
	const [approvalAuth, setApprovalAuth] = useState<string | undefined>();
	const [cliFlow, setCliFlow] = useState<{ connectorId: string; flowId: string; url?: string; code?: string } | null>(
		null,
	);

	const load = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		try {
			const result = await rpc.request<{ connectors?: CatalogConnector[] }>("connectors.catalog.list", {});
			setConnectors(Array.isArray(result?.connectors) ? result.connectors : []);
		} catch (loadError) {
			setError(t("settings.connectorsLoadFailed", { error: errorMessage(loadError) }));
			setConnectors([]);
		}
	}, [rpc]);

	useEffect(() => {
		void load();
	}, [load]);

	const { flows, login, cancel, reset } = useMcpOAuth(rpc, () => void load());

	useEffect(() => {
		if (!cliFlow || !rpc) return;
		let cancelled = false;
		const timer = setInterval(() => {
			void rpc
				.request<{ status: "pending" | "success" | "error"; error?: string }>("connectors.cli.status", {
					flowId: cliFlow.flowId,
				})
				.then(result => {
					if (cancelled) return;
					if (result.status === "success") {
						setCliFlow(null);
						void load();
					} else if (result.status === "error") {
						setError(t("settings.connectorsCliAuthFailed", { error: result.error ?? "" }));
						setCliFlow(null);
					}
				})
				.catch(error => {
					if (cancelled) return;
					setError(t("settings.connectorsCliAuthFailed", { error: errorMessage(error) }));
					setCliFlow(null);
				});
		}, 1000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [cliFlow, load, rpc]);

	const cancelCli = useCallback(async (): Promise<void> => {
		if (!cliFlow || !rpc) return;
		const flowId = cliFlow.flowId;
		setCliFlow(null);
		await rpc.request("connectors.cli.cancel", { flowId }).catch(() => {});
	}, [cliFlow, rpc]);

	const visible = useMemo(() => {
		if (!connectors) return [];
		const needle = query.trim().toLowerCase();
		if (!needle) return connectors;
		return connectors.filter(connector =>
			`${connector.id}\n${connector.name}\n${connector.description}\n${connector.category ?? ""}`
				.toLowerCase()
				.includes(needle),
		);
	}, [connectors, query]);

	const refresh = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		tapFeedback();
		setError(null);
		try {
			await rpc.request("connectors.catalog.refresh", {});
			await load();
		} catch (refreshError) {
			setError(t("settings.connectorsRefreshFailed", { error: errorMessage(refreshError) }));
		}
	}, [load, rpc]);

	const connect = useCallback(
		async (connector: CatalogConnector, approve = false): Promise<void> => {
			if (!rpc) return;
			tapFeedback();
			setError(null);
			setPending(connector.id);
			try {
				const result = await rpc.request<ConnectResult>("connectors.connect", {
					id: connector.id,
					...(approve ? { approve: true } : {}),
				});
				await load();
				if (result.needsApproval) {
					setApprovalTarget(connector.id);
					setApprovalArgs(result.args ?? []);
					setApprovalEnvKeys(result.envKeys ?? []);
					setApprovalInstall(result.installCommand);
					setApprovalAuth(result.authCommand);
					setExpanded(connector.id);
					return;
				}
				if (result.needsCliAuth && result.flowId) {
					setCliFlow({
						connectorId: connector.id,
						flowId: result.flowId,
						...(result.authorizationUrl ? { url: result.authorizationUrl } : {}),
						...(result.userCode ? { code: result.userCode } : {}),
					});
					setExpanded(connector.id);
					return;
				}
				if (result.needsTokenConfig) {
					setTokenTarget(connector.id);
					setExpanded(connector.id);
					setTokenValues({});
					return;
				}
				if (result.needsAuth && connector.authMode === "oauth") await login(result.serverName);
			} catch (connectError) {
				setError(t("settings.connectorsConnectFailed", { error: errorMessage(connectError) }));
			} finally {
				setPending(null);
			}
		},
		[load, login, rpc],
	);

	const saveToken = useCallback(
		async (connector: CatalogConnector): Promise<void> => {
			if (!rpc) return;
			tapFeedback();
			setError(null);
			setPending(connector.id);
			try {
				await rpc.request("connectors.token.save", { id: connector.id, values: tokenValues });
				setTokenTarget(null);
				setTokenValues({});
				const result = await rpc.request<ConnectResult>("connectors.connect", { id: connector.id });
				await load();
				if (result.needsApproval) {
					setApprovalTarget(connector.id);
					setApprovalArgs(result.args ?? []);
					setApprovalEnvKeys(result.envKeys ?? []);
					setApprovalInstall(result.installCommand);
					setApprovalAuth(result.authCommand);
					setExpanded(connector.id);
					return;
				}
				if (result.needsCliAuth && result.flowId) {
					setCliFlow({
						connectorId: connector.id,
						flowId: result.flowId,
						...(result.authorizationUrl ? { url: result.authorizationUrl } : {}),
						...(result.userCode ? { code: result.userCode } : {}),
					});
					setExpanded(connector.id);
					return;
				}
				if (result.needsAuth && connector.authMode === "oauth") await login(result.serverName);
			} catch (saveError) {
				setError(t("settings.connectorsConnectFailed", { error: errorMessage(saveError) }));
			} finally {
				setPending(null);
			}
		},
		[load, login, rpc, tokenValues],
	);

	const disconnect = useCallback(
		async (connector: CatalogConnector): Promise<void> => {
			if (!rpc) return;
			tapFeedback();
			setError(null);
			setPending(connector.id);
			const flow = flows[`connector:${connector.id}`];
			if (flow?.kind === "waiting") await cancel(`connector:${connector.id}`, flow.flowId);
			reset(`connector:${connector.id}`);
			if (cliFlow?.connectorId === connector.id) {
				await rpc.request("connectors.cli.cancel", { flowId: cliFlow.flowId }).catch(() => {});
				setCliFlow(null);
			}
			setApprovalTarget(null);
			setApprovalArgs([]);
			setApprovalEnvKeys([]);
			try {
				await rpc.request("connectors.disconnect", { id: connector.id });
				await load();
			} catch (disconnectError) {
				setError(t("settings.connectorsDisconnectFailed", { error: errorMessage(disconnectError) }));
			} finally {
				setPending(null);
			}
		},
		[cancel, cliFlow, flows, load, reset, rpc],
	);

	return (
		<>
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<h2 className="gui-settings-page-title">{t("settings.connectors")}</h2>
					<p className="gui-settings-page-desc">{t("settings.connectorsDesc")}</p>
				</div>
				<button type="button" className="gui-btn flex-shrink-0" onClick={() => void refresh()}>
					{t("settings.connectorsRefresh")}
				</button>
			</div>

			<div className="gui-settings-row">
				<input
					className="gui-input min-w-0 flex-1"
					value={query}
					onChange={event => setQuery(event.target.value)}
					placeholder={t("settings.connectorsSearch")}
					aria-label={t("settings.connectorsSearch")}
				/>
			</div>

			{error && <div className="gui-settings-row text-[12px] text-[var(--color-danger)]">{error}</div>}

			{connectors === null ? null : visible.length === 0 ? (
				<div className="gui-settings-row">{t("settings.connectorsEmpty")}</div>
			) : (
				visible.map(connector => {
					const serverName = `connector:${connector.id}`;
					const flow = flows[serverName];
					const isPending = pending === connector.id;
					const isOpen = expanded === connector.id;
					return (
						<div key={connector.id} className="gui-agent-card gui-connector-card">
							<div className="flex items-center gap-3">
								<div
									className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-elevated)] text-[13px] font-medium"
									aria-hidden="true"
								>
									{connector.name.slice(0, 1).toUpperCase()}
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-1.5">
										<button
											type="button"
											className="truncate text-left text-[13px] font-medium"
											aria-expanded={isOpen}
											onClick={() => setExpanded(isOpen ? null : connector.id)}
										>
											{connector.name}
										</button>
										<span className="gui-provider-chip">
											{connector.kind === "cli"
												? connector.cliAuth
													? t("settings.connectorsAuthCli")
													: t("settings.connectorsAuthNone")
												: connector.authMode === "oauth"
													? t("settings.connectorsAuthOauth")
													: connector.authMode === "token"
														? t("settings.connectorsAuthToken")
														: t("settings.connectorsAuthNone")}
										</span>
										<span className="gui-provider-chip">{statusLabel(connector.status)}</span>
									</div>
									<div className="truncate text-[12px] text-[var(--color-text-muted)]">
										{connector.description}
									</div>
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
									{flow?.kind === "error" && (
										<div className="text-[12px] text-[var(--color-danger)]">{flow.message}</div>
									)}
								</div>
								<div className="flex flex-shrink-0 items-center gap-1.5">
									{tokenTarget === connector.id ||
									approvalTarget === connector.id ||
									cliFlow?.connectorId === connector.id ? null : flow?.kind === "waiting" ? (
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
												onClick={() => void cancel(serverName, flow.flowId)}
											>
												{t("settings.cancel")}
											</button>
										</>
									) : connector.enabled ? (
										<button
											type="button"
											className="gui-btn"
											disabled={isPending}
											onClick={() => void disconnect(connector)}
										>
											{t("settings.connectorsDisconnect")}
										</button>
									) : (
										<button
											type="button"
											className="gui-btn gui-btn-primary"
											disabled={isPending}
											onClick={() => void connect(connector)}
										>
											{t("settings.connectorsConnect")}
										</button>
									)}
								</div>
							</div>
							{isOpen &&
								(cliFlow?.connectorId === connector.id ||
									approvalTarget === connector.id ||
									tokenTarget === connector.id ||
									connector.examples?.length ||
									connector.docsUrl) && (
									<div className="border-t border-[var(--color-border-subtle)] pt-2">
										{cliFlow?.connectorId === connector.id && (
											<div className="mb-3">
												<div className="text-[12px] font-medium">
													{t("settings.connectorsCliAuthTitle")}
												</div>
												<div className="mb-2 text-[11.5px] text-[var(--color-text-muted)]">
													{t("settings.connectorsCliAuthHint")}
												</div>
												{cliFlow.url && (
													<div className="mt-2">
														<button
															type="button"
															className="gui-btn"
															onClick={() => void openExternalUrl(cliFlow.url!).catch(() => {})}
														>
															{t("settings.mcpOpenAuthorization")}
														</button>
														<code className="mt-1 block break-all text-[11px] text-[var(--color-text-muted)]">
															{cliFlow.url}
														</code>
													</div>
												)}
												{cliFlow.code && (
													<div className="mt-2 text-[12px]">
														<span className="text-[var(--color-text-muted)]">
															{t("settings.connectorsCliAuthCode")}
														</span>{" "}
														<code>{cliFlow.code}</code>
													</div>
												)}
												<div className="mt-2 flex items-center gap-1.5">
													<span className="text-[11.5px] text-[var(--color-text-muted)]">
														{t("settings.connectorsCliAuthWaiting")}
													</span>
													<button type="button" className="gui-btn" onClick={() => void cancelCli()}>
														{t("settings.cancel")}
													</button>
												</div>
											</div>
										)}
										{approvalTarget === connector.id && (
											<div className="mb-3">
												<div className="text-[12px] font-medium">
													{connector.kind === "cli"
														? t("settings.connectorsCliApprovalTitle")
														: t("settings.connectorsApprovalTitle")}
												</div>
												<div className="mb-2 text-[11.5px] text-[var(--color-text-muted)]">
													{connector.kind === "cli"
														? t("settings.connectorsCliApprovalHint")
														: t("settings.connectorsApprovalHint")}
												</div>
												{connector.kind === "cli" ? (
													<div className="space-y-1 text-[11.5px]">
														{approvalInstall && (
															<div className="break-all">
																<span className="text-[var(--color-text-muted)]">install: </span>
																<code>{approvalInstall}</code>
															</div>
														)}
														{approvalAuth && (
															<div className="break-all">
																<span className="text-[var(--color-text-muted)]">auth: </span>
																<code>{approvalAuth}</code>
															</div>
														)}
													</div>
												) : (
													<pre className="overflow-x-auto rounded-md bg-[var(--color-bg-elevated)] px-2 py-1 text-[11.5px]">
														{[connector.server?.command, ...approvalArgs].filter(Boolean).join(" ")}
													</pre>
												)}
												{approvalEnvKeys.length > 0 && (
													<div className="text-[11px] text-[var(--color-text-muted)]">
														{t("settings.connectorsApprovalEnv", { keys: approvalEnvKeys.join(", ") })}
													</div>
												)}
												<div className="flex items-center gap-1.5 pt-2">
													<button
														type="button"
														className="gui-btn gui-btn-primary"
														disabled={pending === connector.id}
														onClick={() => {
															setApprovalTarget(null);
															setApprovalArgs([]);
															setApprovalEnvKeys([]);
															void connect(connector, true);
														}}
													>
														{t("settings.connectorsApprovalConnect")}
													</button>
													<button
														type="button"
														className="gui-btn"
														onClick={() => setApprovalTarget(null)}
													>
														{t("settings.cancel")}
													</button>
												</div>
											</div>
										)}
										{tokenTarget === connector.id && connector.tokenSchema && (
											<div className="mb-3">
												{connector.tokenSchema.title && (
													<div className="text-[12px] font-medium">{connector.tokenSchema.title}</div>
												)}
												{connector.tokenSchema.description && (
													<div className="mb-2 text-[11.5px] text-[var(--color-text-muted)]">
														{connector.tokenSchema.description}
													</div>
												)}
												{connector.tokenSchema.fields.map(field => (
													<label key={field.key} className="mb-2 block">
														<span className="text-[11.5px] text-[var(--color-text-muted)]">
															{field.label}
															{field.required ? " *" : ""}
														</span>
														<input
															className="gui-input mt-1 w-full"
															type={field.type}
															value={tokenValues[field.key] ?? ""}
															placeholder={
																connector.tokenSet && field.type === "password"
																	? t("settings.connectorsTokenExisting")
																	: field.placeholder
															}
															onChange={event =>
																setTokenValues(current => ({
																	...current,
																	[field.key]: event.target.value,
																}))
															}
														/>
														{field.description && (
															<span className="text-[11px] text-[var(--color-text-muted)]">
																{field.description}
															</span>
														)}
													</label>
												))}
												<div className="flex items-center gap-1.5">
													<button
														type="button"
														className="gui-btn gui-btn-primary"
														disabled={pending === connector.id}
														onClick={() => void saveToken(connector)}
													>
														{t("settings.connectorsTokenSave")}
													</button>
													<button
														type="button"
														className="gui-btn"
														onClick={() => {
															setTokenTarget(null);
															setTokenValues({});
														}}
													>
														{t("settings.cancel")}
													</button>
												</div>
											</div>
										)}
										{connector.examples?.length ? (
											<>
												<div className="mb-1 text-[11.5px] text-[var(--color-text-muted)]">
													{t("settings.connectorsExamples")}
												</div>
												<ul className="space-y-1">
													{connector.examples.map(example => (
														<li
															key={example}
															className="rounded-md bg-[var(--color-bg-elevated)] px-2 py-1 text-[12px]"
														>
															{example}
														</li>
													))}
												</ul>
											</>
										) : null}
										{connector.docsUrl && (
											<button
												type="button"
												className="gui-btn-ghost mt-2 text-[12px]"
												onClick={() => void openExternalUrl(connector.docsUrl!).catch(() => {})}
											>
												{t("settings.connectorsDocs")}
											</button>
										)}
									</div>
								)}
						</div>
					);
				})
			)}
		</>
	);
}
