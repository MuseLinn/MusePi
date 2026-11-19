/**
 * Settings → 智能体 → 连接器: the connector catalog page.
 *
 * Rows are a two-column index of the catalog; anything longer than a name and
 * one sentence — the long description, examples, the credential form, CLI
 * authorization, the local-process approval — opens in the detail dialog.
 * Enablement and live status come from the daemon
 * (`connectors.catalog.list`); connecting writes the enablement state and, for
 * an OAuth connector, immediately starts the same browser flow the MCP section
 * uses. The page never renders an authorization URL, token, or static header.
 */

import { pushActionToast, t, useLocale } from "@musepi/client-core";
import { Copy, CornerDownLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { copyToClipboard, openExternalUrl } from "../../lib/electron";
import { tapFeedback } from "../../lib/haptic";
import type { RpcClient } from "../../lib/rpc";
import { DialogFrame } from "../DialogFrame";
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
	examplesZh?: string[];
	kind: "mcp" | "cli";
	cliAuth: boolean;
	server?: { transport: "http" | "sse" | "stdio"; url?: string; command?: string };
	authMode: "oauth" | "none" | "token";
	/** The device grant is this row's sign-in path (pinned client id, no secret). */
	deviceAuth?: boolean;
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
	/** The browser exchange cannot complete; use the device grant. */
	needsDeviceAuth?: boolean;
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
	/** Raw failure text, shown behind the details disclosure. */
	detail?: string;
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

/** Viewport rectangle of a connector row, the origin of its dialog. */
function connectorRowRect(id: string): DOMRect | null {
	return document.querySelector<HTMLElement>(`[data-connector-id="${id}"]`)?.getBoundingClientRect() ?? null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Turn a transport or auth failure into the next step a person can take. The
 * raw text — an HTTP status and a `WWW-Authenticate` header, usually — is kept
 * for the details disclosure; it is not the sentence to read first.
 */
function connectorError(raw: string): { text: string; raw?: string } {
	const message = raw.trim();
	if (!message) return { text: t("settings.connectorsErrorUnknown") };
	if (
		/redirect uri|invalid_client|invalid_request|unauthorized|401|no access token|www-authenticate|incorrect_client/i.test(
			message,
		)
	) {
		return { text: t("settings.connectorsErrorSignIn"), raw: message };
	}
	if (/enotfound|econnrefused|fetch failed|network|socket|timed? ?out|etimedout/i.test(message)) {
		return { text: t("settings.connectorsErrorNetwork"), raw: message };
	}
	return { text: message };
}

/** Failure line plus the raw response behind a disclosure. */
function ConnectorFailure({ message, detail }: { message: string; detail?: string }): ReactNode {
	const failure = connectorError(message);
	const raw = detail ?? failure.raw;
	return (
		<>
			<div className="text-[12px] text-[var(--color-danger)]">{failure.text}</div>
			{raw && raw !== failure.text && (
				<details className="gui-connector-failure-details">
					<summary>{t("settings.connectorsErrorDetails")}</summary>
					<pre>{raw}</pre>
				</details>
			)}
		</>
	);
}

/**
 * Category ids the bundled catalog uses, in render order. Shared with
 * `packages/coding-agent/src/connectors/bundled-catalog.ts`; a catalog that
 * names something else still renders, under 其他.
 */
const CONNECTOR_CATEGORY_ORDER: readonly string[] = ["dev", "docs", "ai", "design", "data", "business"];

/** Rows a category shows before offering its own filter, so six categories do not become one long page. */
const CONNECTOR_GROUP_PREVIEW = 6;

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

/** How a row signs in, in the one word that fits beside its name. */
function connectorAuthLabel(connector: CatalogConnector): string {
	if (connector.kind === "cli") {
		return connector.cliAuth ? t("settings.connectorsAuthCli") : t("settings.connectorsAuthNone");
	}
	if (connector.authMode === "oauth") return t("settings.connectorsAuthOauth");
	if (connector.authMode === "token") return t("settings.connectorsAuthToken");
	return t("settings.connectorsAuthNone");
}

export function ConnectorsSection({
	rpc,
	onApplyPrompt,
}: {
	rpc: RpcClient | null;
	/** Hand an example to the composer: the host closes settings and inserts it. */
	onApplyPrompt?: (text: string) => void;
}): ReactNode {
	const [connectors, setConnectors] = useState<CatalogConnector[] | null>(null);
	const [query, setQuery] = useState("");
	const [detailId, setDetailId] = useState<string | null>(null);
	const [detailConnector, setDetailConnector] = useState<CatalogConnector | null>(null);
	const [alternativesOpen, setAlternativesOpen] = useState(false);
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
	const [importOrigin, setImportOrigin] = useState<DOMRect | null>(null);
	const [deviceTarget, setDeviceTarget] = useState<string | null>(null);
	const [deviceOrigin, setDeviceOrigin] = useState<DOMRect | null>(null);
	const [detailOrigin, setDetailOrigin] = useState<DOMRect | null>(null);
	const locale = useLocale();
	const useChineseDescription = locale.toLowerCase().startsWith("zh");

	/**
	 * The detail dialog keeps the last connector it showed. `DialogFrame` runs
	 * a 180ms exit, and a shell keyed to the current id would go blank during it.
	 */
	const openDetail = useCallback((connector: CatalogConnector): void => {
		setDetailOrigin(connectorRowRect(connector.id));
		setDetailConnector(connector);
		setDetailId(connector.id);
		setAlternativesOpen(false);
	}, []);

	useEffect(() => {
		if (detailId === null) return;
		const fresh = connectors?.find(item => item.id === detailId);
		if (fresh) setDetailConnector(fresh);
	}, [connectors, detailId]);

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

	/**
	 * A row becomes enabled only after its sign-in lands: the daemon answers
	 * `needsAuth` without touching enablement, and this runs when the browser
	 * or device flow settles. A failed or abandoned login therefore leaves the
	 * row where it started instead of enabled with a "disconnect" action.
	 */
	const enableAfterLogin = useCallback(
		async (serverName: string): Promise<void> => {
			const id = serverName.startsWith("connector:") ? serverName.slice("connector:".length) : "";
			if (!id || !rpc) return;
			try {
				await rpc.request("connectors.setEnabled", { id, enabled: true });
				reportOutcome(
					{
						kind: "success",
						message: t("settings.connectorsConnected", {
							name: connectors?.find(item => item.id === id)?.name ?? id,
						}),
					},
					id,
				);
			} catch (enableError) {
				reportOutcome({ kind: "error", message: connectorError(errorMessage(enableError)).text }, id);
			}
			await load();
		},
		[connectors, load, rpc],
	);

	const { flows, login, cancel, reset } = useMcpOAuth(rpc, name => void enableAfterLogin(name));

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
		return connectors.filter(
			connector =>
				(category === null || (connector.category ?? "") === category) &&
				(needle === "" || searchable(connector).includes(needle)),
		);
	}, [connectors, query, category]);

	/**
	 * The page's opening section. A catalog that marks nothing falls back to
	 * the groups alone rather than inventing a recommendation.
	 */
	const featured = useMemo(() => visible.filter(connector => connector.featured === true), [visible]);

	/** Live connections sit above the taxonomy, the way a library splits installed from available. */
	const connected = useMemo(() => visible.filter(connector => connector.status === "connected"), [visible]);

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
				if (result.ok) {
					const text = t("{server} · {count} tools", {
						server: result.serverInfo?.name ?? connector.name,
						count: result.toolNames?.length ?? 0,
					});
					setProbes(current => ({ ...current, [connector.id]: { pending: false, ok: true, text } }));
				} else {
					const failure = connectorError(result.error ?? "");
					setProbes(current => ({
						...current,
						[connector.id]: {
							pending: false,
							ok: false,
							text: failure.text,
							...(failure.raw ? { detail: failure.raw } : {}),
						},
					}));
				}
			} catch (probeError) {
				const failure = connectorError(errorMessage(probeError));
				setProbes(current => ({
					...current,
					[connector.id]: {
						pending: false,
						ok: false,
						text: failure.text,
						...(failure.raw ? { detail: failure.raw } : {}),
					},
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
					openDetail(connector);
					return;
				}
				if (result.needsCliAuth && result.flowId) {
					setCliFlow({
						connectorId: connector.id,
						flowId: result.flowId,
						...(result.authorizationUrl ? { url: result.authorizationUrl } : {}),
						...(result.userCode ? { code: result.userCode } : {}),
					});
					openDetail(connector);
					return;
				}
				if (result.needsTokenConfig) {
					setTokenTarget(connector.id);
					setTokenValues({});
					openDetail(connector);
					return;
				}
				if (result.needsAuth && connector.authMode === "oauth") {
					if (result.needsDeviceAuth) {
						// This row has a pinned client id but no secret, so the browser
						// exchange cannot finish. The device grant is its sign-in path and
						// keeps polling from the page, not from this dialog.
						setDeviceOrigin(connectorRowRect(connector.id));
						setDeviceTarget(connector.id);
						setDetailId(null);
						return;
					}
					// The detail dialog carries the authorization link, so it has to
					// be on screen before the browser flow turns into a waiting state.
					openDetail(connector);
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
						message: t("settings.connectorsConnectFailed", {
							error: connectorError(errorMessage(connectError)).text,
						}),
					},
					connector.id,
				);
			} finally {
				setPending(null);
			}
		},
		[load, login, openDetail, rpc],
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
					openDetail(connector);
					return;
				}
				if (result.needsCliAuth && result.flowId) {
					setCliFlow({
						connectorId: connector.id,
						flowId: result.flowId,
						...(result.authorizationUrl ? { url: result.authorizationUrl } : {}),
						...(result.userCode ? { code: result.userCode } : {}),
					});
					openDetail(connector);
					return;
				}
				if (result.needsAuth && connector.authMode === "oauth") {
					openDetail(connector);
					await login(result.serverName);
				} else {
					reportOutcome(
						{ kind: "success", message: t("settings.connectorsTokenSaved", { name: connector.name }) },
						connector.id,
					);
				}
			} catch (saveError) {
				reportOutcome(
					{
						kind: "error",
						message: t("settings.connectorsConnectFailed", {
							error: connectorError(errorMessage(saveError)).text,
						}),
					},
					connector.id,
				);
			} finally {
				setPending(null);
			}
		},
		[load, login, openDetail, rpc, tokenValues],
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
						message: t("settings.connectorsDisconnectFailed", {
							error: connectorError(errorMessage(disconnectError)).text,
						}),
					},
					connector.id,
				);
			} finally {
				setPending(null);
			}
		},
		[cancel, cliFlow, flows, load, reset, rpc],
	);

	/** Brand mark from the bundled vector set; no network request per row. */
	const renderGlyph = (connector: CatalogConnector, size: "row" | "detail"): ReactNode => {
		const glyph = CONNECTOR_BRAND_GLYPHS[connector.id];
		const box = size === "detail" ? "h-6 w-6" : "h-5 w-5";
		if (glyph) {
			if ("src" in glyph) {
				return <img src={glyph.src} alt="" className={`${box} object-contain`} />;
			}
			return (
				<svg viewBox={glyph.viewBox} className={box} role="presentation">
					{glyph.paths.map((path, index) => (
						<path key={index} d={path.d} fill={path.fill ?? "currentColor"} />
					))}
				</svg>
			);
		}
		if (connector.icon) {
			return <img src={connector.icon} alt="" className={`${box} object-contain`} loading="lazy" />;
		}
		return connector.name.slice(0, 1).toUpperCase();
	};

	/**
	 * One catalog row. The row opens the detail dialog; the trailing control is
	 * the single action taken from the list. A connect that turns out to need a
	 * credential, a local-process approval, or a browser hand-off opens that
	 * dialog, so the flow is never left behind a row the user cannot see.
	 */
	const renderRow = (connector: CatalogConnector): ReactNode => {
		const flow = flows[`connector:${connector.id}`];
		const busy =
			pending === connector.id ||
			connector.status === "connecting" ||
			flow?.kind === "starting" ||
			flow?.kind === "waiting";
		const description =
			useChineseDescription && connector.descriptionZh ? connector.descriptionZh : connector.description;
		return (
			<div key={connector.id} data-connector-id={connector.id} className="gui-agent-card gui-connector-card">
				<button type="button" className="gui-connector-main" onClick={() => openDetail(connector)}>
					<span className="gui-connector-icon" aria-hidden="true">
						{renderGlyph(connector, "row")}
					</span>
					<span className="gui-connector-text">
						<span className="gui-connector-title">
							<span className="gui-connector-name">{connector.name}</span>
							{connector.verified === "needs-app" && (
								<span className="gui-provider-chip">{t("settings.connectorsNeedsApp")}</span>
							)}
							{connector.status !== "disconnected" && (
								<span className="gui-provider-chip">{statusLabel(connector.status)}</span>
							)}
						</span>
						<span className="gui-connector-desc">{description}</span>
					</span>
				</button>
				<div className="gui-connector-action">
					{connector.enabled ? (
						<button type="button" className="gui-btn" onClick={() => openDetail(connector)}>
							{t("settings.connectorsManage")}
						</button>
					) : (
						<button type="button" className="gui-btn" disabled={busy} onClick={() => void connect(connector)}>
							{busy ? t("settings.connectorsStatusConnecting") : t("settings.connectorsConnect")}
						</button>
					)}
				</div>
			</div>
		);
	};

	/**
	 * Second-level connector detail. Everything that used to expand inside the
	 * row lives here — what the connector reaches, examples, the credential
	 * form, CLI authorization, the local-process approval, and the probe
	 * verdict — so the list stays scannable at 60 entries.
	 */
	const renderDetail = (connector: CatalogConnector): ReactNode => {
		const flow = flows[`connector:${connector.id}`];
		const probeState = probes[connector.id];
		const probeable = probeName(connector) !== null;
		const isPending = pending === connector.id;
		const details = useChineseDescription ? (connector.detailsZh ?? connector.details) : connector.details;
		const description =
			useChineseDescription && connector.descriptionZh ? connector.descriptionZh : connector.description;
		const exampleList =
			useChineseDescription && connector.examplesZh?.length ? connector.examplesZh : connector.examples;
		const copyExample = (example: string): void => {
			void copyToClipboard(example).then(copied => {
				if (copied) {
					pushActionToast({ kind: "success", message: t("settings.copied"), dedupeKey: "connector:example" });
				}
			});
		};
		const probeButton = probeable ? (
			<button
				type="button"
				className="gui-btn"
				disabled={probeState?.pending}
				onClick={() => void testConnection(connector)}
			>
				{probeState?.pending ? t("settings.testing") : t("Test connection")}
			</button>
		) : null;
		return (
			<div className="gui-connector-detail">
				<div className="gui-connector-detail-head">
					<span className="gui-connector-detail-icon" aria-hidden="true">
						{renderGlyph(connector, "detail")}
					</span>
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-1.5">
							<h3 className="gui-settings-page-title">{connector.name}</h3>
							<span className="gui-provider-chip">{connectorAuthLabel(connector)}</span>
							{connector.verified === "needs-app" && (
								<span className="gui-provider-chip">{t("settings.connectorsNeedsApp")}</span>
							)}
							<span className="gui-provider-chip">{statusLabel(connector.status)}</span>
						</div>
						<div className="gui-settings-page-desc">
							{categoryLabel(connector.category ?? "")} · {description}
						</div>
					</div>
					<button type="button" className="gui-btn" onClick={() => setDetailId(null)}>
						{t("settings.close")}
					</button>
				</div>
				<div className="gui-connector-detail-body">
					<div className="gui-connector-detail-actions">
						{flow?.kind === "waiting" ? (
							<>
								<button
									type="button"
									className="gui-btn gui-btn-primary"
									onClick={() => void openExternalUrl(flow.authorizationUrl).catch(() => {})}
								>
									{t("settings.mcpOpenAuthorization")}
								</button>
								<button
									type="button"
									className="gui-btn"
									onClick={() => void cancel(`connector:${connector.id}`, flow.flowId)}
								>
									{t("settings.cancel")}
								</button>
							</>
						) : connector.enabled ? (
							<>
								<button
									type="button"
									className="gui-btn"
									disabled={isPending}
									onClick={() => void disconnect(connector)}
								>
									{t("settings.connectorsDisconnect")}
								</button>
								{probeButton}
							</>
						) : (
							<>
								<button
									type="button"
									className="gui-btn gui-btn-primary"
									disabled={isPending}
									onClick={() => void connect(connector)}
								>
									{t("settings.connectorsConnect")}
								</button>
								{probeButton}
								{connector.tokenSchema?.personalAccessToken && (
									<button
										type="button"
										className="gui-btn"
										aria-expanded={alternativesOpen}
										onClick={() => setAlternativesOpen(open => !open)}
									>
										{t("settings.connectorsOtherSignIn")}
									</button>
								)}
							</>
						)}
					</div>
					{connector.deviceAuth && !connector.enabled && (
						<div className="text-[11.5px] text-[var(--color-text-muted)]">
							{t("settings.connectorsDeviceHint")}
						</div>
					)}
					{alternativesOpen && connector.tokenSchema?.personalAccessToken && !connector.enabled && (
						<div className="gui-connector-detail-block">
							<button
								type="button"
								className="gui-btn self-start"
								disabled={isPending}
								onClick={() => {
									setTokenTarget(connector.id);
									setTokenValues({});
								}}
							>
								{t("settings.connectorsPatButton")}
							</button>
							<div className="text-[11.5px] text-[var(--color-text-muted)]">
								{t("settings.connectorsPatHint")}
							</div>
						</div>
					)}
					{flow?.kind === "starting" && (
						<div className="text-[12px] text-[var(--color-text-muted)]">
							{t("settings.mcpOauthLoginStarting")}
						</div>
					)}
					{flow?.kind === "waiting" && (
						<div className="text-[12px] text-[var(--color-text-muted)]">{t("settings.mcpOauthLoginWaiting")}</div>
					)}
					{flow?.kind === "error" && <ConnectorFailure message={flow.message} />}
					{probeState?.text &&
						(probeState.ok ? (
							<div className="text-[12px] text-[var(--color-success)]">{probeState.text}</div>
						) : (
							<ConnectorFailure message={probeState.text} detail={probeState.detail} />
						))}
					{cliFlow?.connectorId === connector.id && (
						<div className="gui-connector-detail-block">
							<div className="text-[12px] font-medium">{t("settings.connectorsCliAuthTitle")}</div>
							<div className="text-[11.5px] text-[var(--color-text-muted)]">
								{t("settings.connectorsCliAuthHint")}
							</div>
							{cliFlow.url && (
								<>
									<button
										type="button"
										className="gui-btn"
										onClick={() => void openExternalUrl(cliFlow.url!).catch(() => {})}
									>
										{t("settings.mcpOpenAuthorization")}
									</button>
									<code className="break-all text-[11px] text-[var(--color-text-muted)]">{cliFlow.url}</code>
								</>
							)}
							{cliFlow.code && (
								<div className="text-[12px]">
									<span className="text-[var(--color-text-muted)]">{t("settings.connectorsCliAuthCode")}</span>{" "}
									<code>{cliFlow.code}</code>
								</div>
							)}
							<div className="flex items-center gap-1.5">
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
						<div className="gui-connector-detail-block">
							<div className="text-[12px] font-medium">
								{connector.kind === "cli"
									? t("settings.connectorsCliApprovalTitle")
									: t("settings.connectorsApprovalTitle")}
							</div>
							<div className="text-[11.5px] text-[var(--color-text-muted)]">
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
							<div className="flex items-center gap-1.5 pt-1">
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
						<div className="gui-connector-detail-block">
							{connector.tokenSchema.title && (
								<div className="text-[12px] font-medium">{connector.tokenSchema.title}</div>
							)}
							{connector.tokenSchema.description && (
								<div className="text-[11.5px] text-[var(--color-text-muted)]">
									{connector.tokenSchema.description}
								</div>
							)}
							{connector.tokenSchema.personalAccessToken && (
								<label className="block">
									<span className="text-[11.5px] text-[var(--color-text-muted)]">
										{connector.tokenSchema.personalAccessToken.label ?? t("settings.connectorsPatLabel")}
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
											className="gui-btn-ghost mt-1 text-[12px]"
											onClick={() =>
												void openExternalUrl(connector.tokenSchema!.personalAccessToken!.docUrl!).catch(
													() => {},
												)
											}
										>
											{t("settings.connectorsPatWhere")}
										</button>
									)}
								</label>
							)}
							{connector.tokenSchema.fields.map(field => (
								<label key={field.key} className="block">
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
											setTokenValues(current => ({ ...current, [field.key]: event.target.value }))
										}
									/>
									{field.description && (
										<span className="text-[11px] text-[var(--color-text-muted)]">{field.description}</span>
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
					{details && <p className="text-[12px] leading-relaxed text-[var(--color-text-muted)]">{details}</p>}
					{exampleList?.length ? (
						<div className="gui-connector-detail-block">
							<div className="text-[11.5px] text-[var(--color-text-muted)]">
								{t("settings.connectorsExamples")}
							</div>
							<ul className="gui-connector-examples">
								{exampleList.map(example => (
									<li key={example} className="gui-connector-example">
										<span className="gui-connector-example-text">{example}</span>
										<span className="gui-connector-example-actions">
											{onApplyPrompt && (
												<button
													type="button"
													className="gui-connector-example-action"
													title={t("settings.connectorsUseExample")}
													aria-label={t("settings.connectorsUseExample")}
													onClick={() => onApplyPrompt(example)}
												>
													<CornerDownLeft size={13} />
												</button>
											)}
											<button
												type="button"
												className="gui-connector-example-action"
												title={t("settings.connectorsCopyExample")}
												aria-label={t("settings.connectorsCopyExample")}
												onClick={() => copyExample(example)}
											>
												<Copy size={13} />
											</button>
										</span>
									</li>
								))}
							</ul>
						</div>
					) : null}
					{connector.docsUrl && (
						<button
							type="button"
							className="gui-btn-ghost self-start text-[12px]"
							onClick={() => void openExternalUrl(connector.docsUrl!).catch(() => {})}
						>
							{t("settings.connectorsDocs")}
						</button>
					)}
				</div>
			</div>
		);
	};
	return (
		<>
			<div className="min-w-0">
				<h2 className="gui-settings-page-title">{t("settings.connectors")}</h2>
				<p className="gui-settings-page-desc">{t("settings.connectorsDesc")}</p>
			</div>

			{/* The device sign-in owns its own dialog so it cannot hide behind a
			    row; closing it cancels the pending flow rather than stranding it. */}
			{deviceTarget !== null && (
				<DeviceGrantPanel
					rpc={rpc}
					serverName={`connector:${deviceTarget}`}
					open={deviceTarget !== null}
					originRect={deviceOrigin}
					autoStart
					onClose={() => setDeviceTarget(null)}
					onDone={() => {
						const id = deviceTarget;
						if (!id) return;
						setDeviceTarget(null);
						void enableAfterLogin(`connector:${id}`);
					}}
				/>
			)}

			<div className="flex items-center gap-2">
				<input
					className="gui-input min-w-0 flex-1"
					value={query}
					onChange={event => setQuery(event.target.value)}
					placeholder={t("settings.connectorsSearch")}
					aria-label={t("settings.connectorsSearch")}
				/>
				<button
					type="button"
					className="gui-btn"
					onClick={event => {
						setImportOrigin(event.currentTarget.getBoundingClientRect());
						setImportOpen(true);
					}}
				>
					{t("settings.connectorsImport")}
				</button>
				<button type="button" className="gui-btn" onClick={() => void refresh()}>
					{t("settings.connectorsRefresh")}
				</button>
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
					{connected.length > 0 && category === null && query.trim() === "" && (
						<div className="gui-connector-section">
							<h3 className="gui-settings-section-title">{t("settings.connectorsStatusConnected")}</h3>
							<div className="gui-connector-grid">{connected.map(renderRow)}</div>
						</div>
					)}
					{featured.length > 0 && category === null && (
						<div className="gui-connector-section">
							<h3 className="gui-settings-section-title">{t("settings.connectorsFeatured")}</h3>
							<div className="gui-connector-grid">{featured.map(renderRow)}</div>
						</div>
					)}
					{groups.map(group => {
						const preview = category === null && query.trim() === "";
						const rows = preview ? group.items.slice(0, CONNECTOR_GROUP_PREVIEW) : group.items;
						return (
							<div key={group.key || "other"} className="gui-connector-section">
								<h3 className="gui-settings-section-title">{categoryLabel(group.key)}</h3>
								<div className="gui-connector-grid">{rows.map(renderRow)}</div>
								{preview && group.items.length > CONNECTOR_GROUP_PREVIEW && (
									<button
										type="button"
										className="gui-btn-ghost mt-1 text-[12px]"
										onClick={() => setCategory(group.key)}
									>
										{t("settings.connectorsViewAll", { count: String(group.items.length) })}
									</button>
								)}
							</div>
						);
					})}
				</>
			)}
			<ConnectorImportDialog
				rpc={rpc}
				open={importOpen}
				originRect={importOrigin}
				onClose={() => setImportOpen(false)}
				onImported={() => void load()}
			/>
			<DialogFrame
				open={detailId !== null}
				onClose={() => setDetailId(null)}
				label={detailConnector?.name ?? t("settings.connectors")}
				className="gui-dialog--connector"
				originRect={detailOrigin}
				morphKey={
					detailConnector
						? `${detailConnector.id}:${alternativesOpen}:${tokenTarget === detailConnector.id}:${
								approvalTarget === detailConnector.id
							}:${cliFlow?.connectorId === detailConnector.id ? cliFlow.flowId : ""}:${
								flows[`connector:${detailConnector.id}`]?.kind ?? ""
							}:${probes[detailConnector.id]?.text ?? ""}`
						: ""
				}
			>
				{detailConnector && renderDetail(detailConnector)}
			</DialogFrame>
			<McpServersSection rpc={rpc} />
		</>
	);
}
