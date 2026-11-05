import { Check, Download, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import {
	hasDesignSystemContent,
	type MarketplaceCardAction,
	type MarketplaceCardEntry,
	resolveCardIcon,
} from "./types";
import "./marketplace-visual.css";

/**
 * Single plugin card used by the marketplace grid. Pure presentational
 * component — no data fetching, no install calls. Parents pass `installed`,
 * `installedVersion`, `updateAvailable` and `busy` flags so the card renders
 * the right affordance without knowing the install pipeline.
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
	actions?: ReadonlyArray<"install" | "remove" | "upgrade" | "open">;
	className?: string;
	/** Position within the grid; drives the entrance stagger delay. */
	index?: number;
}

const DEFAULT_ACTIONS: ReadonlyArray<"install" | "remove" | "upgrade" | "open"> = [
	"install",
	"remove",
	"upgrade",
	"open",
];

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
	index = 0,
}: MarketplaceCardProps): ReactNode {
	const Icon = resolveCardIcon(entry);
	const isInstalled = entry.installed === true;
	const isBusy = entry.busy === true;
	const hasUpdate = isInstalled && entry.updateAvailable === true;
	const classes = [
		"mp-card",
		isInstalled ? "mp-card--installed" : "",
		hasUpdate ? "mp-card--update" : "",
		className ?? "",
	]
		.filter(Boolean)
		.join(" ");

	const fire = (kind: MarketplaceCardAction["kind"]) => (): void => {
		if (isBusy) return;
		onAction?.({ kind, entry });
	};

	const installable = !isInstalled && actions.includes("install");
	const upgradable = hasUpdate && actions.includes("upgrade");
	const removable = isInstalled && actions.includes("remove");
	const openable = actions.includes("open");

	// One version stamp per card: an update reads as "installed → catalog",
	// an up-to-date install keeps the version in its badge, and an
	// uninstalled entry shows what installing would deliver.
	const versionLabel = hasUpdate
		? `v${entry.installedVersion ?? "?"} → v${entry.version ?? "?"}`
		: isInstalled
			? undefined
			: entry.version !== undefined && entry.version.length > 0
				? `v${entry.version}`
				: undefined;

	return (
		<article
			className={classes}
			data-marketplace={entry.marketplace ?? ""}
			data-busy={isBusy ? "true" : "false"}
			style={{ ["--mp-i" as string]: String(index) }}
		>
			<button
				type="button"
				className="mp-card-face"
				onClick={fire("open")}
				disabled={isBusy}
				aria-label={`${entry.name} details`}
			>
				<span className="mp-card-icon" aria-hidden="true">
					<Icon size={18} strokeWidth={1.75} />
				</span>
				<span className="mp-card-body">
					<span className="mp-card-head">
						<span className="mp-card-name">{entry.name}</span>
						{versionLabel !== undefined && <span className="mp-card-version">{versionLabel}</span>}
					</span>
					{entry.description !== undefined && entry.description.length > 0 && (
						<span className="mp-card-desc">{entry.description}</span>
					)}
					<span className="mp-card-meta">
						{isInstalled && (
							<span className="mp-card-badge">
								<Check size={11} strokeWidth={2.5} aria-hidden="true" />
								{entry.installedVersion !== undefined && entry.installedVersion.length > 0
									? t("guest.pluginInstalledVersionBadge", { version: entry.installedVersion })
									: t("guest.pluginInstalledBadge")}
							</span>
						)}
						{hasUpdate && (
							<span className="mp-card-badge mp-card-badge--update">
								<RefreshCw size={10} strokeWidth={2.4} aria-hidden="true" />
								{t("guest.pluginUpdateBadge")}
							</span>
						)}
						{/* 设计体系内容标识（M3.7d）：catalog 声明 category/tags =
						 *  design-system 的包在能力中心市场 tab 带徽章，可发现。 */}
						{hasDesignSystemContent(entry) && (
							<span className="mp-card-badge mp-card-badge--ds">{t("guest.mpBadgeDesignSystem")}</span>
						)}
						{entry.author !== undefined && entry.author.length > 0 && (
							<span className="mp-card-meta-item">{t("guest.pluginAuthorBy", { author: entry.author })}</span>
						)}
						{typeof entry.installs === "number" && (
							<span className="mp-card-meta-item">
								<Download size={11} strokeWidth={1.9} aria-hidden="true" />
								{shortNumber(entry.installs)}
							</span>
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
						{t("guest.pluginDetails")}
					</button>
				)}
				{installable && (
					<button type="button" className="mp-btn mp-btn--accent" onClick={fire("install")} disabled={isBusy}>
						{isBusy ? t("guest.pluginInstalling") : t("guest.pluginInstall")}
					</button>
				)}
				{upgradable && (
					<button type="button" className="mp-btn mp-btn--accent" onClick={fire("upgrade")} disabled={isBusy}>
						{isBusy ? t("guest.pluginUpgrading") : t("guest.pluginUpgrade")}
					</button>
				)}
				{removable && (
					<button type="button" className="mp-btn mp-btn--warn" onClick={fire("remove")} disabled={isBusy}>
						{isBusy ? t("guest.pluginRemoving") : t("guest.pluginRemove")}
					</button>
				)}
			</footer>
		</article>
	);
}
