import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SlotComponentProps } from "../../lib/slot-host";
import { Icon } from "../../vendor/oc-icons";
import {
	INTEGRATION_CATALOG,
	INTEGRATION_CATEGORY_LABEL_KEY,
	INTEGRATION_CATEGORY_ORDER,
	type IntegrationCategory,
	type IntegrationEntry,
} from "./catalog";

/**
 * Settings → 集成 (Cordis `settings.tab.integrations`): the curated connector
 * catalog. Browsing, searching and filtering are local; installing and removing
 * go through `mcp.servers.*`, which owns the user-scope `<agentDir>/mcp.json`.
 *
 * A token-typed entry asks for the secret on its card and writes it into that
 * server's `headers`. That is ordinary local configuration — the same place
 * `/mcp add` writes — and never leaves this machine through the GUI.
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

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function authLabel(entry: IntegrationEntry): string {
	return entry.auth === "token" ? t("settings.integrations.status.token") : t("settings.integrations.status.oauth");
}

function matchesQuery(entry: IntegrationEntry, query: string): boolean {
	if (query.length === 0) return true;
	const haystack = `${entry.name} ${entry.publisher} ${t(entry.descriptionKey)}`.toLowerCase();
	return haystack.includes(query);
}

export default function IntegrationsPage({ rpc }: SlotComponentProps): ReactNode {
	const [servers, setServers] = useState<McpServerSummary[]>([]);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState<IntegrationCategory | null>(null);
	const [tokens, setTokens] = useState<Record<string, string>>({});
	const [busyId, setBusyId] = useState<string | null>(null);
	const [notice, setNotice] = useState<Notice>(null);

	const reload = useCallback((): (() => void) | undefined => {
		if (!rpc) {
			setServers([]);
			setLoadError(null);
			return;
		}
		let alive = true;
		rpc.request<{ servers?: McpServerSummary[] }>("mcp.servers.list", {})
			.then(result => {
				if (!alive) return;
				setServers(Array.isArray(result?.servers) ? result.servers : []);
				setLoadError(null);
			})
			.catch((error: unknown) => {
				if (!alive) return;
				setServers([]);
				setLoadError(errorText(error));
			});
		return () => {
			alive = false;
		};
	}, [rpc]);

	useEffect(() => {
		const cleanup = reload();
		return () => cleanup?.();
	}, [reload]);
	const installedNames = useMemo(() => new Set(servers.map(server => server.name)), [servers]);
	const normalizedQuery = query.trim().toLowerCase();
	const visibleEntries = useMemo(
		() =>
			INTEGRATION_CATALOG.filter(
				entry => (category === null || entry.categories.includes(category)) && matchesQuery(entry, normalizedQuery),
			),
		[category, normalizedQuery],
	);

	const install = (entry: IntegrationEntry): void => {
		if (!rpc || busyId) return;
		const token = (tokens[entry.id] ?? "").trim();
		if (entry.auth === "token" && token.length === 0) return;
		const headers =
			entry.auth === "token" && entry.tokenHeader
				? { [entry.tokenHeader.name]: `${entry.tokenHeader.valuePrefix ?? ""}${token}` }
				: undefined;
		setBusyId(entry.id);
		setNotice(null);
		rpc.request<{ ok: boolean }>("mcp.servers.add", {
			name: entry.id,
			url: entry.url,
			headers,
			auth: entry.auth === "oauth" ? { type: "oauth" } : undefined,
		})
			.then(() => {
				setTokens(previous => {
					const next = { ...previous };
					delete next[entry.id];
					return next;
				});
				setNotice({ kind: "ok", text: t("settings.integrations.installSuccess", { name: entry.name }) });
				reload();
			})
			.catch((error: unknown) =>
				setNotice({
					kind: "error",
					text: t("settings.integrations.installFailed", { name: entry.name, error: errorText(error) }),
				}),
			)
			.finally(() => setBusyId(null));
	};

	const remove = (entry: IntegrationEntry): void => {
		if (!rpc || busyId) return;
		setBusyId(entry.id);
		setNotice(null);
		rpc.request<{ ok: boolean }>("mcp.servers.remove", { name: entry.id })
			.then(() => {
				setNotice({ kind: "ok", text: t("settings.integrations.removeSuccess", { name: entry.name }) });
				reload();
			})
			.catch((error: unknown) =>
				setNotice({
					kind: "error",
					text: t("settings.integrations.removeFailed", { name: entry.name, error: errorText(error) }),
				}),
			)
			.finally(() => setBusyId(null));
	};

	const renderCard = (entry: IntegrationEntry): ReactNode => {
		const installed = installedNames.has(entry.id);
		const busy = busyId === entry.id;
		const needsToken = entry.auth === "token" && !installed;
		const canInstall = !needsToken || (tokens[entry.id] ?? "").trim().length > 0;
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
							<span className="gui-provider-chip">{authLabel(entry)}</span>
							{installed && (
								<span className="gui-provider-chip" data-installed="true">
									{t("settings.integrations.status.installed")}
								</span>
							)}
						</div>
						<p className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">{t(entry.descriptionKey)}</p>
						{needsToken && (
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
								{entry.tokenHelpUrl && (
									<a className="gui-connector-link" href={entry.tokenHelpUrl} target="_blank" rel="noreferrer">
										{t("settings.integrations.tokenHelp")}
									</a>
								)}
								{!canInstall && (
									<span className="gui-settings-field-hint">{t("settings.integrations.tokenRequired")}</span>
								)}
							</div>
						)}
					</div>
					{installed ? (
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
		</>
	);
}
