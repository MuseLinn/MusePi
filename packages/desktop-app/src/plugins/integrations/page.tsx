import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExtensionItem, SlotComponentProps } from "../../lib/slot-host";
import { Icon } from "../../vendor/oc-icons";
import { selectBuiltinPlugins } from "./builtin-plugins";
import {
	catalogBuiltinPluginIds,
	INTEGRATION_CATALOG,
	INTEGRATION_CATEGORY_LABEL_KEY,
	INTEGRATION_CATEGORY_ORDER,
	INTEGRATION_COMPONENT_LABEL_KEY,
	type IntegrationCall,
	type IntegrationCategory,
	type IntegrationEntry,
	installCall,
	mcpComponent,
	primaryComponent,
	removeCall,
} from "./catalog";

/**
 * Settings → 集成 (Cordis `settings.tab.integrations`): the curated integration
 * catalog plus the builtin-plugin switches. Browsing, searching and filtering
 * are local; installing and removing go through the RPC the entry's primary
 * component names — `mcp.servers.*` for a connector, `extensions.setEnabled`
 * for a bundled plugin, `marketplace.*` / `skills.*` for the other kinds — so
 * this page owns no second registry and no second credential store.
 *
 * A token-typed connector asks for the secret on its card and writes it into
 * that server's `headers`. That is ordinary local configuration — the same
 * place `/mcp add` writes — and never leaves this machine through the GUI.
 *
 * The 「内置插件」 section below the catalog reads `extensions.list`, so a switch
 * shows the daemon's real enablement and nothing is enabled by default. It
 * skips the plugins the catalog already presents as cards: one switch per
 * plugin on this page.
 */

interface McpServerSummary {
	name: string;
	transport?: "stdio" | "http" | "sse";
	url?: string;
	command?: string;
	auth?: "oauth" | "apikey";
	enabled?: boolean;
}

type Notice = { kind: "ok" | "error"; text: string } | null;

/** Catalog-promoted plugins, which the section below must not repeat. */
const PROMOTED_BUILTIN_PLUGIN_IDS = catalogBuiltinPluginIds();

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The success/failure copy for an entry's primary component. */
function actionText(entry: IntegrationEntry, action: "install" | "remove", error?: string): string {
	const name = entry.name;
	if (action === "install") {
		if (primaryComponent(entry).kind === "builtin") {
			return error === undefined
				? t("settings.integrations.builtin.enableSuccess", { name })
				: t("settings.integrations.builtin.enableFailed", { name, error });
		}
		return error === undefined
			? t("settings.integrations.installSuccess", { name })
			: t("settings.integrations.installFailed", { name, error });
	}
	if (primaryComponent(entry).kind === "builtin") {
		return error === undefined
			? t("settings.integrations.builtin.disableSuccess", { name })
			: t("settings.integrations.builtin.disableFailed", { name, error });
	}
	return error === undefined
		? t("settings.integrations.removeSuccess", { name })
		: t("settings.integrations.removeFailed", { name, error });
}

function matchesQuery(entry: IntegrationEntry, query: string): boolean {
	if (query.length === 0) return true;
	const haystack = `${entry.name} ${entry.publisher} ${t(entry.descriptionKey)}`.toLowerCase();
	return haystack.includes(query);
}

