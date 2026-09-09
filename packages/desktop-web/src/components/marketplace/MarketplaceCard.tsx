import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { type MarketplaceCardAction, type MarketplaceCardEntry, resolveCardIcon } from "./types";

/**
 * Single plugin card used by the marketplace grid. Pure presentational
 * component — no data fetching, no install calls. Parents pass `installed`
 * and `busy` flags so the card renders the right affordance without
 * knowing the install pipeline.
 *
 * Visual design follows the host palette (--bg-raised surface, --accent
 * border on hover, --fg-muted metadata, --font-mono for the version
 * stamp). No raw colors — everything routes through design tokens so the
 * dark/light theme switches cleanly.
 */

export interface MarketplaceCardProps {
	entry: MarketplaceCardEntry;
	/** Fires when the user clicks the card body / "Details" affordance. */
	onAction?(action: MarketplaceCardAction): void;
	/** Subset of actions to render; defaults to all of them. */
	actions?: ReadonlyArray<"install" | "remove" | "open">;
	className?: string;
}

const DEFAULT_ACTIONS: ReadonlyArray<"install" | "remove" | "open"> = ["install", "remove", "open"];

function shortNumber(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function MarketplaceCard({
	entry,
	onAction,
	actions = DEFAULT_ACTIONS,
	className,
}: MarketplaceCardProps): ReactNode {
	const icon = resolveCardIcon(entry);
	const isInstalled = entry.installed === true;
	const isBusy = entry.busy === true;
	const classes = ["mp-card", isInstalled ? "mp-card--installed" : "", className ?? ""].filter(Boolean).join(" ");

	const fire = (kind: MarketplaceCardAction["kind"]) => (): void => {
		if (isBusy) return;
		onAction?.({ kind, entry });
	};

	const installable = !isInstalled && actions.includes("install");
	const removable = isInstalled && actions.includes("remove");
	const openable = actions.includes("open");

	return (
		<article className={classes} data-marketplace={entry.marketplace ?? ""} data-busy={isBusy ? "true" : "false"}>
			<button
				type="button"
				className="mp-card-face"
				onClick={fire("open")}
				disabled={isBusy}
				aria-label={`${entry.name} details`}
			>
				<span className="mp-card-icon" aria-hidden="true">
					{icon}
				</span>
				<span className="mp-card-body">
					<span className="mp-card-head">
						<span className="mp-card-name">{entry.name}</span>
						{entry.version !== undefined && entry.version.length > 0 && (
							<span className="mp-card-version">v{entry.version}</span>
						)}
					</span>
					{entry.description !== undefined && entry.description.length > 0 && (
						<span className="mp-card-desc">{entry.description}</span>
					)}
					<span className="mp-card-meta">
						{entry.author !== undefined && entry.author.length > 0 && (
							<span className="mp-card-meta-item">by {entry.author}</span>
						)}
						{typeof entry.installs === "number" && (
							<span className="mp-card-meta-item">↓ {shortNumber(entry.installs)}</span>
						)}
						{entry.category !== undefined && entry.category.length > 0 && (
							<span className="mp-card-chip">{entry.category}</span>
						)}
						{entry.license !== undefined && entry.license.length > 0 && (
							<span className="mp-card-chip">{entry.license}</span>
						)}
					</span>
				</span>
			</button>
			<footer className="mp-card-actions">
				{openable && (
					<button type="button" className="mp-btn mp-btn--ghost" onClick={fire("open")} disabled={isBusy}>
						{t("plugin details")}
					</button>
				)}
				{installable && (
					<button type="button" className="mp-btn mp-btn--accent" onClick={fire("install")} disabled={isBusy}>
						{isBusy ? t("plugin installing") : t("plugin install")}
					</button>
				)}
				{removable && (
					<button type="button" className="mp-btn mp-btn--warn" onClick={fire("remove")} disabled={isBusy}>
						{isBusy ? t("plugin removing") : t("plugin remove")}
					</button>
				)}
			</footer>
		</article>
	);
}
