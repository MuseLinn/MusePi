import { type TranslationKey, t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
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

/** Preview of the two task-card styles (display.taskCardStyle settings
 *  row): Swarm = the classic chat-message task tool-call card with the
 *  floating frosted member-grid card beneath it (the composer chip opens
 *  that floating card); Classic = the plain tool-call card only. Static
 *  mock-ups — clicking either card switches the style (the preview IS the
 *  control; the standard select is hidden for this row). */
export function TaskCardStylePreview({
	value,
	onPick,
}: {
	value: unknown;
	onPick(style: "swarm" | "classic"): void;
}): ReactNode {
	const active = value === "classic" ? "classic" : "swarm";
	const classicCard = (
		<div className="gui-taskstyle-preview-chat">
			<div className="gui-taskstyle-preview-head">
				<span className="gui-taskstyle-preview-tool">task</span>
				<span className="gui-taskstyle-preview-chip">4 个任务</span>
				<span className="gui-taskstyle-preview-chip">4 / 4</span>
			</div>
		</div>
	);
	const swarm = (
		<div className="gui-taskstyle-preview-stack">
			{classicCard}
			{/* Floating member grid (composer chip → frosted card mock). */}
			<div className="gui-taskstyle-preview-float">
				<div className="gui-taskstyle-preview-head">
					<span className="gui-taskstyle-preview-title">Survey repos</span>
					<span className="gui-taskstyle-preview-chip">4 / 4</span>
				</div>
				<div className="gui-taskstyle-preview-grid">
					{[
						["SD", "ok"],
						["PR", "ok"],
						["OC", "ok"],
						["KC", "err"],
					].map(([ab, tone]) => (
						<div key={ab} className={`gui-taskstyle-preview-member gui-taskstyle-preview-member--${tone}`}>
							<span className={`gui-taskstyle-preview-avatar gui-taskstyle-preview-avatar--${tone}`}>{ab}</span>
							<span className="gui-taskstyle-preview-bar">
								<span className={`gui-taskstyle-preview-fill gui-taskstyle-preview-fill--${tone}`} />
							</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
	const classic = <div className="gui-taskstyle-preview-stack">{classicCard}</div>;
	return (
		<div className="gui-taskstyle-preview">
			<button
				type="button"
				className={`gui-taskstyle-preview-option${active === "swarm" ? " gui-taskstyle-preview-option--active" : ""}`}
				aria-pressed={active === "swarm"}
				onClick={() => onPick("swarm")}
			>
				{swarm}
				<span className="gui-taskstyle-preview-label">Swarm</span>
			</button>
			<button
				type="button"
				className={`gui-taskstyle-preview-option${active === "classic" ? " gui-taskstyle-preview-option--active" : ""}`}
				aria-pressed={active === "classic"}
				onClick={() => onPick("classic")}
			>
				{classic}
				<span className="gui-taskstyle-preview-label">Classic</span>
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
	const [updateChecking, setUpdateChecking] = useState(false);
	const runUpdateCheck = async (): Promise<void> => {
		const api = (window as unknown as { electronAPI?: { checkUpdates?(): Promise<unknown> } }).electronAPI;
		if (!api?.checkUpdates) {
			setUpdateStatus(t("updates only in the desktop app"));
			return;
		}
		setUpdateChecking(true);
		try {
			const r = (await api.checkUpdates()) as {
				enabled?: boolean;
				newer?: boolean;
				latest?: string;
				current?: string;
				url?: string;
				error?: string;
				reason?: string;
			};
			if (!r.enabled) setUpdateStatus(t("no update source configured"));
			else if (r.error) setUpdateStatus(`⚠ ${r.error}`);
			else if (r.newer) {
				setUpdateStatus(`${t("new version")}: v${r.latest}`);
				if (r.url) window.open(r.url, "_blank");
			} else setUpdateStatus(`${t("up to date")} (v${r.current ?? "?"})`);
		} finally {
			setUpdateChecking(false);
		}
	};
	const [dotMatrixOn, setDotMatrixOn] = useState(() => localStorage.getItem("musepi-gui-dotmatrix") !== "0");
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
	const [keepAwake, setKeepAwake] = useState(() => localStorage.getItem("musepi-gui-keep-awake") === "1");
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
					<div className="gui-settings-row-label">{t("keep computer awake")}</div>
					<div className="gui-settings-row-desc">{t("keep computer awake description")}</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={keepAwake}
					className={`gui-toggle${keepAwake ? " gui-toggle--on" : ""}`}
					onClick={() => {
						const next = !keepAwake;
						setKeepAwake(next);
						localStorage.setItem("musepi-gui-keep-awake", next ? "1" : "0");
						void (
							window as unknown as { electronAPI?: { setKeepAwake?(v: boolean): Promise<unknown> } }
						).electronAPI?.setKeepAwake?.(next);
					}}
					aria-label={t("keep computer awake")}
				>
					<span className="gui-toggle-knob" />
				</button>
			</div>
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
								<div className="text-[13px] text-[var(--color-text-muted)]">OMP {info.engineVersion}</div>
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
						<div>
							<div className="gui-settings-row-label">{t("check for updates")}</div>
							<div className="gui-settings-row-desc">{updateStatus}</div>
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
