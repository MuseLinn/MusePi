import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import "./marketplace.css";

/**
 * Version row for the plugin detail dialog.
 *
 * Presentational and comparison-free: the daemon returns versions newest
 * first, so "newer than installed" is a position check (see
 * {@link upgradableVersions}). The installed version is marked and cannot be
 * selected; versions older than it are rendered but disabled, which is how
 * "no silent downgrade" stays visible instead of merely being enforced on the
 * server.
 */
export interface MarketplaceVersionChoiceProps {
	versions: readonly string[];
	installedVersion?: string;
	/** Version the user picked; parents own the state. */
	selected: string | null;
	onSelect(version: string): void;
	busy?: boolean;
}

export function MarketplaceVersionChoice({
	versions,
	installedVersion,
	selected,
	onSelect,
	busy = false,
}: MarketplaceVersionChoiceProps): ReactNode {
	if (versions.length === 0) return null;
	const installedIndex = installedVersion === undefined ? -1 : versions.indexOf(installedVersion);
	return (
		<div className="mp-version-row" role="radiogroup" aria-label={t("marketplace.versions")}>
			{versions.map((version, index) => {
				const current = installedIndex !== -1 && index === installedIndex;
				const older = installedIndex !== -1 && index > installedIndex;
				const checked = selected === version;
				const classes = [
					"mp-version",
					current ? "mp-version--current" : "",
					older ? "mp-version--blocked" : "",
					checked ? "mp-version--selected" : "",
				]
					.filter(Boolean)
					.join(" ");
				return (
					<button
						key={version}
						type="button"
						role="radio"
						aria-checked={checked}
						disabled={busy || current || older}
						title={older ? t("marketplace.versionDowngradeBlocked") : undefined}
						className={classes}
						onClick={() => onSelect(version)}
					>
						<span className="mp-version-label">v{version}</span>
						{current && <span className="mp-version-tag">{t("marketplace.versionCurrent")}</span>}
					</button>
				);
			})}
		</div>
	);
}
