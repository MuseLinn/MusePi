import { getLocaleSnapshot, Markdown, subscribeLocale, t } from "@musepi/desktop-web";
import { type ReactNode, useEffect, useSyncExternalStore, useState } from "react";
import {
	downloadUpdate,
	installUpdate,
	onUpdateAvailable,
	onUpdateState,
	openExternalUrl,
	type UpdateCheckResult,
	type UpdaterState,
} from "../lib/electron";
import type { RpcClient } from "../lib/rpc";

/**
 * OTA update notice (opencode/electron-updater parity): the Electron main
 * process silent-checks ~12s after launch and pushes "update-available" here
 * via preload's onUpdateAvailable. Flow:
 *
 *   [有新版本 vX → vY] → [下载更新] → 进度条 % → [立即重启]
 *
 * electron-updater downloads in the background (autoDownload=false, download
 * initiated by this button); updater-state events drive the progress bar.
 * On failure the toast falls back to 前往下载 (openExternal), so the old
 * manual path is never lost.
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

export function UpdateToast({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [notice, setNotice] = useState<UpdateCheckResult | null>(null);
	const [state, setState] = useState<UpdaterState | null>(null);
	const [notes, setNotes] = useState<string | null>(null);
	// Current locale (re-renders on change so bilingual notes follow the UI
	// language without a reload).
	const locale = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, () => "en-US");

	// Startup auto-check notice + live updater state pushes.
	useEffect(() => {
		const unsubNotice = onUpdateAvailable(result => {
			if (!result?.latest || isSkipped(result.latest)) return;
			setNotice(result);
		});
		const unsubState = onUpdateState(s => {
			setState(s);
			// Once downloaded, drop the skip-version gate so 立即重启 stays
			// visible even if the user skipped the notice earlier.
			if (s.status === "downloaded" && s.version) {
				try {
					localStorage.removeItem(SKIPPED_VERSION_KEY);
				} catch {
					// ignore
				}
			}
		});
		return () => {
			unsubNotice();
			unsubState();
		};
	}, []);

	// Bilingual release notes: the daemon's updates.check probes the
	// update-manifest.json asset (version + notes {zh,en}); pick the notes
	// for the current UI language. Never nags on network failure.
	useEffect(() => {
		if (!notice?.latest || !rpc) {
			setNotes(null);
			return;
		}
		let cancelled = false;
		void rpc
			.request<{ latest?: string; notes?: { zh?: string; en?: string } } | null>("updates.check", {})
			.then(res => {
				if (cancelled) return;
				const n = res?.notes;
				if (!n) {
					setNotes(null);
					return;
				}
				setNotes(locale === "zh-CN" ? (n.zh ?? n.en ?? null) : (n.en ?? n.zh ?? null));
			})
			.catch(() => {
				if (!cancelled) setNotes(null);
			});
		return () => {
			cancelled = true;
		};
	}, [notice?.latest, rpc, locale]);

	if (!notice?.latest) return null;

	const downloading = state?.status === "downloading";
	const downloaded = state?.status === "downloaded";
	const failed = state?.status === "error";

	const dismiss = (): void => setNotice(null);
	const skip = (): void => {
		try {
			localStorage.setItem(SKIPPED_VERSION_KEY, notice.latest ?? "");
		} catch {
			// ignore — dismissal still applies for this paint
		}
		dismiss();
	};
	const startDownload = (): void => {
		void downloadUpdate();
	};
	const restart = (): void => {
		void installUpdate();
	};
	const goManual = (): void => {
		void openExternalUrl(notice.url || RELEASES_PAGE);
		dismiss();
	};

	const percent = state?.progress?.percent ?? 0;

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
			{notes ? (
			<div className="gui-update-toast-notes">
				<Markdown text={notes} />
			</div>
		) : null}
			{downloading && (
				<div className="gui-update-toast-progress">
					<div className="gui-update-toast-progress-bar" style={{ width: `${percent}%` }} />
					<span className="gui-update-toast-progress-label">{t("downloading {percent}%", { percent })}</span>
				</div>
			)}
			{failed && <div className="gui-update-toast-error">{state?.error ?? t("update download failed")}</div>}
			<div className="gui-update-toast-actions">
				{downloaded ? (
					<button type="button" className="gui-btn gui-btn-primary" onClick={restart}>
						{t("restart now")}
					</button>
				) : downloading ? null : (
					<button type="button" className="gui-btn gui-btn-primary" onClick={startDownload}>
						{t("download update")}
					</button>
				)}
				{failed ? (
					<button type="button" className="gui-btn" onClick={goManual}>
						{t("go to download")}
					</button>
				) : downloaded ? (
					<button type="button" className="gui-btn" onClick={skip}>
						{t("skip this version")}
					</button>
				) : (
					<button type="button" className="gui-btn" onClick={skip}>
						{t("skip this version")}
					</button>
				)}
			</div>
		</div>
	);
}