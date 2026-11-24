import { DotMatrixMark, Markdown, t, useLocale } from "@musepi/client-core";
import { ToolView } from "@musepi/client-core/src/tool-render/ToolView";
import { taskRenderer } from "@musepi/client-core/src/tool-render/tools/task";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { projectRuntimeVersions } from "../../lib/daemon-version";
import {
	checkAppUpdates,
	downloadInstaller,
	downloadUpdate,
	getCloseToTray,
	getShellVersion,
	isElectron,
	openExternalUrl,
	setCloseToTray,
	shellPlatform,
	type UpdateCheckResult,
} from "../../lib/electron";
import type { RpcClient } from "../../lib/rpc";
import { dispatchSettingsChanged } from "../../lib/settings-events";
import { localizeUpdateNotes } from "../../lib/update-notes";
import { UPDATE_ERROR_BODY_KEYS } from "../../lib/update-ux";
import { readWelcomeGreeting, writeWelcomeGreeting } from "../../lib/welcome-greeting";
import { Icon } from "../../vendor/oc-icons";
import { GuiSelect } from "../GuiSelect";
import { SchemaTabSection } from "./schema";

/** Shared fixture feeding both preview cards — the SAME settled-batch shape
 *  the transcript renders (results with per-agent stats/errors). */
const TASK_PREVIEW_ARGS = { tasks: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }] };
const TASK_PREVIEW_DETAILS = {
	totalDurationMs: 42500,
	results: [
		{ id: "A", exitCode: 0, durationMs: 3000, tokens: 1200, output: "Scanned the openchamber tree" },
		{ id: "B", exitCode: 0, durationMs: 4100, tokens: 900, output: "Summarized composer slots" },
		{ id: "C", exitCode: 0, durationMs: 5200, tokens: 1500, output: "Mapped the settings sections" },
		{ id: "D", exitCode: 1, durationMs: 1900, error: "exit 1", output: "timed out" },
	],
};

/** Preview of the two task-card styles (display.taskCardStyle settings
 *  row): MusePi Swarm = the chat-message task tool-call card with the
 *  floating frosted member-grid card beneath it (the composer chip opens
 *  that floating card); MusePi original (Classic) = the plain tool-call card
 *  only. The cards ARE the real transcript rendering driven by a shared
 *  fixture (same ToolView / taskRenderer.SwarmCard the chat uses) — what
 *  you see is what the style will look like; clicking either card switches
 *  the style (the preview IS the control; the standard select is hidden). */
export function TaskCardStylePreview({
	value,
	onPick,
}: {
	value: unknown;
	onPick(style: "swarm" | "classic"): void;
}): ReactNode {
	const active = value === "classic" ? "classic" : "swarm";
	// The task renderer always ships SwarmCard (the swarm member grid) —
	// non-null asserted like the renderer tests, the field is optional by
	// ToolRenderer contract but present here.
	const SwarmCard = taskRenderer.SwarmCard!;
	const nativeCard = (
		<ToolView
			name="task"
			args={TASK_PREVIEW_ARGS}
			result={{ content: [], details: TASK_PREVIEW_DETAILS }}
			taskCardStyle="classic"
			defaultOpen
			collapseWhenDone={false}
		/>
	);
	const classic = <div className="gui-taskstyle-preview-stack">{nativeCard}</div>;
	const swarm = (
		<div className="gui-taskstyle-preview-stack">
			{nativeCard}
			{/* Floating member grid (composer chip → frosted card): the real
			 * taskRenderer.SwarmCard — avatars, progress bars, accordions. */}
			<div className="gui-taskstyle-preview-float">
				<SwarmCard name="task" args={{}} result={{ content: [], details: TASK_PREVIEW_DETAILS }} />
			</div>
		</div>
	);
	return (
		<div className="gui-taskstyle-preview">
			<button
				type="button"
				className={`gui-taskstyle-preview-option${active === "swarm" ? " gui-taskstyle-preview-option--active" : ""}`}
				aria-pressed={active === "swarm"}
				onClick={() => onPick("swarm")}
			>
				{swarm}
				<span className="gui-taskstyle-preview-label">{t("settings.musepiSwarm")}</span>
			</button>
			<button
				type="button"
				className={`gui-taskstyle-preview-option${active === "classic" ? " gui-taskstyle-preview-option--active" : ""}`}
				aria-pressed={active === "classic"}
				onClick={() => onPick("classic")}
			>
				{classic}
				<span className="gui-taskstyle-preview-label">{t("settings.musepiOriginal")}</span>
			</button>
		</div>
	);
}

