import { Markdown, t } from "@musepi/client-core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	downloadUpdate,
	flashUpdateAttention,
	getUpdateNotes,
	getUpdateState,
	onUpdateState,
	openExternalUrl,
	type UpdateErrorInfo,
} from "../lib/electron";
import {
	getInstallFailureCount,
	isUpdateInstalling,
	isUpdateToastVisible,
	requestUpdateInstall,
	resetInstallFailures,
	subscribeUpdateUx,
	UPDATE_ERROR_BODY_KEYS,
} from "../lib/update-ux";
import { DialogFrame } from "./DialogFrame";

/**
 * L-dialog layer over the update toast (design §3.2 — 分层共存, never a
 * replacement): a compact DialogFrame (`gui-dialog--confirm`, 380px) that
 * only appears for states a passive toast handles badly. Two cards:
 *
 *   ① 待重启确认卡 — `downloaded` persists ≥10 min while the toast is
 *      closed/invisible (autoInstallOnAppQuit is off, so a dismissed toast
 *      used to lose the install entry until the next poll).
 *   ② 失败决策卡 — download/install failed ≥2 consecutive times: retry
 *      (primary) / open the releases page / 暂不 (Escape).
 *
 * During the quitAndInstall grace window (requestUpdateInstall → the
 * shared update-ux store) both this dialog and the toast switch to the
 * non-clickable "正在安装更新…" copy. Also owns the one-shot taskbar
 * attention flash: `downloaded` arriving while the window is unfocused
 * (flashFrame, no system notification — decision ④).
 */
const RELEASES_PAGE = "https://github.com/MuseLinn/MusePi/releases/latest";
/** How long `downloaded` must sit unnoticed before the reboot card pops. */
const REBOOT_NUDGE_AFTER_MS = 10 * 60_000;
/** Poll cadence for the ≥10-min check (no timers per state push needed). */
const NUDGE_CHECK_INTERVAL_MS = 30_000;

