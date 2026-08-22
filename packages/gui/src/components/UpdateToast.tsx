import { t } from "@musepi/desktop-web";
import { type ReactNode, useEffect, useState } from "react";
import { onUpdateAvailable, openExternalUrl, type UpdateCheckResult } from "../lib/electron";

/**
 * Auto-check update notice (BitFun DailyAppUpdateGate parity): the Electron
 * main process silent-checks ~12s after launch and pushes "update-available"
 * here via preload's onUpdateAvailable. Renders a dismissable bottom-right
 * toast — [前往下载] opens the release download, [跳过此版本] remembers the
 * version in localStorage so the same release never nags again.
 */
const SKIPPED_VERSION_KEY = "musepi-update-skip-version";
const RELEASES_PAGE = "https://github.com/MuseLinn/MusePi/releases/latest";

function isSkipped(latest: string): boolean {
	try {
		return localStorage.getItem(SKIPPED_VERSION_KEY) === latest;
	} catch {
		// localStorage unavailable — never treat as skipped
		return false;
	}
}

export function UpdateToast(): ReactNode {
	const [notice, setNotice] = useState<UpdateCheckResult | null>(null);

	useEffect(() => {
		return onUpdateAvailable(result => {
			if (!result?.latest || isSkipped(result.latest)) return;
			setNotice(result);
		});
	}, []);

	if (!notice?.latest) return null;
	const dismiss = (): void => setNotice(null);
	const skip = (): void => {
		try {
			localStorage.setItem(SKIPPED_VERSION_KEY, notice.latest ?? "");
		} catch {
			// ignore — dismissal still applies for this paint
		}
		dismiss();
	};
	const download = (): void => {
		void openExternalUrl(notice.url || RELEASES_PAGE);
		dismiss();
	};

	return (
		<div className="gui-update-toast" role="status">
			<div className="gui-update-toast-head">
				<span className="gui-update-toast-title">{t("new version")}</span>
				<span className="gui-update-toast-versions">
					{notice.current ? `v${notice.current} → ` : ""}v{notice.latest}
				</span>
				<button
					type="button"
					className="gui-update-toast-close"
					onClick={dismiss}
					title={t("close")}
					aria-label={t("close")}
				>
					×
				</button>
			</div>
			{notice.notes ? <div className="gui-update-toast-notes">{notice.notes}</div> : null}
			<div className="gui-update-toast-actions">
				<button type="button" className="gui-btn gui-btn-primary" onClick={download}>
					{t("go to download")}
				</button>
				<button type="button" className="gui-btn" onClick={skip}>
					{t("skip this version")}
				</button>
			</div>
		</div>
	);
}
