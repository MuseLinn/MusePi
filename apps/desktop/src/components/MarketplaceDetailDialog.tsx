import type { MarketplaceCardAction, MarketplaceCardEntry } from "@musepi/client-core";
import { t, useScrollShadow } from "@musepi/client-core";
import { MarketplaceVersionChoice, upgradableVersions } from "@musepi/client-core/src/components/marketplace";
import { type ReactNode, useRef, useState } from "react";
import { openExternalUrl } from "../lib/electron";
import { DialogFrame } from "./DialogFrame";
import { PluginIcon } from "./PluginIcon";
import "./marketplace-detail.css";

export interface MarketplaceDetailEntry extends MarketplaceCardEntry {
	displayName?: string;
	longDescription?: string;
	capabilities?: string[];
	skills?: Array<{ name: string; description: string }>;
}

export function MarketplaceDetailDialog({
	open,
	entry,
	busy,
	error,
	onClose,
	onAction,
	onToggleEnabled,
}: {
	open: boolean;
	entry: MarketplaceDetailEntry | null;
	busy: boolean;
	error: string | null;
	onClose(): void;
	onAction(action: MarketplaceCardAction): Promise<void>;
	onToggleEnabled(enabled: boolean): Promise<void>;
}): ReactNode {
	const scrollRef = useRef<HTMLDivElement>(null);
	useScrollShadow(scrollRef);
	// Selection is scoped to the entry it was made in: opening another plugin
	// (or the same one after a refresh changed its versions) starts fresh
	// instead of carrying a version across plugins.
	const versionsKey = [
		entry?.name ?? "",
		entry?.marketplace ?? "",
		(entry?.versions ?? []).join(","),
		entry?.installedVersion ?? "",
	].join(":");
	const [picked, setPicked] = useState<{ key: string; version: string } | null>(null);
	if (!entry)
		return (
			<DialogFrame open={false} onClose={onClose} label={t("guest.pluginDetails")}>
				{null}
			</DialogFrame>
		);
	const name = entry.displayName ?? entry.name;
	const description = entry.longDescription ?? entry.description;
	const versions = entry.versions ?? [];
	const installableVersions = upgradableVersions(versions, entry.installedVersion);
	const selection = picked?.key === versionsKey ? picked.version : null;
	const targetVersion = selection ?? installableVersions[0];
	// One version is not a choice: a repository with no tags only adds the
	// catalog and installed versions, and a single chip would be pure chrome.
	const showVersionList = entry.installed === true && versions.length > 1;
	const showUpgrade = entry.installed === true && (targetVersion !== undefined || entry.updateAvailable === true);
	return (
		<DialogFrame open={open} onClose={onClose} label={name} className="gui-dialog--shortcuts gui-marketplace-detail">
			<div className="gui-marketplace-detail-shell">
				<header className="gui-marketplace-detail-header">
					<PluginIcon
						name={name}
						icon={entry.icon}
						size={52}
						status={entry.installed ? (entry.enabled === false ? "off" : "active") : undefined}
					/>
					<div className="gui-marketplace-detail-heading">
						<div className="gui-marketplace-detail-titleline">
							<h2>{name}</h2>
							<span className="gui-ext-item-tag">{t("guest.marketplaceSegmentCatalog")}</span>
							{entry.version && <span className="gui-ext-item-tag">v{entry.version}</span>}
						</div>
						{entry.description && <p>{entry.description}</p>}
					</div>
					<div className="gui-marketplace-detail-header-actions">
						{entry.installed && (
							<button
								type="button"
								role="switch"
								aria-checked={entry.enabled !== false}
								aria-label={`${entry.enabled === false ? "Enable" : "Disable"} ${name}`}
								disabled={busy}
								className={`gui-toggle${entry.enabled !== false ? " gui-toggle--on" : ""}`}
								onClick={() => void onToggleEnabled(entry.enabled === false)}
							>
								<span className="gui-toggle-knob" />
							</button>
						)}
						<button type="button" className="gui-icon-btn" aria-label={t("settings.close")} onClick={onClose}>
							×
						</button>
					</div>
				</header>

				<div ref={scrollRef} className="gui-marketplace-detail-scroll">
					{error && (
						<div className="gui-ext-detail-loaderror" role="alert">
							{error}
						</div>
					)}
					{description && (
						<section className="gui-marketplace-detail-section">
							<h3>{t("guest.pluginDetailIntro")}</h3>
							<p className="gui-marketplace-detail-prose">{description}</p>
						</section>
					)}
					{showVersionList && (
						<section className="gui-marketplace-detail-section">
							<h3>{t("marketplace.versions")}</h3>
							<MarketplaceVersionChoice
								versions={versions}
								installedVersion={entry.installedVersion}
								selected={targetVersion ?? null}
								onSelect={version => setPicked({ key: versionsKey, version })}
								busy={busy}
							/>
						</section>
					)}
					{entry.capabilities && entry.capabilities.length > 0 && (
						<section className="gui-marketplace-detail-section">
							<h3>{t("guest.pluginDetailCapabilities")}</h3>
							<div className="gui-marketplace-detail-chips">
								{entry.capabilities.map(capability => (
									<span key={capability} className="gui-ext-item-tag">
										{capability}
									</span>
								))}
							</div>
						</section>
					)}
					{entry.skills && entry.skills.length > 0 && (
						<section className="gui-marketplace-detail-section">
							<h3>{t("guest.pluginDetailSkills")}</h3>
							<div className="gui-marketplace-skill-list">
								{entry.skills.map(skill => (
									<article key={skill.name} className="gui-marketplace-skill">
										<h4>{skill.name}</h4>
										<p>{skill.description}</p>
									</article>
								))}
							</div>
						</section>
					)}
				</div>

				<footer className="gui-marketplace-detail-footer">
					<div className="gui-marketplace-detail-meta">
						{entry.author && <span>{t("guest.pluginAuthorBy", { author: entry.author })}</span>}
						{entry.installedVersion && <span>v{entry.installedVersion}</span>}
						{entry.license && <span>{entry.license}</span>}
						<span>{entry.marketplace}</span>
					</div>
					<div className="gui-marketplace-detail-actions">
						{entry.homepage && (
							<button type="button" className="gui-btn" onClick={() => void openExternalUrl(entry.homepage!)}>
								{t("guest.pluginDetailHomepage")}
							</button>
						)}
						{entry.repository && (
							<button type="button" className="gui-btn" onClick={() => void openExternalUrl(entry.repository!)}>
								{t("guest.pluginDetailRepository")}
							</button>
						)}
						{!entry.installed && (
							<button
								type="button"
								className="gui-btn gui-btn-primary"
								disabled={busy}
								onClick={() => void onAction({ kind: "install", entry })}
							>
								{t("guest.pluginInstall")}
							</button>
						)}
						{showUpgrade && (
							<button
								type="button"
								className="gui-btn gui-btn-primary"
								disabled={busy}
								onClick={() => void onAction({ kind: "upgrade", entry, targetVersion })}
							>
								{targetVersion !== undefined
									? t("marketplace.upgradeToVersion", { version: targetVersion })
									: t("guest.pluginUpgrade")}
							</button>
						)}
						{entry.installed && (
							<button
								type="button"
								className="gui-btn"
								disabled={busy}
								onClick={() => void onAction({ kind: "remove", entry })}
							>
								{t("guest.pluginRemove")}
							</button>
						)}
					</div>
				</footer>
			</div>
		</DialogFrame>
	);
}