export function UpdateDialog(): ReactNode {
	const [open, setOpen] = useState(false);
	const [mode, setMode] = useState<"reboot" | "failure">("reboot");
	const [failureInfo, setFailureInfo] = useState<UpdateErrorInfo | null>(null);
	const [version, setVersion] = useState<string | null>(null);
	const [notes, setNotes] = useState<string | null>(null);
	const [installing, setInstalling] = useState(false);

	// Mutable tracking across state pushes (no re-render churn).
	const statusRef = useRef<string>("idle");
	const downloadedAtRef = useRef<number | null>(null);
	const rebootNudgedRef = useRef(false);
	const downloadFailuresRef = useRef(0);
	const lastInstallErrorRef = useRef<UpdateErrorInfo | null>(null);
	const openRef = useRef(false);
	openRef.current = open;

	useEffect(() => {
		// Renderer (re)mount with a download already in flight: seed the
		// episode clock so the ≥10-min nudge measures from now, not forever.
		void getUpdateState().then(s => {
			if (!s) return;
			statusRef.current = s.status;
			if (s.version) setVersion(s.version);
			if (s.status === "downloaded") downloadedAtRef.current = Date.now();
		});

		const unsubState = onUpdateState(s => {
			if (s.version) setVersion(s.version);
			if (s.error?.kind.startsWith("install")) {
				lastInstallErrorRef.current = s.error;
			}
			if (s.status === "error" && s.error?.kind.startsWith("download")) {
				downloadFailuresRef.current += 1;
				if (downloadFailuresRef.current >= 2 && !openRef.current) {
					downloadFailuresRef.current = 0;
					setFailureInfo(s.error);
					setMode("failure");
					setOpen(true);
				}
			}
			// A fresh download attempt resets the consecutive-failure count.
			if (s.status === "preparing" || s.status === "downloading") {
				downloadFailuresRef.current = 0;
			}
			if (s.status === "downloaded") {
				const arrived = statusRef.current !== "downloaded";
				downloadedAtRef.current = Date.now();
				rebootNudgedRef.current = false;
				downloadFailuresRef.current = 0;
				resetInstallFailures();
				// One-shot taskbar flash when the package lands while the
				// window is in the background (never a system notification).
				if (arrived && typeof document !== "undefined" && !document.hasFocus()) {
					void flashUpdateAttention();
				}
			}
			statusRef.current = s.status;
		});

		const unsubUx = subscribeUpdateUx(() => {
			setInstalling(isUpdateInstalling());
			if (getInstallFailureCount() >= 2 && !openRef.current) {
				resetInstallFailures();
				setFailureInfo(lastInstallErrorRef.current ?? { kind: "install", message: "" });
				setMode("failure");
				setOpen(true);
			}
		});

		return () => {
			unsubState();
			unsubUx();
		};
	}, []);

	// ≥10-min downloaded nudge: fire once per downloaded episode, only while
	// the toast is not showing (the toast IS the visible surface otherwise).
	useEffect(() => {
		const id = setInterval(() => {
			if (rebootNudgedRef.current || openRef.current) return;
			if (statusRef.current !== "downloaded" || downloadedAtRef.current === null) return;
			if (isUpdateToastVisible()) return;
			if (Date.now() - downloadedAtRef.current >= REBOOT_NUDGE_AFTER_MS) {
				rebootNudgedRef.current = true;
				setMode("reboot");
				setOpen(true);
			}
		}, NUDGE_CHECK_INTERVAL_MS);
		return () => clearInterval(id);
	}, []);

	// Notes summary: one cached main-process fetch per open (same manifest
	// source as the toast preview). Never blocks the card on failure.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		void getUpdateNotes().then(n => {
			if (!cancelled) setNotes(n && n.trim().length > 0 ? n : null);
		});
		return () => {
			cancelled = true;
		};
	}, [open]);

	const close = (): void => {
		setOpen(false);
		if (mode === "failure") {
			downloadFailuresRef.current = 0;
			resetInstallFailures();
		}
	};

	// Install via the shared store (flips both surfaces into the
	// installing copy). A failed retry switches the open card to the
	// failure decision instead of silently doing nothing.
	const doInstall = async (): Promise<void> => {
		const res = await requestUpdateInstall();
		if (!res.ok && openRef.current) {
			setFailureInfo(lastInstallErrorRef.current ?? { kind: "install", message: res.error ?? "" });
			setMode("failure");
		}
	};

	const retry = (): void => {
		if (mode === "failure" && failureInfo?.kind.startsWith("install")) {
			void doInstall();
			return;
		}
		// Download retry: close and let the toast take over (it revives on
		// the preparing state and shows the progress bar).
		setOpen(false);
		void downloadUpdate();
	};

	const goReleases = (): void => {
		void openExternalUrl(RELEASES_PAGE);
		close();
	};

	// Enter = primary action while the card is up (confirm-class contract),
	// unless a button already holds focus (its own click would double-fire)
	// or the install grace window has everything locked.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key !== "Enter" || isUpdateInstalling()) return;
			if (document.activeElement instanceof HTMLElement && document.activeElement.tagName === "BUTTON") return;
			e.preventDefault();
			e.stopPropagation();
			if (mode === "reboot") void doInstall();
			else retry();
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [open, mode, failureInfo]);

	const failedInstall = mode === "failure" && failureInfo?.kind.startsWith("install");
	const title =
		mode === "reboot"
			? t("update ready title")
			: t(failedInstall ? "update failed title install" : "update failed title download");
	const body =
		mode === "reboot"
			? t("update ready body", { version: version ?? "" })
			: t(UPDATE_ERROR_BODY_KEYS[failureInfo?.kind ?? "install"]);

	// DialogFrame is ALWAYS rendered (never conditionally mounted) — it owns
	// the 180ms exit animation internally; unmounting it here would kill the
	// closing motion (AGENTS.md GUI rule).
	return (
		<DialogFrame open={open} onClose={close} className="gui-dialog--confirm" label={title}>
			<h3 className="text-base font-semibold">{title}</h3>
			{mode === "reboot" && version && <div className="mt-1 text-sm opacity-70">v{version}</div>}
			<p className="mt-2 text-sm">{body}</p>
			{notes && (
				<div className="mt-2 max-h-28 overflow-y-auto text-sm opacity-80">
					<Markdown text={notes} />
				</div>
			)}
			{mode === "failure" && failureInfo && (failureInfo.message || failureInfo.technicalDetails) && (
				<details className="mt-2 text-xs opacity-70">
					<summary className="cursor-pointer select-none">{t("technical details")}</summary>
					<pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all">
						{failureInfo.technicalDetails ?? failureInfo.message}
					</pre>
				</details>
			)}
			<div className="mt-4 flex justify-end gap-2">
				{installing ? (
					<span className="text-sm opacity-80">{t("installing update")}</span>
				) : (
					<>
						<button type="button" className="gui-btn" onClick={close}>
							{t("update later")}
						</button>
						{mode === "failure" && (
							<button type="button" className="gui-btn" onClick={goReleases}>
								{t("go to download")}
							</button>
						)}
						<button
							type="button"
							className="gui-btn gui-btn-primary"
							onClick={() => (mode === "reboot" ? void doInstall() : retry())}
						>
							{mode === "reboot" ? t("restart now") : t("retry")}
						</button>
					</>
				)}
			</div>
		</DialogFrame>
	);
}
