import { PackageOpen, RefreshCw, Search, SearchX } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { loadMarketplaceViewPreferences, saveMarketplaceViewPreferences } from "../../lib/marketplace-preferences";
import { useScrollShadow } from "../../lib/scroll-shadow";
import { MarketplaceCard } from "./MarketplaceCard";
import type { MarketplaceCardAction, MarketplaceCardEntry, MarketplaceSource } from "./types";
import "./marketplace.css";
import "./marketplace-visual.css";

/**
 * Marketplace grid container — fetches the plugin catalog via
 * `client.rpc("marketplace.list", ...)` (when {@link client} is provided),
 * groups entries by marketplace, and lets the user filter by category or
 * free text. Falls back to the supplied {@link entries} when no client is
 * available, which keeps storybook / unit tests straightforward.
 *
 * With a client the grid splits into three segments — installed / catalog /
 * custom sources — so update badges, the catalog browser, and source
 * management (add/remove/refresh `marketplace.sources.*`) each get one
 * place. Without a client the grid degrades to the flat catalog listing.
 *
 * State: segment, filter input, optional category chip selection, refresh
 * button. Busy state per card lives on the entry itself (`entry.busy`) so
 * the grid doesn't have to track a parallel map.
 */

type MarketplaceSegment = "installed" | "catalog" | "sources";

export interface MarketplaceGridProps {
	/** Pre-loaded entries; used when `client` is null. */
	entries?: readonly MarketplaceCardEntry[];
	/** Optional RPC client. When set, the grid fetches on mount and refresh. */
	client?: {
		rpc<T>(method: string, params?: unknown): Promise<T>;
	} | null;
	/** Fires for install/remove/upgrade/open actions; routing back to the host. */
	onAction?(action: MarketplaceCardAction): Promise<void> | void;
	/** Optional host hook for the bulk upgrade button, receiving the update
	 *  count so the host can confirm it. Without it the grid calls
	 *  `marketplace.upgrade` directly. */
	onUpgradeAll?(count: number): Promise<void> | void;
	/** Optional placeholder when no client is wired (testing/storybook). */
	loading?: boolean;
}

interface GroupedSection {
	marketplace: string;
	entries: MarketplaceCardEntry[];
}

function groupByMarketplace(entries: readonly MarketplaceCardEntry[]): GroupedSection[] {
	const map = new Map<string, MarketplaceCardEntry[]>();
	for (const entry of entries) {
		const key = entry.marketplace ?? "default";
		const bucket = map.get(key);
		if (bucket !== undefined) bucket.push(entry);
		else map.set(key, [entry]);
	}
	return Array.from(map.entries()).map(([marketplace, items]) => ({ marketplace, entries: items }));
}

