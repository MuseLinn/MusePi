import { Markdown, t } from "@musepi/desktop-web";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	downloadUpdate,
	getUpdateNotes,
	installUpdate,
	onUpdateAvailable,
	onUpdateState,
	openExternalUrl,
	type UpdateCheckResult,
	type UpdaterState,
} from "../lib/electron";
import { Icon } from "../vendor/oc-icons";

/**
 * OTA update notice (opencode/electron-updater parity): the Electron main
 * process silent-checks ~12s after launch and pushes "update-available" here
 * via preload's onUpdateAvailable. Flow:
 *
 *   [有新版本 vX → vY + notes] → [下载更新] → preparing 不确定条 → 进度条 %
 *   → [立即重启]
 *
 * Notes come from the same update-manifest.json the daemon RPC reads, fetched
 * by the main process (updater-notes IPC, cached) — so the preview survives a
 * not-yet-connected daemon and a disabled startup.checkUpdate. electron-updater
 * downloads in the background (autoDownload=false, download initiated by this
 * button); updater-state events drive the states: `preparing` covers the
 * click → first-byte gap, `downloading` the progress events, and both revive a
 * dismissed toast so 立即重启 is never lost. On failure the toast offers retry
 * + 前往下载, so the old manual path is never lost.
 */
const SKIPPED_VERSION_KEY = "musepi-update-skip-version";
const RELEASES_PAGE = "https://github.com/MuseLinn/MusePi/releases/latest";
/** Matches the exit animation in gui-widgets.css (prompt-dialog 180ms parity). */
const EXIT_MS = 180;
/** Notes longer than this get a 展开 toggle (shorter ones fit the clamp). */
const NOTES_EXPAND_THRESHOLD = 200;

function isSkipped(latest: string): boolean {
	try {
		return localStorage.getItem(SKIPPED_VERSION_KEY) === latest;
	} catch {
		// localStorage unavailable — never treat as skipped
		return false;
	}
}