export function GeneralSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const locale = useLocale();
	const [info, setInfo] = useState<{
		version?: string;
		musepiVersion?: string | null;
		engineVersion?: string;
		engine?: string;
		dataRoot?: string;
		configDir?: string;
		runtime?: string;
	} | null>(null);
	const [shellVersion, setShellVersion] = useState<string | null>(null);
	const [metaErr, setMetaErr] = useState<string | null>(null);
	const [pickedRoot, setPickedRoot] = useState<string | null>(null);
	const [rootBusy, setRootBusy] = useState(false);
	const [rootMsg, setRootMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const [updateStatus, setUpdateStatus] = useState<string>(t("settings.checkUpdates"));
	/** Raw updater error, folded under the localized status as muted detail. */
	const [updateErrorDetail, setUpdateErrorDetail] = useState<string | null>(null);
	// Full check result kept for the richer row: notes snippet + explicit
	// 前往下载 button instead of the old surprise window.open popup.
	const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
	const [updateChecking, setUpdateChecking] = useState(false);
	const runUpdateCheck = async (): Promise<void> => {
		setUpdateChecking(true);
		try {
			const r = await checkAppUpdates();
			if (!r) {
				setUpdateStatus(t("settings.updatesOnlyDesktopApp"));
				setUpdateErrorDetail(null);
				return;
			}
			if (!r.enabled) {
				setUpdateStatus(t("settings.noUpdateSourceConfigured"));
				setUpdateErrorDetail(null);
			} else if (r.missingFeed) {
				// 404 on latest.yml: the release simply has no update metadata
				// for this platform yet — say so instead of crying network.
				setUpdateStatus(t("settings.updateFeedMissing"));
				setUpdateErrorDetail(null);
			} else if (r.error) {
				setUpdateStatus(
					r.errorKind && UPDATE_ERROR_BODY_KEYS[r.errorKind]
						? t(UPDATE_ERROR_BODY_KEYS[r.errorKind])
						: t("update.updateErrorCheck"),
				);
				setUpdateErrorDetail(r.error);
			} else if (r.newer) {
				setUpdateStatus(`${t("settings.newVersion")}: v${r.latest}`);
				setUpdateErrorDetail(null);
			} else {
				setUpdateStatus(`${t("settings.upDate")} (v${r.current ?? "?"})`);
				setUpdateErrorDetail(null);
			}
			setUpdateResult(r);
		} finally {
			setUpdateChecking(false);
		}
	};
	const [dotMatrixOn, setDotMatrixOn] = useState(() => localStorage.getItem("musepi-gui-dotmatrix") !== "0");
	const [welcomeGreeting, setWelcomeGreeting] = useState(readWelcomeGreeting);
	const [autostartEnabled, setAutostartEnabled] = useState(false);
	const [autostartSupported, setAutostartSupported] = useState(false);
	const [autostartBusy, setAutostartBusy] = useState(false);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<{ enabled: boolean; supported: boolean }>("system.getAutostart", {})
			.then(r => {
				if (!alive) return;
				setAutostartEnabled(r.enabled);
				setAutostartSupported(r.supported);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [rpc]);
	const toggleAutostart = (): void => {
		if (autostartBusy || !rpc) return;
		setAutostartBusy(true);
		const next = !autostartEnabled;
		void rpc
			.request<{ enabled: boolean }>("system.setAutostart", { enabled: next })
			.then(r => {
				setAutostartEnabled(r.enabled);
			})
			.catch(() => {
				setAutostartEnabled(false);
			})
			.finally(() => setAutostartBusy(false));
	};
	// Busy-state plain-Enter behavior: steer (TUI default) or
	// queue; Cmd/Ctrl+Enter uses the opposite.
	const [busyEnter, setBusyEnterState] = useState<"steer" | "queue">("steer");
	useEffect(() => {
		if (!rpc) return;
		void rpc
			.request<Record<string, unknown> | null>("settings.get", { keys: ["busyEnter"] })
			.then(v => {
				const b = v?.busyEnter;
				if (b === "queue" || b === "steer") setBusyEnterState(b);
			})
			.catch(() => {});
	}, [rpc]);
	const setBusyEnter = (next: "steer" | "queue"): void => {
		setBusyEnterState(next);
		void rpc
			?.request("settings.set", { key: "busyEnter", value: next })
			.then(() => dispatchSettingsChanged("busyEnter"))
			.catch(() => {});
	};
	const [dotMatrixText, setDotMatrixText] = useState(
		() => localStorage.getItem("musepi-gui-dotmatrix-text") ?? "MusePi",
	);
	// Close behavior (Windows/Linux): true = close hides to tray; false =
	// close quits and stops the owned daemon. Owned by the main process
	// (<userData>/window-behavior.json) — the close gate cannot wait on the
	// daemon — and mirrored here so the toggle reflects the real value.
	const [closeToTray, setCloseToTrayState] = useState(false);
	useEffect(() => {
		let alive = true;
		void getCloseToTray().then(v => {
			if (alive) setCloseToTrayState(v);
		});
		return () => {
			alive = false;
		};
	}, []);
	useEffect(() => {
		let alive = true;
		void getShellVersion().then(version => {
			if (alive) setShellVersion(version);
		});
		return () => {
			alive = false;
		};
	}, []);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			void rpc
				.request<{
					version?: string;
					musepiVersion?: string | null;
					engineVersion?: string;
					engine?: string;
					dataRoot?: string;
					configDir?: string;
					runtime?: string;
				}>("system.meta")
				.then(res => {
					if (alive) {
						setInfo(res ?? null);
						setMetaErr(null);
					}
				})
				.catch(err => alive && setMetaErr(err instanceof Error ? err.message : String(err)));
		};
		load();
		// After a data-root migration the daemon restarts and the WS drops;
		// poll until the reconnect serves the new root.
		const timer = setInterval(load, 4000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [rpc]);
	const daemonUrl = (() => {
		try {
			return localStorage.getItem("musepi-gui-url") ?? "ws://127.0.0.1:8300";
		} catch {
			return "ws://127.0.0.1:8300";
		}
	})();
	const versions = projectRuntimeVersions({ appVersion: shellVersion, meta: info, update: updateResult });
	return (
		<>
			<h2 className="gui-settings-page-title">{t("settings.general2")}</h2>
			<p className="gui-settings-page-desc">{t("settings.generalSettings")}</p>
			{/* Schema-driven settings on the general tab (settings.schema
			 * ui.tab = "general", group Power). The lid-open levels are the
			 * daemon's power.sleepPrevention; the lid-closed switch is
			 * power.preventLidSleep, applied by the shell (lib/lid-sleep-sync). */}
			<SchemaTabSection rpc={rpc} tabs={["general"]} />
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("settings.busyEnterBehavior")}</div>
					<div className="gui-settings-row-desc">{t("settings.busyEnterBehaviorDescription")}</div>
				</div>
				{/* A binary setting renders as the shared sliding Segmented (GuiSelect
				 * does this itself for two options); the `gui-input` class was what
				 * kept it a dropdown, which made this row look unlike every other
				 * two-choice setting in the app. */}
				<GuiSelect
					value={busyEnter}
					onChange={v => setBusyEnter(v === "queue" ? "queue" : "steer")}
					ariaLabel={t("settings.busyEnterBehavior")}
					options={[
						{ value: "queue", label: t("settings.busyEnterQueue") },
						{ value: "steer", label: t("settings.busyEnterSteer") },
					]}
				/>
			</div>
			{autostartSupported && (
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("settings.launchLogin")}</div>
						<div className="gui-settings-row-desc">{t("settings.launchLoginDescription")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={autostartEnabled}
						className={`gui-toggle${autostartEnabled ? " gui-toggle--on" : ""}`}
						disabled={autostartBusy}
						onClick={toggleAutostart}
						aria-label={t("settings.launchLogin")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
			)}
			{isElectron() && shellPlatform() !== "darwin" && (
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("settings.closeToTray")}</div>
						<div className="gui-settings-row-desc">{t("settings.closeToTrayDescription")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={closeToTray}
						className={`gui-toggle${closeToTray ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !closeToTray;
							setCloseToTrayState(next);
							void setCloseToTray(next);
						}}
						aria-label={t("settings.closeToTray")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
			)}
			<div className="gui-settings-row">
				<div className="w-full">
					<div className="gui-settings-row-label">{t("settings.welcomeGreeting")}</div>
					<div className="gui-settings-row-desc">{t("settings.welcomeGreetingDescription")}</div>
					<input
						className="gui-input mt-2 w-full max-w-[320px]"
						value={welcomeGreeting}
						maxLength={80}
						placeholder={t("settings.welcomeGreetingPlaceholder")}
						aria-label={t("settings.welcomeGreeting")}
						onChange={event => {
							setWelcomeGreeting(event.target.value);
							writeWelcomeGreeting(event.target.value);
						}}
					/>
				</div>
			</div>
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("settings.dotMatrixBackground")}</div>
					<div className="gui-settings-row-desc">{t("settings.dotMatrixBackgroundDescription")}</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={dotMatrixOn}
					className={`gui-toggle${dotMatrixOn ? " gui-toggle--on" : ""}`}
					onClick={() => {
						const next = !dotMatrixOn;
						setDotMatrixOn(next);
						localStorage.setItem("musepi-gui-dotmatrix", next ? "1" : "0");
						window.dispatchEvent(new CustomEvent("musepi-dotmatrix-changed"));
					}}
					aria-label={t("settings.dotMatrixBackground")}
				>
					<span className="gui-toggle-knob" />
				</button>
			</div>
			{dotMatrixOn && (
				<div className="gui-settings-row">
					<div className="w-full">
						<div className="gui-settings-row-label">{t("settings.dotMatrixText")}</div>
						<div className="gui-settings-row-desc">{t("settings.dotMatrixTextDescription")}</div>
						<input
							className="gui-input mt-2 w-full max-w-[320px]"
							value={dotMatrixText}
							maxLength={24}
							placeholder="MusePi"
							onChange={e => {
								const v = e.target.value;
								setDotMatrixText(v);
								localStorage.setItem("musepi-gui-dotmatrix-text", v);
								window.dispatchEvent(new CustomEvent("musepi-dotmatrix-changed"));
							}}
							aria-label={t("settings.dotMatrixText")}
						/>
						<div className="gui-dotmatrix-preview" aria-hidden="true">
							<DotMatrixMark text={dotMatrixText || "MusePi"} fontSize={96} />
						</div>
					</div>
				</div>
			)}
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("settings.daemon")}</div>
					<div className="text-[13px] text-[var(--color-text-muted)]">{daemonUrl}</div>
				</div>
			</div>
			{info && (
				<>
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("tools.version")}</div>
							<div className="text-[13px] text-[var(--color-text-muted)]">
								MusePi {versions.displayVersion ?? "—"}
							</div>
						</div>
					</div>
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("settings.daemonVersion")}</div>
							<div className="text-[13px] text-[var(--color-text-muted)]">{versions.daemonVersion ?? "—"}</div>
							{versions.daemonRefreshNeeded && (
								<div className="gui-settings-row-desc text-[var(--color-warning)]">
									{t("settings.daemonRefreshNeeded")}
								</div>
							)}
						</div>
					</div>
					{info.engineVersion && (
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("tools.engine")}</div>
								<div className="text-[13px] text-[var(--color-text-muted)]">
									{info.engine ?? `MusePi ${info.engineVersion}`}
								</div>
							</div>
						</div>
					)}
					<div className="gui-settings-row">
						<div className="w-full">
							<div className="gui-settings-row-label">{t("general.dataStoragePath")}</div>
							<div className="gui-settings-row-desc">{t("general.dataStoragePathDescription")}</div>
							<div className="mt-2 flex items-center gap-2">
								<div className="min-w-0 flex-1 truncate rounded-md border border-[var(--border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-text-muted)]">
									{pickedRoot ?? info?.dataRoot ?? info?.configDir ?? "—"}
								</div>
								{typeof window.electronAPI?.dataRootApply === "function" && (
									<>
										<button
											type="button"
											className="gui-btn px-3 py-1.5 text-[12.5px]"
											disabled={rootBusy}
											onClick={() => {
												void window.electronAPI
													?.openDirectory()
													.then(dir => {
														if (typeof dir === "string" && dir !== "") setPickedRoot(dir);
														setRootMsg(null);
													})
													.catch(err =>
														setRootMsg({
															ok: false,
															text: t("general.dataRootMigrateFailedWithError", {
																error: err instanceof Error ? err.message : String(err),
															}),
														}),
													);
											}}
										>
											{t("general.selectFolder")}
										</button>
										<button
											type="button"
											className="gui-btn gui-btn-primary px-3 py-1.5 text-[12.5px]"
											disabled={rootBusy || !pickedRoot}
											onClick={() => {
												if (!pickedRoot) return;
												setRootBusy(true);
												setRootMsg(null);
												void window.electronAPI
													?.dataRootApply(pickedRoot)
													.then(res => {
														if (res?.ok) {
															setPickedRoot(null);
															setRootMsg({ ok: true, text: t("general.dataRootMigrated") });
														} else {
															setRootMsg({
																ok: false,
																text: t("general.dataRootMigrateFailedWithError", {
																	error: res?.error ?? "unknown error",
																}),
															});
														}
													})
													.catch(err =>
														setRootMsg({
															ok: false,
															text: t("general.dataRootMigrateFailedWithError", {
																error: err instanceof Error ? err.message : String(err),
															}),
														}),
													)
													.finally(() => setRootBusy(false));
											}}
										>
											{t("general.save")}
										</button>
									</>
								)}
							</div>
							{rootMsg && (
								<div
									className={`mt-1.5 text-[12.5px] ${
										rootMsg.ok ? "text-[var(--color-success)]" : "text-[var(--color-warning)]"
									}`}
								>
									{rootMsg.text}
								</div>
							)}
						</div>
					</div>
					{info.runtime && (
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("tools.runtime")}</div>
								<div className="truncate text-[13px] text-[var(--color-text-muted)]">{info.runtime}</div>
							</div>
						</div>
					)}
					<div className="gui-settings-row">
						<div className="w-full">
							<div className="gui-settings-row-label">{t("settings.checkUpdates")}</div>
							<div className="gui-settings-row-desc">{updateStatus}</div>
							{updateErrorDetail && (
								<div className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-all text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
									{updateErrorDetail}
								</div>
							)}
							{updateResult?.newer && (
								<div className="gui-update-result">
									{updateResult.notes ? (
										<div className="gui-update-result-notes">
											<Markdown text={localizeUpdateNotes(updateResult.notes, locale)} />
										</div>
									) : null}
									<div className="gui-update-result-actions">
										{/* In-app download: the UpdateToast revives on the
										 * preparing push, so progress shows there.
										 * On builds that cannot OTA (ad-hoc signed macOS)
										 * the primary action grabs the installer instead. */}
										<button
											type="button"
											className="gui-btn gui-btn-primary"
											onClick={() =>
												void (updateResult.otaCapable === false && updateResult.url
													? downloadInstaller(updateResult.url)
													: downloadUpdate())
											}
										>
											{t(
												updateResult.otaCapable === false && updateResult.url
													? "settings.downloadInstaller"
													: "settings.downloadUpdate",
											)}
										</button>
										<button
											type="button"
											className="gui-btn"
											onClick={() =>
												void openExternalUrl(
													updateResult.url || "https://github.com/MuseLinn/MusePi/releases/latest",
												)
											}
										>
											<Icon name="download" className="h-3.5 w-3.5" />
											<span>{t("settings.goDownload")}</span>
										</button>
									</div>
								</div>
							)}
						</div>
						<button
							type="button"
							className="gui-btn"
							disabled={updateChecking}
							onClick={() => void runUpdateCheck()}
						>
							<Icon name="download" className="h-3.5 w-3.5" />
							<span>{updateChecking ? t("settings.checking") : t("settings.check")}</span>
						</button>
					</div>
				</>
			)}
			{metaErr && (
				<div className="gui-settings-row">
					<div className="text-[13px] text-[var(--color-warning)]">
						{t("tools.daemonMetaUnavailableWithReason")} {metaErr}
					</div>
				</div>
			)}
		</>
	);
}