function extractCategories(entries: readonly MarketplaceCardEntry[]): string[] {
	const seen = new Set<string>();
	for (const entry of entries) {
		if (entry.category !== undefined && entry.category.length > 0) seen.add(entry.category.toLowerCase());
		for (const tag of entry.tags ?? []) seen.add(tag.toLowerCase());
	}
	return Array.from(seen).sort();
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function MarketplaceGrid({
	entries: initialEntries,
	client,
	onAction,
	onUpgradeAll,
	loading,
}: MarketplaceGridProps): ReactNode {
	const [entries, setEntries] = useState<readonly MarketplaceCardEntry[]>(initialEntries ?? []);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [fetching, setFetching] = useState(false);
	const [initialPreferences] = useState(loadMarketplaceViewPreferences);
	const [segment, setSegment] = useState<MarketplaceSegment>(initialPreferences.segment);
	const [filter, setFilter] = useState(initialPreferences.filter);
	const [category, setCategory] = useState<string | null>(initialPreferences.category);
	const [sources, setSources] = useState<readonly MarketplaceSource[] | null>(null);
	const [sourcesError, setSourcesError] = useState<string | null>(null);
	const [sourceInput, setSourceInput] = useState("");
	const [sourceBusy, setSourceBusy] = useState(false);
	const [upgradingAll, setUpgradingAll] = useState(false);

	useEffect(() => {
		saveMarketplaceViewPreferences({ segment, filter, category });
	}, [segment, filter, category]);

	// Controlled mode: when the host supplies entries without a client
	// (storybook / tests / pre-fetched data), mirror prop changes into state
	// so refreshes and busy flags driven by the host actually render.
	useEffect(() => {
		if (client == null && initialEntries !== undefined) setEntries(initialEntries);
	}, [client, initialEntries]);

	const refresh = useCallback(async (): Promise<void> => {
		if (client == null) return;
		setFetching(true);
		setFetchError(null);
		try {
			const res = await client.rpc<{ entries: MarketplaceCardEntry[] }>("marketplace.list");
			setEntries(res.entries);
		} catch (err) {
			setFetchError(errorMessage(err));
		} finally {
			setFetching(false);
		}
	}, [client]);

	// Fetch the catalog on mount (and whenever the client identity changes)
	// so the grid is self-sufficient whenever an RPC client is wired.
	useEffect(() => {
		if (client == null) return;
		let alive = true;
		void (async () => {
			setFetching(true);
			setFetchError(null);
			try {
				const res = await client.rpc<{ entries: MarketplaceCardEntry[] }>("marketplace.list");
				if (alive) setEntries(res.entries);
			} catch (err) {
				if (alive) setFetchError(errorMessage(err));
			} finally {
				if (alive) setFetching(false);
			}
		})();
		return () => {
			alive = false;
		};
	}, [client]);

	const loadSources = useCallback(async (): Promise<void> => {
		if (client == null) return;
		try {
			const res = await client.rpc<{ sources: MarketplaceSource[] }>("marketplace.sources.list");
			setSources(res.sources ?? []);
			setSourcesError(null);
		} catch (err) {
			setSourcesError(errorMessage(err));
		}
	}, [client]);

	// Sources are only fetched when their segment opens: the catalog tab
	// must not pay for a registry read it never renders.
	useEffect(() => {
		if (client == null || segment !== "sources") return;
		void loadSources();
	}, [client, segment, loadSources]);

	const runSourceMutation = async (mutation: () => Promise<void>): Promise<void> => {
		setSourceBusy(true);
		setSourcesError(null);
		try {
			await mutation();
			await loadSources();
			// The catalog changed (added/refreshed/removed source): re-pull the
			// entry list so the catalog segment matches the new registry.
			await refresh();
		} catch (err) {
			setSourcesError(errorMessage(err));
		} finally {
			setSourceBusy(false);
		}
	};

	const addSource = (): Promise<void> => {
		const source = sourceInput.trim();
		if (client == null || source.length === 0) return Promise.resolve();
		return runSourceMutation(async () => {
			await client.rpc("marketplace.sources.add", { source });
			setSourceInput("");
		});
	};

	const removeSource = (name: string): Promise<void> => {
		if (client == null) return Promise.resolve();
		return runSourceMutation(async () => {
			await client.rpc("marketplace.sources.remove", { name });
		});
	};

	const refreshSource = async (name?: string): Promise<void> => {
		if (client == null) return;
		setSourceBusy(true);
		setSourcesError(null);
		try {
			// The refresh response already carries the refreshed source list, so
			// no second sources.list round-trip is needed. Failures are applied
			// after the catalog refresh so the message is not cleared by it.
			const res = await client.rpc<{ sources: MarketplaceSource[]; failures: string[] }>(
				"marketplace.sources.refresh",
				name === undefined ? {} : { name },
			);
			setSources(res.sources ?? []);
			await refresh();
			if ((res.failures ?? []).length > 0) setSourcesError(res.failures.join("\n"));
		} catch (err) {
			setSourcesError(errorMessage(err));
		} finally {
			setSourceBusy(false);
		}
	};

	const upgradeAll = async (): Promise<void> => {
		setUpgradingAll(true);
		setFetchError(null);
		try {
			if (onUpgradeAll) await onUpgradeAll(updateCount);
			else if (client != null) await client.rpc("marketplace.upgrade", { all: true });
			if (client != null) await refresh();
		} catch (err) {
			setFetchError(errorMessage(err));
		} finally {
			setUpgradingAll(false);
		}
	};

	// Card actions run with a busy flag on the affected entry; on success the
	// grid re-pulls the catalog (when a client is wired) so installed state
	// flips without the host having to thread a refresh back in.
	const runAction = async (action: MarketplaceCardAction): Promise<void> => {
		const key = `${action.entry.marketplace ?? "default"}/${action.entry.name}`;
		const markBusy = (busy: boolean): void => {
			setEntries(prev => prev.map(e => (`${e.marketplace ?? "default"}/${e.name}` === key ? { ...e, busy } : e)));
		};
		markBusy(true);
		try {
			await onAction?.(action);
			if (client != null) await refresh();
			else markBusy(false);
		} catch (err) {
			setFetchError(errorMessage(err));
			markBusy(false);
		}
	};

	const installedCount = useMemo(() => entries.filter(e => e.installed === true).length, [entries]);
	const updateCount = useMemo(
		() => entries.filter(e => e.installed === true && e.updateAvailable === true).length,
		[entries],
	);

	const scopedEntries = useMemo(
		() => (segment === "installed" ? entries.filter(e => e.installed === true) : entries),
		[entries, segment],
	);

	const filtered = useMemo(() => {
		const q = filter.trim().toLowerCase();
		return scopedEntries.filter(entry => {
			if (category !== null) {
				const cats = [entry.category ?? "", ...(entry.tags ?? [])].map(s => s.toLowerCase());
				if (!cats.includes(category)) return false;
			}
			if (q.length === 0) return true;
			const haystack =
				`${entry.name} ${entry.description ?? ""} ${entry.author ?? ""} ${(entry.tags ?? []).join(" ")}`.toLowerCase();
			return haystack.includes(q);
		});
	}, [scopedEntries, filter, category]);

	const grouped = useMemo(() => groupByMarketplace(filtered), [filtered]);
	const allCategories = useMemo(() => extractCategories(scopedEntries), [scopedEntries]);
	const hasFilter = filter.trim().length > 0 || category !== null;
	const clearFilters = (): void => {
		setFilter("");
		setCategory(null);
	};
	// 纵向边缘羽化:卡片网格长列表溢出时上下羽化。
	const shellRef = useRef<HTMLDivElement | null>(null);
	useScrollShadow(shellRef);

	// Skeleton only on the initial catalog load — a refresh over existing
	// entries keeps the cards in place (the toolbar spinner carries the
	// feedback) so installing doesn't flash the whole grid away.
	const showLoading = loading === true || (client !== undefined && fetching);
	const initialLoad = loading === true || (client !== undefined && fetching && entries.length === 0);
	const showSegments = client != null;
	const showCatalogControls = segment !== "sources";
	const sourcesLoading = sources === null && sourcesError === null;

	return (
		<div ref={shellRef} className="mp-grid-shell" aria-busy={showLoading ? "true" : "false"}>
			<header className="mp-grid-toolbar">
				{showCatalogControls && (
					<label className="mp-search-field">
						<Search size={14} strokeWidth={2} aria-hidden="true" />
						<input
							type="search"
							className="mp-search"
							placeholder={t("guest.pluginSearchPlaceholder")}
							value={filter}
							onChange={e => setFilter(e.target.value)}
							aria-label={t("guest.pluginSearchLabel")}
						/>
					</label>
				)}
				{showCatalogControls ? (
					<>
						{showSegments && updateCount > 0 && (
							<button
								type="button"
								className="mp-btn mp-btn--accent"
								onClick={() => void upgradeAll()}
								disabled={showLoading || upgradingAll}
							>
								{upgradingAll ? t("guest.pluginUpgrading") : t("guest.pluginUpgradeAll")}
							</button>
						)}
						<button
							type="button"
							className="mp-btn mp-btn--ghost"
							onClick={() => void refresh()}
							disabled={!client || showLoading}
							data-loading={showLoading ? "true" : "false"}
						>
							{showLoading ? t("guest.pluginRefreshing") : t("guest.pluginRefresh")}
						</button>
					</>
				) : (
					<button
						type="button"
						className="mp-btn mp-btn--ghost"
						onClick={() => void refreshSource()}
						disabled={sourceBusy}
					>
						<RefreshCw size={12} strokeWidth={2} aria-hidden="true" />
						{t("guest.pluginRefresh")}
					</button>
				)}
			</header>

			{showSegments && (
				<div className="mp-segments" role="tablist" aria-label={t("guest.marketplaceSegmentsLabel")}>
					{(
						[
							["installed", t("guest.marketplaceSegmentInstalled"), installedCount],
							["catalog", t("guest.marketplaceSegmentCatalog"), entries.length],
							["sources", t("guest.marketplaceSegmentSources"), sources?.length ?? null],
						] as const
					).map(([id, label, count]) => (
						<button
							key={id}
							type="button"
							role="tab"
							aria-selected={segment === id}
							className={`mp-segment${segment === id ? " mp-segment--active" : ""}`}
							onClick={() => setSegment(id)}
						>
							{label}
							{count !== null && <span className="mp-segment-count">{count}</span>}
						</button>
					))}
				</div>
			)}

			{showCatalogControls && allCategories.length > 0 && (
				<div className="mp-filter-bar" role="group" aria-label={t("guest.filterCategory")}>
					<button
						type="button"
						className={`mp-chip ${category === null ? "mp-chip--active" : ""}`}
						onClick={() => setCategory(null)}
					>
						{t("guest.allCategories")}
					</button>
					{allCategories.map(c => (
						<button
							key={c}
							type="button"
							className={`mp-chip ${category === c ? "mp-chip--active" : ""}`}
							onClick={() => setCategory(category === c ? null : c)}
						>
							{c}
						</button>
					))}
				</div>
			)}

			{showCatalogControls && fetchError !== null && (
				<p className="mp-error">Failed to load plugins: {fetchError}</p>
			)}

			{segment === "sources" ? (
				<section className="mp-sources" aria-label={t("guest.marketplaceSegmentSources")}>
					<form
						className="mp-source-add"
						onSubmit={e => {
							e.preventDefault();
							void addSource();
						}}
					>
						<input
							type="text"
							className="mp-source-input"
							placeholder={t("guest.marketplaceSourcePlaceholder")}
							value={sourceInput}
							onChange={e => setSourceInput(e.target.value)}
							aria-label={t("guest.marketplaceSourcePlaceholder")}
							disabled={sourceBusy}
						/>
						<button
							type="submit"
							className="mp-btn mp-btn--accent"
							disabled={sourceBusy || sourceInput.trim().length === 0}
						>
							{t("guest.marketplaceSourceAdd")}
						</button>
					</form>
					{sourcesError !== null && <p className="mp-error">{sourcesError}</p>}
					{sourcesLoading && <div className="mp-skeleton-line" aria-hidden="true" />}
					{!sourcesLoading && sources !== null && sources.length === 0 && (
						<div className="mp-empty" role="status">
							<span className="mp-empty-mark" aria-hidden="true">
								<PackageOpen size={18} strokeWidth={1.6} />
							</span>
							<p className="mp-empty-title">{t("guest.marketplaceSourcesEmpty")}</p>
						</div>
					)}
					{sources !== null && sources.length > 0 && (
						<ul className="mp-source-list">
							{sources.map(source => (
								<li key={source.name} className="mp-source-row">
									<span className="mp-source-body">
										<span className="mp-source-head">
											<span className="mp-source-name">{source.name}</span>
											<span className="mp-card-chip">{source.sourceType}</span>
										</span>
										<span className="mp-source-uri" title={source.sourceUri}>
											{source.sourceUri}
										</span>
									</span>
									<button
										type="button"
										className="mp-btn mp-btn--ghost"
										disabled={sourceBusy}
										onClick={() => void refreshSource(source.name)}
									>
										{t("guest.pluginRefresh")}
									</button>
									<button
										type="button"
										className="mp-btn mp-btn--warn"
										disabled={sourceBusy}
										onClick={() => void removeSource(source.name)}
									>
										{t("guest.pluginRemove")}
									</button>
								</li>
							))}
						</ul>
					)}
				</section>
			) : (
				<>
					{initialLoad && (
						<div className="mp-skeleton-grid" aria-hidden="true">
							{[0, 1, 2, 3, 4, 5].map(i => (
								<div key={i} className="mp-skeleton-card">
									<div className="mp-skeleton-line mp-skeleton-line--title" />
									<div className="mp-skeleton-line" />
									<div className="mp-skeleton-line mp-skeleton-line--meta" />
									<div className="mp-skeleton-line mp-skeleton-line--actions" />
								</div>
							))}
						</div>
					)}

					{!showLoading && fetchError === null && grouped.length === 0 && (
						<div className="mp-empty" role="status">
							<span className="mp-empty-mark" aria-hidden="true">
								{hasFilter ? (
									<SearchX size={18} strokeWidth={1.6} />
								) : (
									<PackageOpen size={18} strokeWidth={1.6} />
								)}
							</span>
							<p className="mp-empty-title">
								{hasFilter
									? t("guest.pluginEmptyTitle")
									: segment === "installed"
										? t("guest.marketplaceNoInstalled")
										: t("guest.noPluginsYet")}
							</p>
							{hasFilter && (
								<button type="button" className="mp-btn mp-btn--ghost" onClick={clearFilters}>
									{t("guest.pluginEmptyClear")}
								</button>
							)}
						</div>
					)}

					{!initialLoad &&
						grouped.map(section => (
							<section key={section.marketplace} className="mp-section">
								{grouped.length > 1 && <h2 className="mp-section-title">{section.marketplace}</h2>}
								<div className="mp-grid">
									{section.entries.map((entry, i) => (
										<MarketplaceCard
											key={`${section.marketplace}/${entry.name}`}
											entry={entry}
											index={i}
											onAction={a => {
												void runAction(a);
											}}
										/>
									))}
								</div>
							</section>
						))}
				</>
			)}
		</div>
	);
}