function formatMB(bytes: number): string {
	return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function UpdateToast(): ReactNode {
	const [notice, setNotice] = useState<UpdateCheckResult | null>(null);
	const [state, setState] = useState<UpdaterState | null>(null);
	const [notes, setNotes] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(false);
	const [closing, setClosing] = useState(false);
	// Install-phase failure (quitAndInstall rejected: signature, disabled
	// Squirrel session). Separate from `state.error` which is download-phase.
	const [installError, setInstallError] = useState<string | null>(null);
	// Last full notice — reviving after dismissal keeps the current-version
	// label even though the state push only carries the new version.
	const noticeRef = useRef<UpdateCheckResult | null>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Startup auto-check notice + live updater state pushes.
	useEffect(() => {
		const unsubNotice = onUpdateAvailable(result => {
			if (!result?.latest || isSkipped(result.latest)) return;
			noticeRef.current = result;
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
			// Revive a dismissed toast when a download starts or completes:
			// `preparing` fires exactly once per user-initiated download (the
			// settings page's 下载更新 included), and the downloaded state must
			// stay reachable — autoInstallOnAppQuit is off, so 立即重启 is the
			// only way the downloaded package installs.
			if (s.status === "preparing" || s.status === "downloaded") {
				if (closeTimer.current) {
					clearTimeout(closeTimer.current);
					closeTimer.current = null;
				}
				setClosing(false);
				setNotice(prev => prev ?? { ...noticeRef.current, latest: s.version ?? noticeRef.current?.latest });
			}
		});
		return () => {
			unsubNotice();
			unsubState();
		};
	}, []);

	// Release notes: one cached main-process fetch per notice. The manifest
	// ships a bilingual-mixed string; render as-is. Never nags on failure.
	useEffect(() => {
		if (!notice?.latest) {
			setNotes(null);
			setExpanded(false);
			return;
		}
		let cancelled = false;
		void getUpdateNotes().then(n => {
			if (!cancelled) setNotes(n);
		});
		return () => {
			cancelled = true;
		};
	}, [notice?.latest]);

	if (!notice?.latest) return null;

	const preparing = state?.status === "preparing";
	const downloading = state?.status === "downloading";
	const downloaded = state?.status === "downloaded";
	const failed = state?.status === "error";
	const progress = state?.progress;
	const percent = Math.min(100, Math.round(progress?.percent ?? 0));
	const total = progress?.total ?? 0;
	const speed = progress?.bytesPerSecond ?? 0;
	const hasNotes = notes !== null && notes.trim().length > 0;

	const close = (skipVersion: boolean): void => {
		if (skipVersion) {
			try {
				localStorage.setItem(SKIPPED_VERSION_KEY, notice.latest ?? "");
			} catch {
				// ignore — dismissal still applies for this paint
			}
		}
		setClosing(true);
		if (closeTimer.current) clearTimeout(closeTimer.current);
		closeTimer.current = setTimeout(() => {
			closeTimer.current = null;
			setClosing(false);
			setNotice(null);
			setNotes(null);
			setExpanded(false);
			setInstallError(null);
		}, EXIT_MS);
	};
	const startDownload = (): void => {
		void downloadUpdate();
	};
	const restart = (): void => {
		// quitAndInstall resolves once the app is shutting down (ok:true)
		// or rejects with the installer error while the app is still
		// running — surface the failure inline so a rejected install
		// (signature, disabled Squirrel session) offers retry instead of
		// silently doing nothing.
		setInstallError(null);
		void installUpdate().then(res => {
			if (!res.ok) setInstallError(res.error ?? t("update install failed"));
		});
	};
	const goManual = (): void => {
		void openExternalUrl(notice.url || RELEASES_PAGE);
		close(false);
	};

	return (
		<div className={`gui-update-toast${closing ? " gui-update-toast--closing" : ""}`} role="status">
			<div className="gui-update-toast-head">
				<span className="gui-update-toast-title">{t("new version")}</span>
				<span className="gui-update-toast-versions">
					{notice.current ? `v${notice.current} → ` : ""}v{notice.latest}
				</span>
				<button
					type="button"
					className="gui-update-toast-close"
					onClick={() => close(false)}
					title={t("close")}
					aria-label={t("close")}
				>
					×
				</button>
			</div>
			{hasNotes && (
				<div className={`gui-update-toast-notes${expanded ? " gui-update-toast-notes--expanded" : ""}`}>
					<div className="gui-update-toast-notes-scroll">
						<Markdown text={notes} />
					</div>
				</div>
			)}
			{hasNotes && notes.length > NOTES_EXPAND_THRESHOLD && (
				<button type="button" className="gui-update-toast-notes-toggle" onClick={() => setExpanded(v => !v)}>
					{t(expanded ? "show less" : "show more")}
				</button>
			)}
			{preparing && (
				<div className="gui-update-toast-progress">
					<div className="gui-update-toast-progress-bar gui-update-toast-progress-bar--indeterminate" />
				</div>
			)}
			{downloading && (
				<>
					<div className="gui-update-toast-progress-meta">
						<span>{t("downloading {percent}%", { percent })}</span>
						{total > 0 && (
							<span>
								{formatMB(progress?.transferred ?? 0)} / {formatMB(total)}
								{speed > 0 ? ` · ${formatMB(speed)}/s` : ""}
							</span>
						)}
					</div>
					<div className="gui-update-toast-progress">
						<div className="gui-update-toast-progress-bar" style={{ width: `${percent}%` }} />
					</div>
				</>
			)}
			{downloaded && (
				<div className="gui-update-toast-done">
					<Icon name="check" className="h-3.5 w-3.5" />
					<span>{t("download complete")}</span>
				</div>
			)}
			{failed && <div className="gui-update-toast-error">{state?.error ?? t("update download failed")}</div>}
			{installError && <div className="gui-update-toast-error">{installError}</div>}
			<div className="gui-update-toast-actions">
				{downloaded ? (
					<button type="button" className="gui-btn gui-btn-primary" onClick={restart}>
						{t("restart now")}
					</button>
				) : preparing || downloading ? null : (
					<button type="button" className="gui-btn gui-btn-primary" onClick={startDownload}>
						{t("download update")}
					</button>
				)}
				{failed ? (
					<>
						<button type="button" className="gui-btn" onClick={startDownload}>
							{t("retry")}
						</button>
						<button type="button" className="gui-btn" onClick={goManual}>
							{t("go to download")}
						</button>
					</>
				) : (
					<button type="button" className="gui-btn" onClick={() => close(true)}>
						{t("skip this version")}
					</button>
				)}
			</div>
		</div>
	);
}