export default function IntegrationsPage({ rpc }: SlotComponentProps): ReactNode {
	const [servers, setServers] = useState<McpServerSummary[]>([]);
	const [extensions, setExtensions] = useState<ExtensionItem[]>([]);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState<IntegrationCategory | null>(null);
	const [tokens, setTokens] = useState<Record<string, string>>({});
	const [busyId, setBusyId] = useState<string | null>(null);
	const [notice, setNotice] = useState<Notice>(null);

	const reload = useCallback((): (() => void) | undefined => {
		if (!rpc) {
			setServers([]);
			setExtensions([]);
			setLoadError(null);
			return;
		}
		let alive = true;
		// Two independent sources: a connector-file failure must not blank the
		// plugin switches, and vice versa.
		void Promise.allSettled([
			rpc.request<{ servers?: McpServerSummary[] }>("mcp.servers.list", {}),
			rpc.request<{ extensions?: ExtensionItem[] }>("extensions.list", {}),
		]).then(([mcpResult, extensionResult]) => {
			if (!alive) return;
			const failures: string[] = [];
			setServers(
				mcpResult.status === "fulfilled" && Array.isArray(mcpResult.value?.servers) ? mcpResult.value.servers : [],
			);
			if (mcpResult.status === "rejected") failures.push(errorText(mcpResult.reason));
			setExtensions(
				extensionResult.status === "fulfilled" && Array.isArray(extensionResult.value?.extensions)
					? extensionResult.value.extensions
					: [],
			);
			if (extensionResult.status === "rejected") failures.push(errorText(extensionResult.reason));
			setLoadError(failures.length > 0 ? failures.join("; ") : null);
		});
		return () => {
			alive = false;
		};
	}, [rpc]);

	useEffect(() => {
		const cleanup = reload();
		return () => cleanup?.();
	}, [reload]);

	/**
	 * Entries whose primary component is installed. Connectors and bundled
	 * plugins have a page-local source (`mcp.servers.list`, `extensions.list`);
	 * marketplace plugins and skills are judged by their own manager surfaces,
	 * so a catalog row of those kinds stays on the install side.
	 */
	const installedIds = useMemo(() => {
		const serverNames = new Set(servers.map(server => server.name));
		const pluginStates = new Map(extensions.map(extension => [extension.id, extension.state]));
		const installed = new Set<string>();
		for (const entry of INTEGRATION_CATALOG) {
			const primary = primaryComponent(entry);
			const isInstalled =
				primary.kind === "mcp"
					? serverNames.has(entry.id)
					: primary.kind === "builtin"
						? pluginStates.get(primary.pluginId) === "active"
						: false;
			if (isInstalled) installed.add(entry.id);
		}
		return installed;
	}, [servers, extensions]);

	const normalizedQuery = query.trim().toLowerCase();
	const visibleEntries = useMemo(
		() =>
			INTEGRATION_CATALOG.filter(
				entry => (category === null || entry.categories.includes(category)) && matchesQuery(entry, normalizedQuery),
			),
		[category, normalizedQuery],
	);
	const builtinPlugins = useMemo(() => selectBuiltinPlugins(extensions, PROMOTED_BUILTIN_PLUGIN_IDS), [extensions]);

	const run = (
		id: string,
		call: IntegrationCall,
		copy: { ok: string; failed: (error: string) => string },
		onSuccess?: () => void,
	): void => {
		if (!rpc || busyId) return;
		setBusyId(id);
		setNotice(null);
		rpc.request<{ ok: boolean }>(call.method, call.params)
			.then(() => {
				onSuccess?.();
				setNotice({ kind: "ok", text: copy.ok });
				reload();
			})
			.catch((error: unknown) => setNotice({ kind: "error", text: copy.failed(errorText(error)) }))
			.finally(() => setBusyId(null));
	};

	const install = (entry: IntegrationEntry): void => {
		const token = (tokens[entry.id] ?? "").trim();
		if (mcpComponent(entry)?.auth === "token" && token.length === 0) return;
		run(
			entry.id,
			installCall(entry, token),
			{
				ok: actionText(entry, "install"),
				failed: error => actionText(entry, "install", error),
			},
			() =>
				setTokens(previous => {
					const next = { ...previous };
					delete next[entry.id];
					return next;
				}),
		);
	};

	const remove = (entry: IntegrationEntry): void => {
		const call = removeCall(entry);
		if (!call) return;
		run(entry.id, call, { ok: actionText(entry, "remove"), failed: error => actionText(entry, "remove", error) });
	};

	const toggleBuiltin = (extension: ExtensionItem): void => {
		const next = extension.state !== "active";
		const name = extension.displayName || extension.name;
		run(
			extension.id,
			{ method: "extensions.setEnabled", params: { id: extension.id, enabled: next } },
			next
				? {
						ok: t("settings.integrations.builtin.enableSuccess", { name }),
						failed: error => t("settings.integrations.builtin.enableFailed", { name, error }),
					}
				: {
						ok: t("settings.integrations.builtin.disableSuccess", { name }),
						failed: error => t("settings.integrations.builtin.disableFailed", { name, error }),
					},
		);
	};

	const renderCard = (entry: IntegrationEntry): ReactNode => {
		const mcp = mcpComponent(entry);
		const installed = installedIds.has(entry.id);
		const busy = busyId === entry.id;
		const needsToken = mcp?.auth === "token" && !installed;
		const canInstall = !needsToken || (tokens[entry.id] ?? "").trim().length > 0;
		const canRemove = removeCall(entry) !== null;
		const componentKinds = [...new Set(entry.components.map(component => component.kind))];
		return (
			<article className="gui-integrations-card gui-agent-card" data-integration-id={entry.id} key={entry.id}>
				<div className="gui-integrations-card-main flex items-start gap-3">
					<span
						className="gui-integrations-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--surface-muted)] text-[var(--color-text-muted)]"
						aria-hidden="true"
					>
						<Icon name={entry.icon} className="h-4 w-4" />
					</span>
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-1.5">
							<span className="truncate text-[13px] font-medium">{entry.name}</span>
							{entry.status === "beta" && (
								<span className="gui-provider-chip">{t("settings.integrations.status.beta")}</span>
							)}
							{componentKinds.map(kind => (
								<span className="gui-provider-chip" data-component-kind={kind} key={kind}>
									{t(INTEGRATION_COMPONENT_LABEL_KEY[kind])}
								</span>
							))}
							{mcp && (
								<span className="gui-provider-chip" data-auth-kind={mcp.auth}>
									{mcp.auth === "token"
										? t("settings.integrations.status.token")
										: t("settings.integrations.status.oauth")}
								</span>
							)}
							{installed && (
								<span className="gui-provider-chip" data-installed="true">
									{t("settings.integrations.status.installed")}
								</span>
							)}
						</div>
						<p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">{t(entry.descriptionKey)}</p>
						{needsToken && mcp && (
							<div className="gui-integrations-token-row mt-2 flex flex-wrap items-center gap-2">
								<input
									className="gui-settings-input gui-integrations-token"
									type="password"
									autoComplete="off"
									aria-label={t("settings.integrations.tokenLabel", { name: entry.name })}
									placeholder={t("settings.integrations.tokenPlaceholder")}
									value={tokens[entry.id] ?? ""}
									onInput={event => {
										const value = event.currentTarget.value;
										setTokens(previous => ({ ...previous, [entry.id]: value }));
									}}
								/>
								{mcp.tokenHelpUrl && (
									<a className="gui-connector-link" href={mcp.tokenHelpUrl} target="_blank" rel="noreferrer">
										{t("settings.integrations.tokenHelp")}
									</a>
								)}
								{!canInstall && (
									<span className="gui-settings-field-hint">{t("settings.integrations.tokenRequired")}</span>
								)}
							</div>
						)}
					</div>
					{installed && canRemove ? (
						<button
							type="button"
							className="gui-btn gui-btn--small gui-btn--danger gui-integrations-remove"
							disabled={!rpc || busyId !== null}
							onClick={() => remove(entry)}
						>
							{busy ? t("settings.integrations.action.removing") : t("settings.integrations.action.remove")}
						</button>
					) : (
						<button
							type="button"
							className="gui-btn gui-btn--small gui-btn-primary gui-integrations-install"
							disabled={!rpc || busyId !== null || !canInstall}
							onClick={() => install(entry)}
						>
							{busy ? t("settings.integrations.action.installing") : t("settings.integrations.action.install")}
						</button>
					)}
				</div>
			</article>
		);
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("settings.integrations.title")}</h2>
			<p className="gui-settings-page-desc">{t("settings.integrations.description")}</p>

			<div className="gui-integrations-toolbar mt-3 flex flex-wrap items-center gap-2">
				<div className="relative min-w-0 flex-1">
					<Icon
						name="search"
						className="pointer-events-none absolute inset-y-0 start-2.5 my-auto h-3.5 w-3.5 text-[var(--color-text-faint)]"
						aria-hidden="true"
					/>
					<input
						className="gui-settings-input gui-integrations-search w-full ps-8"
						type="search"
						value={query}
						placeholder={t("settings.integrations.searchPlaceholder")}
						aria-label={t("settings.integrations.searchPlaceholder")}
						onInput={event => setQuery(event.currentTarget.value)}
					/>
				</div>
				<div
					className="gui-integrations-chips flex flex-wrap items-center gap-1.5"
					role="group"
					aria-label={t("settings.integrations.title")}
				>
					<button
						type="button"
						className={`gui-btn gui-btn--small gui-integrations-chip${category === null ? " gui-btn-primary" : ""}`}
						aria-pressed={category === null}
						onClick={() => setCategory(null)}
					>
						{t("settings.integrations.allCategories")}
					</button>
					{INTEGRATION_CATEGORY_ORDER.map(value => (
						<button
							type="button"
							key={value}
							className={`gui-btn gui-btn--small gui-integrations-chip${category === value ? " gui-btn-primary" : ""}`}
							aria-pressed={category === value}
							data-category={value}
							onClick={() => setCategory(current => (current === value ? null : value))}
						>
							{t(INTEGRATION_CATEGORY_LABEL_KEY[value])}
						</button>
					))}
				</div>
			</div>

			<p className="gui-settings-page-desc gui-integrations-local-note mt-2">
				{t("settings.integrations.localNote")}
			</p>

			{notice && (
				<p
					className={`gui-integrations-notice gui-integrations-notice--${notice.kind} mt-2 text-[12px] ${
						notice.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"
					}`}
					role={notice.kind === "error" ? "alert" : "status"}
				>
					{notice.text}
				</p>
			)}
			{loadError !== null && (
				<p
					className="gui-integrations-notice gui-integrations-notice--error mt-2 text-[12px] text-[var(--color-error)]"
					role="alert"
				>
					{t("settings.integrations.loadFailed", { error: loadError ?? "" })}
				</p>
			)}

			{visibleEntries.length === 0 ? (
				<div className="gui-settings-row gui-integrations-empty">{t("settings.integrations.emptyNoMatch")}</div>
			) : (
				<div className="gui-integrations-grid mt-2 grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
					{visibleEntries.map(entry => renderCard(entry))}
				</div>
			)}

			<section className="gui-integrations-builtin mt-5" aria-label={t("settings.integrations.builtin.title")}>
				<div className="gui-settings-section-title">{t("settings.integrations.builtin.title")}</div>
				<p className="gui-settings-page-desc">{t("settings.integrations.builtin.description")}</p>
				{builtinPlugins.length === 0 ? (
					<div className="gui-settings-row gui-integrations-builtin-empty">
						{t("settings.integrations.builtin.empty")}
					</div>
				) : (
					builtinPlugins.map(extension => {
						const enabled = extension.state === "active";
						return (
							<div
								className="gui-agent-card gui-integrations-builtin-row mt-1.5 flex items-center gap-3"
								data-builtin-plugin-id={extension.id}
								key={extension.id}
							>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-1.5">
										<span className="truncate text-[13px] font-medium">
											{extension.displayName || extension.name}
										</span>
										{extension.experimental && (
											<span className="gui-provider-chip">{t("settings.integrations.status.beta")}</span>
										)}
										<span className="gui-provider-chip" data-builtin-state={enabled ? "on" : "off"}>
											{enabled
												? t("settings.integrations.builtin.state.on")
												: t("settings.integrations.builtin.state.off")}
										</span>
									</div>
									{extension.description && (
										<p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
											{extension.description}
										</p>
									)}
								</div>
								<button
									type="button"
									role="switch"
									aria-checked={enabled}
									aria-label={extension.displayName || extension.name}
									className={`gui-toggle gui-integrations-builtin-toggle${enabled ? " gui-toggle--on" : ""}`}
									disabled={!rpc || busyId !== null}
									onClick={() => toggleBuiltin(extension)}
								/>
							</div>
						);
					})
				)}
			</section>
		</>
	);
}
