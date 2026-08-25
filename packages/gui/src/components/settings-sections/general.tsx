import { type TranslationKey, t } from "@musepi/desktop-web";
import { ToolView } from "@musepi/desktop-web/src/tool-render/ToolView";
import { taskRenderer } from "@musepi/desktop-web/src/tool-render/tools/task";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { checkAppUpdates, openExternalUrl, type UpdateCheckResult } from "../../lib/electron";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";
import {
	AVATAR_PRESETS,
	avatarPresetId,
	PunkAvatar,
	randomPunkSeed,
	setPunkSeed,
	userPunkSeed,
} from "../avatar-presets";
import { DotMatrixMark } from "../DotMatrixMark";
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
 *  that floating card); OMP original (Classic) = the plain tool-call card
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
				<span className="gui-taskstyle-preview-label">{t("MusePi Swarm")}</span>
			</button>
			<button
				type="button"
				className={`gui-taskstyle-preview-option${active === "classic" ? " gui-taskstyle-preview-option--active" : ""}`}
				aria-pressed={active === "classic"}
				onClick={() => onPick("classic")}
			>
				{classic}
				<span className="gui-taskstyle-preview-label">{t("MusePi original (Classic)")}</span>
			</button>
		</div>
	);
}

export function GeneralSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [info, setInfo] = useState<{
		version?: string;
		musepiVersion?: string | null;
		engineVersion?: string;
		engine?: string;
		dataRoot?: string;
		configDir?: string;
		runtime?: string;
	} | null>(null);
	const [metaErr, setMetaErr] = useState<string | null>(null);
	const [pickedRoot, setPickedRoot] = useState<string | null>(null);
	const [rootBusy, setRootBusy] = useState(false);
	const [rootMsg, setRootMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const [updateStatus, setUpdateStatus] = useState<string>(t("check for updates"));
	// Full check result kept for the richer row: notes snippet + explicit
	// 前往下载 button instead of the old surprise window.open popup.
	const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
	const [updateChecking, setUpdateChecking] = useState(false);
	const runUpdateCheck = async (): Promise<void> => {
		setUpdateChecking(true);
		try {
			const r = await checkAppUpdates();
			if (!r) {
				setUpdateStatus(t("updates only in the desktop app"));
				return;
			}
			if (!r.enabled) setUpdateStatus(t("no update source configured"));
			else if (r.error) setUpdateStatus(`⚠ ${r.error}`);
			else if (r.newer) setUpdateStatus(`${t("new version")}: v${r.latest}`);
			else setUpdateStatus(`${t("up to date")} (v${r.current ?? "?"})`);
			setUpdateResult(r);
		} finally {
			setUpdateChecking(false);
		}
	};
	const [dotMatrixOn, setDotMatrixOn] = useState(() => localStorage.getItem("musepi-gui-dotmatrix") !== "0");
	const [autostartEnabled, setAutostartEnabled] = useState(false);
	const [autostartSupported, setAutostartSupported] = useState(false);
	const [autostartBusy, setAutostartBusy] = useState(false);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc.request<{ enabled: boolean; supported: boolean }>("system.getAutostart", {}).then(r => {
			if (!alive) return;
			setAutostartEnabled(r.enabled);
			setAutostartSupported(r.supported);
		}).catch(() => {});
		return () => { alive = false; };
	}, [rpc]);
	const toggleAutostart = (): void => {
		if (autostartBusy || !rpc) return;
		setAutostartBusy(true);
		const next = !autostartEnabled;
		void rpc.request<{ enabled: boolean }>("system.setAutostart", { enabled: next }).then(r => {
			setAutostartEnabled(r.enabled);
		}).catch(() => {
			setAutostartEnabled(false);
		}).finally(() => setAutostartBusy(false));
	};
	const [avatarId, setAvatarId] = useState<string>(avatarPresetId);
	const [punkSeedInput, setPunkSeedInput] = useState<string>(userPunkSeed() ?? "");
	// Busy-state plain-Enter behavior (dsh parity): steer (TUI default) or
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
			.then(() => window.dispatchEvent(new CustomEvent("omp-settings-changed", { detail: { key: "busyEnter" } })))
			.catch(() => {});
	};
	const [dotMatrixText, setDotMatrixText] = useState(
		() => localStorage.getItem("musepi-gui-dotmatrix-text") ?? "MusePi",
	);
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
	return (
		<>
			<h2 className="gui-settings-page-title">{t("general")}</h2>
			<p className="gui-settings-page-desc">{t("general settings")}</p>
			{/* Schema-driven settings on the general tab (settings.schema
			 * ui.tab = "general", e.g. power.sleepPrevention). Rendered here
			 * so the daemon's single source of truth drives the panel; the
			 * old hand-written "保持电脑运行" toggle was replaced by this
			 * four-level Sleep Prevention enum. */}
			<SchemaTabSection rpc={rpc} tabs={["general"]} />
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("busy enter behavior")}</div>
					<div className="gui-settings-row-desc">{t("busy enter behavior description")}</div>
				</div>
				<GuiSelect
					className="gui-input max-w-[200px]"
					value={busyEnter}
					onChange={v => setBusyEnter(v === "queue" ? "queue" : "steer")}
					ariaLabel={t("busy enter behavior")}
					options={[
						{ value: "queue", label: t("busy enter queue") },
						{ value: "steer", label: t("busy enter steer") },
					]}
				/>
			</div>
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("agent avatar style")}</div>
					<div className="gui-settings-row-desc">{t("agent avatar style description")}</div>
				</div>
				<div className="flex items-center gap-1.5">
					{AVATAR_PRESETS.map(p => (
						<button
							key={p.id}
							type="button"
							className={`gui-avatar-opt${avatarId === p.id ? " gui-avatar-opt--active" : ""}`}
							title={t(p.labelKey as TranslationKey)}
							aria-pressed={avatarId === p.id}
							onClick={() => {
								setAvatarId(p.id);
								localStorage.setItem("musepi-gui-avatar", p.id);
								window.dispatchEvent(new CustomEvent("omp-avatar-changed"));
							}}
						>
							{p.render("working", 20)}
						</button>
					))}
				</div>
			</div>
			{avatarId === "punk" && (
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("pixel face")}</div>
						<div className="gui-settings-row-desc">{t("pixel face description")}</div>
					</div>
					<div className="flex items-center gap-2">
						<PunkAvatar size={40} />
						<button
							type="button"
							className="gui-btn gui-btn--secondary"
							onClick={() => {
								setPunkSeedInput("");
								setPunkSeed(randomPunkSeed());
							}}
						>
							{t("change face")}
						</button>
						<input
							className="gui-input w-[150px]"
							value={punkSeedInput}
							placeholder={t("face seed")}
							aria-label={t("face seed")}
							onChange={e => setPunkSeedInput(e.target.value)}
							onKeyDown={e => {
								if (e.key === "Enter" && punkSeedInput.trim()) setPunkSeed(punkSeedInput.trim());
							}}
						/>
						<button
							type="button"
							className="gui-btn gui-btn--secondary"
							disabled={!punkSeedInput.trim()}
							onClick={() => setPunkSeed(punkSeedInput.trim())}
						>
							{t("apply")}
						</button>
					</div>
				</div>
			)}
			{autostartSupported && (
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("launch at login")}</div>
						<div className="gui-settings-row-desc">{t("launch at login description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={autostartEnabled}
						className={`gui-toggle${autostartEnabled ? " gui-toggle--on" : ""}`}
						disabled={autostartBusy}
						onClick={toggleAutostart}
						aria-label={t("launch at login")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
			)}
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("dot matrix background")}</div>
					<div className="gui-settings-row-desc">{t("dot matrix background description")}</div>
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
					aria-label={t("dot matrix background")}
				>
					<span className="gui-toggle-knob" />
				</button>
			</div>
			{dotMatrixOn && (
				<div className="gui-settings-row">
					<div className="w-full">
						<div className="gui-settings-row-label">{t("dot matrix text")}</div>
						<div className="gui-settings-row-desc">{t("dot matrix text description")}</div>
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
							aria-label={t("dot matrix text")}
						/>
						<div className="gui-dotmatrix-preview" aria-hidden="true">
							<DotMatrixMark text={dotMatrixText || "MusePi"} fontSize={96} />
						</div>
					</div>
				</div>
			)}
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("daemon")}</div>
					<div className="text-[13px] text-[var(--color-text-muted)]">{daemonUrl}</div>
				</div>
			</div>
			{info && (
				<>
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("version")}</div>
							{/* MusePi brand version first; the daemon reports the OMP
							 * engine version when it was spawned unbranded. */}
							<div className="text-[13px] text-[var(--color-text-muted)]">
								MusePi {info.musepiVersion ?? info.version}
							</div>
						</div>
					</div>
					{info.engineVersion && (
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("engine")}</div>
								<div className="text-[13px] text-[var(--color-text-muted)]">
									{info.engine ?? `MusePi ${info.engineVersion}`}
								</div>
							</div>
						</div>
					)}
					<div className="gui-settings-row">
						<div className="w-full">
							<div className="gui-settings-row-label">{t("data storage path")}</div>
							<div className="gui-settings-row-desc">{t("data storage path description")}</div>
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
															text: t("data root migrate failed: {error}", {
																error: err instanceof Error ? err.message : String(err),
															}),
														}),
													);
											}}
										>
											{t("select folder")}
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
															setRootMsg({ ok: true, text: t("data root migrated") });
														} else {
															setRootMsg({
																ok: false,
																text: t("data root migrate failed: {error}", {
																	error: res?.error ?? "unknown error",
																}),
															});
														}
													})
													.catch(err =>
														setRootMsg({
															ok: false,
															text: t("data root migrate failed: {error}", {
																error: err instanceof Error ? err.message : String(err),
															}),
														}),
													)
													.finally(() => setRootBusy(false));
											}}
										>
											{t("save")}
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
								<div className="gui-settings-row-label">{t("runtime")}</div>
								<div className="truncate text-[13px] text-[var(--color-text-muted)]">{info.runtime}</div>
							</div>
						</div>
					)}
					<div className="gui-settings-row">
						<div className="w-full">
							<div className="gui-settings-row-label">{t("check for updates")}</div>
							<div className="gui-settings-row-desc">{updateStatus}</div>
							{updateResult?.newer && (
								<div className="gui-update-result">
									{updateResult.notes ? (
										<div className="gui-update-result-notes">{updateResult.notes}</div>
									) : null}
									<button
										type="button"
										className="gui-btn gui-btn-primary"
										onClick={() =>
											void openExternalUrl(
												updateResult.url || "https://github.com/MuseLinn/MusePi/releases/latest",
											)
										}
									>
										<Icon name="download" className="h-3.5 w-3.5" />
										<span>{t("go to download")}</span>
									</button>
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
							<span>{updateChecking ? t("checking…") : t("check")}</span>
						</button>
					</div>
				</>
			)}
			{metaErr && (
				<div className="gui-settings-row">
					<div className="text-[13px] text-[var(--color-warning)]">
						{t("daemon meta unavailable: {reason}")} {metaErr}
					</div>
				</div>
			)}
		</>
	);
}
