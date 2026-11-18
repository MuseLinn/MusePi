/**
 * Settings → 智能体 → 连接器: the connector catalog page.
 *
 * One row per catalog entry. Enablement and live status come from the daemon
 * (`connectors.catalog.list`); connecting writes the enablement state and, for
 * an OAuth connector, immediately starts the same browser flow the MCP section
 * uses. The page never renders an authorization URL, token, or static header.
 */
import { pushActionToast, t, useLocale } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { openExternalUrl } from "../../lib/electron";
import { tapFeedback } from "../../lib/haptic";
import type { RpcClient } from "../../lib/rpc";
import { CONNECTOR_BRAND_GLYPHS } from "./connector-brand-icons.generated";
import { ConnectorImportDialog } from "./connector-import-dialog";
import { DeviceGrantPanel } from "./device-grant-panel";
import { McpServersSection } from "./mcp";
import { useMcpOAuth } from "./use-mcp-oauth";

interface CatalogConnector {
	id: string;
	name: string;
	description: string;
	category?: string;
	icon?: string;
	descriptionZh?: string;
	details?: string;
	detailsZh?: string;
	featured?: boolean;
	verified?: "oauth" | "none" | "token" | "needs-app";
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
		/** A pasted personal access token, offered alongside the browser sign-in. */
		personalAccessToken?: { field: string; label?: string; docUrl?: string };
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

/** `mcp.servers.probe` verdict: a failed handshake is reported, never thrown. */
interface ProbeResult {
	name: string;
	ok: boolean;
	serverInfo?: { name?: string };
	toolNames?: string[];
	error?: string;
}

interface ProbeOutcome {
	pending: boolean;
	ok?: boolean;
	text?: string;
}

/**
 * Server name a probe targets. The daemon resolves the installed config by
 * name and injects stored credentials, so stdio, token, and OAuth rows all
 * work — and the wire never carries `args`, headers, or a secret. Managed CLI
 * rows have no MCP server behind them.
 */
function probeName(connector: CatalogConnector): string | null {
	if (connector.kind === "cli") return null;
	return `connector:${connector.id}`;
}

/**
 * Report an action's outcome.
 *
 * The page already shows a row's live status, so a toast is for the result of
 * something the user just pressed: it stays visible when the row that changed
 * is scrolled out of view, which a single error line at the top does not.
 */
function reportOutcome(
	outcome: { kind: "success" | "info" | "warning" | "error"; message: string; details?: string },
	connectorId: string,
): void {
	pushActionToast({ ...outcome, dedupeKey: `connector:${connectorId}:outcome` });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Category ids the bundled catalog uses, in render order. Shared with
 * `packages/coding-agent/src/connectors/bundled-catalog.ts`; a catalog that
 * names something else still renders, under 其他.
 */
const CONNECTOR_CATEGORY_ORDER: readonly string[] = ["dev", "docs", "ai", "design", "data", "business"];

/** Category heading, falling back to the raw id so an unknown one stays legible. */
function categoryLabel(key: string): string {
	if (key === "") return t("settings.connectorsCategoryOther");
	const known: Record<string, string> = {
		dev: t("settings.connectorsCategoryDev"),
		docs: t("settings.connectorsCategoryDocs"),
		ai: t("settings.connectorsCategoryAi"),
		design: t("settings.connectorsCategoryDesign"),
		data: t("settings.connectorsCategoryData"),
		business: t("settings.connectorsCategoryBusiness"),
	};
	return known[key] ?? key;
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
	const [probes, setProbes] = useState<Record<string, ProbeOutcome>>({});
	const [warnings, setWarnings] = useState<string[]>([]);
	const [category, setCategory] = useState<string | null>(null);
	const [importOpen, setImportOpen] = useState(false);
	const [deviceTarget, setDeviceTarget] = useState<string | null>(null);
	const locale = useLocale();
	const useChineseDescription = locale.toLowerCase().startsWith("zh");

	const load = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		try {
			const result = await rpc.request<{ connectors?: CatalogConnector[]; warnings?: string[] }>(
				"connectors.catalog.list",
				{},
			);
			setConnectors(Array.isArray(result?.connectors) ? result.connectors : []);
			setWarnings(Array.isArray(result?.warnings) ? result.warnings : []);
		} catch (loadError) {
			setError(t("settings.connectorsLoadFailed", { error: errorMessage(loadError) }));
			setConnectors([]);
			setWarnings([]);
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

	const searchable = (connector: CatalogConnector): string =>
		`${connector.id}
${connector.name}
${connector.description}
${connector.descriptionZh ?? ""}
${connector.category ?? ""}`.toLowerCase();

	const visible = useMemo(() => {
		if (!connectors) return [];
		const needle = query.trim().toLowerCase();
		if (!needle) return connectors;
		return connectors.filter(connector => searchable(connector).includes(needle));
	}, [connectors, query]);

	/**
	 * The page's opening section. A catalog that marks nothing falls back to
	 * the groups alone rather than inventing a recommendation.
	 */
	const featured = useMemo(() => visible.filter(connector => connector.featured === true), [visible]);

	/**
	 * Groups in the fixed order the bundled catalog uses. A category this build
	 * does not know keeps its own heading after the known ones, so a user index
	 * with its own taxonomy is grouped rather than dropped.
	 */
	const groups = useMemo(() => {
		const grouped = new Map<string, CatalogConnector[]>();
		for (const connector of visible) {
			if (category === null && connector.featured === true) continue;
			const key = connector.category ?? "";
			const bucket = grouped.get(key);
			if (bucket) bucket.push(connector);
			else grouped.set(key, [connector]);
		}
		const known = CONNECTOR_CATEGORY_ORDER.filter(key => grouped.has(key));
		const other = [...grouped.keys()].filter(key => !known.includes(key)).sort((a, b) => a.localeCompare(b));
		return [...known, ...other].map(key => ({ key, items: grouped.get(key) ?? [] }));
	}, [visible, category]);

	const categories = useMemo(() => {
		if (!connectors) return [];
		const present = new Set(connectors.map(connector => connector.category ?? ""));
		const known = CONNECTOR_CATEGORY_ORDER.filter(key => present.has(key));
		const other = [...present].filter(key => !known.includes(key)).sort((a, b) => a.localeCompare(b));
		return [...known, ...other];
	}, [connectors]);

	const refresh = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		tapFeedback();
		setError(null);
		try {
			const result = await rpc.request<{ count?: number; warnings?: string[] }>("connectors.catalog.refresh", {});
			await load();
			const count = typeof result?.count === "number" ? result.count : 0;
			const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
			pushActionToast({
				kind: warnings.length > 0 ? "warning" : "success",
				message: t("settings.connectorsRefreshed", { count: String(count) }),
				...(warnings.length > 0
					? { details: t("settings.connectorsWarnings", { count: String(warnings.length) }) }
					: {}),
				dedupeKey: "connector:catalog:refresh",
			});
		} catch (refreshError) {
			pushActionToast({
				kind: "error",
				message: t("settings.connectorsRefreshFailed", { error: errorMessage(refreshError) }),
				dedupeKey: "connector:catalog:refresh",
			});
		}
	}, [load, rpc]);

	/**
	 * Handshake without mounting: `mcp.servers.probe` never joins a session, so
	 * the result line can be shown before the user commits the connector. The
	 * daemon resolves the installed config by name and injects its stored
	 * credentials, so the form carries no command, args, or header.
	 */
	const testConnection = useCallback(
		async (connector: CatalogConnector): Promise<void> => {
			const name = probeName(connector);
			if (!rpc || !name) return;
			tapFeedback();
			setProbes(current => ({ ...current, [connector.id]: { pending: true } }));
			try {
				const result = await rpc.request<ProbeResult>("mcp.servers.probe", { name });
				const text = result.ok
					? t("{server} · {count} tools", {
							server: result.serverInfo?.name ?? connector.name,
							count: result.toolNames?.length ?? 0,
						})
					: (result.error ?? "");
				setProbes(current => ({ ...current, [connector.id]: { pending: false, ok: result.ok, text } }));
			} catch (probeError) {
				setProbes(current => ({
					...current,
					[connector.id]: { pending: false, ok: false, text: errorMessage(probeError) },
				}));
			}
		},
		[rpc],
	);

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
				if (result.needsAuth && connector.authMode === "oauth") {
					await login(result.serverName);
					return;
				}
				if (result.status === "connected") {
					reportOutcome(
						{ kind: "success", message: t("settings.connectorsConnected", { name: connector.name }) },
						connector.id,
					);
				}
			} catch (connectError) {
				reportOutcome(
					{
						kind: "error",
						message: t("settings.connectorsConnectFailed", { error: errorMessage(connectError) }),
					},
					connector.id,
				);
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
				else {
					reportOutcome(
						{ kind: "success", message: t("settings.connectorsTokenSaved", { name: connector.name }) },
						connector.id,
					);
				}
			} catch (saveError) {
				reportOutcome(
					{
						kind: "error",
						message: t("settings.connectorsConnectFailed", { error: errorMessage(saveError) }),
					},
					connector.id,
				);
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
				reportOutcome(
					{ kind: "info", message: t("settings.connectorsDisconnected", { name: connector.name }) },
					connector.id,
				);
			} catch (disconnectError) {
				reportOutcome(
					{
						kind: "error",
						message: t("settings.connectorsDisconnectFailed", { error: errorMessage(disconnectError) }),
					},
					connector.id,
				);
			} finally {
				setPending(null);
			}
		},
		[cancel, cliFlow, flows, load, reset, rpc],
	);

	/**
	 * One connector row. Extracted so the featured block and the category
	 * groups draw the same card; every action it offers comes from the flow,
	 * probe, and approval state above.
	 */
	const renderCard = (connector: CatalogConnector): ReactNode => {
		const serverName = `connector:${connector.id}`;
		const flow = flows[serverName];
		const isPending = pending === connector.id;
		const isOpen = expanded === connector.id;
		const probeState = probes[connector.id];
		const probeable = probeName(connector) !== null;
		const description =
			useChineseDescription && connector.descriptionZh ? connector.descriptionZh : connector.description;
		return (
			<div key={connector.id} className="gui-agent-card gui-connector-card">
				<div className="flex items-center gap-3">
					<div
						className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--color-bg-elevated)] text-[13px] font-medium"
						aria-hidden="true"
					>
						{(() => {
							const glyph = CONNECTOR_BRAND_GLYPHS[connector.id];
							if (glyph) {
								if ("src" in glyph) {
									return <img src={glyph.src} alt="" className="h-5 w-5 object-contain" />;
								}
								return (
									<svg viewBox={glyph.viewBox} className="h-5 w-5" role="presentation">
										{glyph.paths.map((path, index) => (
											<path key={index} d={path.d} fill={path.fill ?? "currentColor"} />
										))}
									</svg>
								);
							}
							if (connector.icon) {
								return <img src={connector.icon} alt="" className="h-5 w-5 object-contain" loading="lazy" />;
							}
							return connector.name.slice(0, 1).toUpperCase();
						})()}
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
							{connector.verified === "needs-app" && (
								<span className="gui-provider-chip">{t("settings.connectorsNeedsApp")}</span>
							)}
							<span className="gui-provider-chip">{statusLabel(connector.status)}</span>
						</div>
						<div className="truncate text-[12px] text-[var(--color-text-muted)]">{description}</div>
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
						{probeState?.text && (
							<div
								className={
									probeState.ok
										? "text-[12px] text-[var(--color-success)]"
										: "text-[12px] text-[var(--color-danger)]"
								}
							>
								{probeState.text}
							</div>
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
								<button type="button" className="gui-btn" onClick={() => void cancel(serverName, flow.flowId)}>
									{t("settings.cancel")}
								</button>
							</>
						) : (
							<>
								{probeable && (
									<button
										type="button"
										className="gui-btn"
										disabled={probeState?.pending}
										onClick={() => void testConnection(connector)}
									>
										{probeState?.pending ? t("settings.testing") : t("Test connection")}
									</button>
								)}
								{connector.enabled ? (
									<button
										type="button"
										className="gui-btn"
										disabled={isPending}
										onClick={() => void disconnect(connector)}
									>
										{t("settings.connectorsDisconnect")}
									</button>
								) : (
									<>
										{connector.authMode === "oauth" && (
											<button
												type="button"
												className="gui-btn"
												disabled={isPending}
												onClick={() => setDeviceTarget(connector.id)}
											>
												{t("settings.mcpDeviceStart")}
											</button>
										)}
										{connector.tokenSchema?.personalAccessToken && (
											<button
												type="button"
												className="gui-btn"
												disabled={isPending}
												onClick={() => {
													setTokenTarget(connector.id);
													setExpanded(connector.id);
													setTokenValues({});
												}}
											>
												{t("settings.connectorsPatButton")}
											</button>
										)}
										<button
											type="button"
											className="gui-btn gui-btn-primary"
											disabled={isPending}
											onClick={() => void connect(connector)}
										>
											{t("settings.connectorsConnect")}
										</button>
									</>
								)}
							</>
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
									<div className="text-[12px] font-medium">{t("settings.connectorsCliAuthTitle")}</div>
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
													<span className="text-[var(--color-text-muted)]">
														{t("settings.connectorsCliInstallLabel")}
													</span>
													<code>{approvalInstall}</code>
												</div>
											)}
											{approvalAuth && (
												<div className="break-all">
													<span className="text-[var(--color-text-muted)]">
														{t("settings.connectorsCliAuthLabel")}
													</span>
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
										<button type="button" className="gui-btn" onClick={() => setApprovalTarget(null)}>
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
									{connector.tokenSchema.personalAccessToken && (
										<label className="mb-2 block">
											<span className="text-[11.5px] text-[var(--color-text-muted)]">
												{connector.tokenSchema.personalAccessToken.label ??
													t("settings.connectorsPatLabel")}
											</span>
											<input
												className="gui-input mt-1 w-full"
												type="password"
												value={tokenValues[connector.tokenSchema.personalAccessToken.field] ?? ""}
												placeholder={connector.tokenSet ? t("settings.connectorsTokenExisting") : undefined}
												onChange={event =>
													setTokenValues(current => ({
														...current,
														[connector.tokenSchema!.personalAccessToken!.field]: event.target.value,
													}))
												}
											/>
											{connector.tokenSchema.personalAccessToken.docUrl && (
												<button
													type="button"
													className="gui-btn-ghost mt-2 text-[12px]"
													onClick={() =>
														void openExternalUrl(
															connector.tokenSchema!.personalAccessToken!.docUrl!,
														).catch(() => {})
													}
												>
													{t("settings.connectorsPatWhere")}
												</button>
											)}
										</label>
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
							{(useChineseDescription ? (connector.detailsZh ?? connector.details) : connector.details) && (
								<p className="text-[12px] leading-relaxed text-[var(--color-text-muted)]">
									{useChineseDescription ? (connector.detailsZh ?? connector.details) : connector.details}
								</p>
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
	};

	return (
		<>
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<h2 className="gui-settings-page-title">{t("settings.connectors")}</h2>
					<p className="gui-settings-page-desc">{t("settings.connectorsDesc")}</p>
				</div>
				<div className="flex flex-shrink-0 items-center gap-2">
					<button type="button" className="gui-btn" onClick={() => setImportOpen(true)}>
						{t("settings.connectorsImport")}
					</button>
					<button type="button" className="gui-btn" onClick={() => void refresh()}>
						{t("settings.connectorsRefresh")}
					</button>
				</div>
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

			{categories.length > 1 && (
				<div className="gui-skill-market-chips" role="group" aria-label={t("settings.connectorsCategoryFilter")}>
					<button
						type="button"
						className={`gui-skill-market-chip${category === null ? " gui-skill-market-chip--on" : ""}`}
						aria-pressed={category === null}
						onClick={() => setCategory(null)}
					>
						{t("settings.connectorsAll")}
					</button>
					{categories.map(key => (
						<button
							key={key || "other"}
							type="button"
							className={`gui-skill-market-chip${category === key ? " gui-skill-market-chip--on" : ""}`}
							aria-pressed={category === key}
							onClick={() => setCategory(category === key ? null : key)}
						>
							{categoryLabel(key)}
						</button>
					))}
				</div>
			)}

			{error && <div className="gui-settings-row text-[12px] text-[var(--color-danger)]">{error}</div>}

			{warnings.length > 0 && (
				<div className="gui-settings-row text-[12px] text-[var(--color-text-muted)]">
					<div>{t("settings.connectorsWarnings", { count: String(warnings.length) })}</div>
					<ul className="mt-1 list-disc pl-5">
						{warnings.slice(0, 5).map((warning, index) => (
							<li key={`${index}-${warning}`} className="break-all">
								{warning}
							</li>
						))}
					</ul>
				</div>
			)}

			{connectors === null ? null : visible.length === 0 ? (
				<div className="gui-settings-row">{t("settings.connectorsEmpty")}</div>
			) : (
				<>
					{featured.length > 0 && category === null && (
						<>
							<h3 className="gui-settings-section-title">{t("settings.connectorsFeatured")}</h3>
							<div className="flex flex-col gap-2">{featured.map(renderCard)}</div>
						</>
					)}
					{groups.map(group => (
						<div key={group.key || "other"} className="mt-4">
							<h3 className="gui-settings-section-title">{categoryLabel(group.key)}</h3>
							<div className="flex flex-col gap-2">{group.items.map(renderCard)}</div>
						</div>
					))}
				</>
			)}
			{deviceTarget !== null && (
				<DeviceGrantPanel
					rpc={rpc}
					serverName={`connector:${deviceTarget}`}
					open={deviceTarget !== null}
					onDone={() => {
						void load();
						pushActionToast({
							kind: "success",
							message: t("settings.connectorsDeviceConnected", {
								name: connectors?.find(item => item.id === deviceTarget)?.name ?? deviceTarget ?? "",
							}),
							dedupeKey: `connector:${deviceTarget ?? ""}:outcome`,
						});
					}}
				/>
			)}
			<ConnectorImportDialog
				rpc={rpc}
				open={importOpen}
				onClose={() => setImportOpen(false)}
				onImported={() => void load()}
			/>
			<McpServersSection rpc={rpc} />
		</>
	);
}
