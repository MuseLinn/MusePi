import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { t } from "../../i18n/index.js";
import { MarketplaceCard } from "./MarketplaceCard";
import type { MarketplaceCardAction, MarketplaceCardEntry } from "./types";
import "./marketplace.css";

/**
 * Marketplace grid container — fetches the plugin catalog via
 * `client.rpc("marketplace.list", ...)` (when {@link client} is provided),
 * groups entries by marketplace, and lets the user filter by category or
 * free text. Falls back to the supplied {@link entries} when no client is
 * available, which keeps storybook / unit tests straightforward.
 *
 * State: filter input, optional category chip selection, refresh button.
 * Busy state per card lives on the entry itself (`entry.busy`) so the
 * grid doesn't have to track a parallel map.
 */

export interface MarketplaceGridProps {
	/** Pre-loaded entries; used when `client` is null. */
	entries?: readonly MarketplaceCardEntry[];
	/** Optional RPC client. When set, the grid fetches on mount and refresh. */
	client?: {
		rpc<T>(method: string, params?: unknown): Promise<T>;
	} | null;
	/** Fires for install/remove/open actions; routing back to the host. */
	onAction?(action: MarketplaceCardAction): Promise<void> | void;
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

export function MarketplaceGrid({
	entries: initialEntries,
	client,
	onAction,
	loading,
}: MarketplaceGridProps): ReactNode {
	const [entries, setEntries] = useState<readonly MarketplaceCardEntry[]>(initialEntries ?? []);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [fetching, setFetching] = useState(false);
	const [filter, setFilter] = useState("");
	const [category, setCategory] = useState<string | null>(null);

	const refresh = async (): Promise<void> => {
		if (!client) return;
		setFetching(true);
		setFetchError(null);
		try {
			const res = await client.rpc<{ entries: MarketplaceCardEntry[] }>("marketplace.list");
			setEntries(res.entries);
		} catch (err) {
			setFetchError(err instanceof Error ? err.message : String(err));
		} finally {
			setFetching(false);
		}
	};

	const filtered = useMemo(() => {
		const q = filter.trim().toLowerCase();
		return entries.filter(entry => {
			if (category !== null) {
				const cats = [entry.category ?? "", ...(entry.tags ?? [])].map(s => s.toLowerCase());
				if (!cats.includes(category)) return false;
			}
			if (q.length === 0) return true;
			const haystack =
				`${entry.name} ${entry.description ?? ""} ${entry.author ?? ""} ${(entry.tags ?? []).join(" ")}`.toLowerCase();
			return haystack.includes(q);
		});
	}, [entries, filter, category]);

	const grouped = useMemo(() => groupByMarketplace(filtered), [filtered]);
	const allCategories = useMemo(() => extractCategories(entries), [entries]);

	const showLoading = loading === true || (client !== undefined && fetching);

	return (
		<div className="mp-grid-shell">
			<header className="mp-grid-toolbar">
				<input
					type="search"
					className="mp-search"
					placeholder={t("plugin search placeholder")}
					value={filter}
					onChange={e => setFilter(e.target.value)}
					aria-label={t("plugin search label")}
				/>
				<button
					type="button"
					className="mp-btn mp-btn--ghost"
					onClick={() => void refresh()}
					disabled={!client || showLoading}
				>
					{showLoading ? t("plugin refreshing") : t("plugin refresh")}
				</button>
			</header>

			{allCategories.length > 0 && (
				<div className="mp-filter-bar" role="group" aria-label={t("filter by category")}>
					<button
						type="button"
						className={`mp-chip ${category === null ? "mp-chip--active" : ""}`}
						onClick={() => setCategory(null)}
					>
						{t("all categories")}
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

			{fetchError !== null && <p className="mp-error">Failed to load plugins: {fetchError}</p>}

			{!showLoading && grouped.length === 0 && <p className="mp-empty">No plugins match the current filter.</p>}

			{grouped.map(section => (
				<section key={section.marketplace} className="mp-section">
					{grouped.length > 1 && <h2 className="mp-section-title">{section.marketplace}</h2>}
					<div className="mp-grid">
						{section.entries.map(entry => (
							<MarketplaceCard
								key={`${section.marketplace}/${entry.name}`}
								entry={entry}
								onAction={a => {
									void onAction?.(a);
								}}
							/>
						))}
					</div>
				</section>
			))}
		</div>
	);
}
