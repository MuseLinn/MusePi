/*
 * Settings → 语音: dedicated voice I/O section. The stt.* / tts.* schema keys
 * render through <SchemaTabSection tabs={["interaction"]}> (the daemon
 * schema is the single source of truth — the same rows used to be
 * hand-duplicated here with hardcoded defaults that never loaded real
 * values, and drifted from the 交互 tab's schema-driven copies), EXCEPT
 * `stt.modelName` which this file renders as a radio-row picker card (a bare
 * enum dropdown buried in the list made the four tiers unreadable).
 * This file keeps only what the schema cannot express: the speech-model
 * picker, live mic enumeration (liquid-glass floating menu), the dictation
 * test state machine, and the TTS test card.
 */
import { t, tLoose } from "@musepi/client-core";
import { isSttDownloadEvent, type SttModelRow, type SttModelStatusResponse } from "@musepi/pi-wire";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import "../../i18n/voice";
import type { RpcClient } from "../../lib/rpc";
import { useFloatingMenu } from "../../lib/use-floating-menu";
import {
	enumerateMicDevices,
	getVoiceInputDevice,
	setVoiceInputDevice,
	speak,
	startDictation,
	type VoiceActivity,
} from "../../lib/voice";
import { Icon } from "../../vendor/oc-icons";
import { StateIconN } from "../StateIcon";
import { SchemaTabSection } from "./schema";

/* ── Speech-model download state (stt.modelStatus / stt.modelDownload) ──
 *  The RPC contract (`SttModelRow` / `SttModelStatusResponse` / the
 *  `SttDownloadEvent` union + its guard) lives in @musepi/pi-wire so the
 *  desktop and guest shells can never drift apart. Only the renderer's own
 *  row state stays local. */
/** Active-download row. The event shape itself lives in @musepi/pi-wire
 *  (`SttDownloadEvent` + `isSttDownloadEvent`) — shared with the guest
 *  client so both shells narrow the daemon's untyped payload the same way. */
interface ActiveDownload {
	modelKey: string;
	percent: number;
	loaded: number;
	total: number;
	label: string;
}

function formatBytes(n: number): string {
	if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
	if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(0)} MB`;
	if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`;
	return `${n} B`;
}

/** Per-model row: label + 已就绪 badge or a download button with a live
 * progress bar while the daemon fetches. Progress AND both terminal
 * outcomes ride the global event stream (`stt.downloadProgress` /
 * `stt.downloadDone` / `stt.downloadError`), so state survives page
 * remounts and stays in sync across every open window. */
/** Per-tier presentation metadata (openchamber model-card parity): size
 *  mirrors `stt/models.ts` `sizeHint`; badge/desc are humanized one-liners
 *  (i18n keys registered by i18n/voice.ts — the English sentence IS the key,
 *  matching the core map's contract). Local UI data only — the wire row
 *  stays { key, label, cached }. Kept in sync with
 *  composer/voice-setup.tsx SIZE_HINTS. */
const TIER_META: Record<string, { size: string; badge?: string; desc: string }> = {
	fast: { size: "~60 MB", badge: "Lightweight", desc: "Lightweight and fast — best for quick English notes" },
	balanced: {
		size: "~190 MB",
		badge: "Multilingual · default",
		desc: "Balanced default — multilingual, Chinese included",
	},
	turbo: { size: "~600 MB", badge: "99 languages", desc: "Widest language coverage — larger download, slower" },
	// Parakeet TDT v3's 25 languages are all European — the sherpa worker
	// cannot switch language, so CJK speech transcribes to empty. The copy
	// must say so: zh users picking the SoTA badge blindly got silence.
	parakeet: {
		size: "~680 MB",
		badge: "SoTA · EN/EU only",
		desc: "Top accuracy for English & European speech — no Chinese",
	},
	sensevoice: {
		size: "~239 MB",
		badge: "Chinese-optimized · zh/en",
		desc: "Chinese-optimized — Mandarin, Cantonese & mixed zh/en",
	},
};

/** Speech-model picker: ONE card where each tier is a radio row — selecting
 *  a tier writes `stt.modelName` and, when its weights aren't cached, kicks
 *  the download automatically (the old four separate cards made the choice
 *  look like four parallel features instead of one decision). Progress AND
 *  both terminal outcomes ride the global event stream
 *  (`stt.downloadProgress` / `stt.downloadDone` / `stt.downloadError`), so
 *  state survives page remounts and stays in sync across every open window. */
function ModelPickerCard({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [models, setModels] = useState<SttModelRow[] | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [active, setActive] = useState<ActiveDownload | null>(null);
	const [error, setError] = useState<{ modelKey: string; message: string } | null>(null);
	// Single settlement timer: cleared before rescheduling and on unmount,
	// so stacked terminal events can never fire stale refreshes.
	const settleTimer = useRef<number | null>(null);

	const refresh = useCallback(() => {
		void rpc
			?.request<SttModelStatusResponse>("stt.modelStatus", {})
			.then(res => {
				setModels(res.models);
				// Window mounted mid-download: seed a 0% row from the daemon's
				// in-flight list instead of showing an enabled download button
				// until the next progress tick arrives.
				setActive(
					prev =>
						prev ??
						(res.downloads?.[0]
							? { modelKey: res.downloads[0], percent: 0, loaded: 0, total: 0, label: "" }
							: null),
				);
			})
			.catch(() => setModels([]));
	}, [rpc]);

	useEffect(() => {
		refresh();
		// Seed the radio selection from the live setting (default tier when unset).
		void rpc
			?.request<Record<string, unknown>>("settings.get", { keys: ["stt.modelName"] })
			.then(v => {
				if (typeof v?.["stt.modelName"] === "string") setSelected(v["stt.modelName"] as string);
			})
			.catch(() => {});
		if (!rpc) return;
		const off = rpc.addEventListener(event => {
			const p = event.payload;
			if (!isSttDownloadEvent(p)) return;
			if (p.type === "stt.downloadProgress") {
				setActive({
					modelKey: p.modelKey,
					percent: p.percent,
					loaded: p.loaded ?? 0,
					total: p.total ?? 0,
					label: p.label ?? "",
				});
				return;
			}
			if (p.type === "stt.downloadDone") {
				// Let the bar paint 100% briefly, then clear + re-check cache.
				if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
				settleTimer.current = window.setTimeout(() => {
					settleTimer.current = null;
					setActive(null);
					refresh();
				}, 1200);
				return;
			}
			// p.type === "stt.downloadError": fire-and-forget request means
			// the RPC itself never rejects — the failure only arrives here.
			// Keep the tier key so the row can be named; other models' UI
			// state is untouched.
			// Guard checks `type` only, so the text fields still get a
			// runtime fallback (an untyped daemon could omit them).
			setError({ modelKey: p.modelKey ?? "", message: p.message ?? "download failed" });
			// Retire the stuck row: without this the tier stays on a progress
			// bar that will never advance (guest parity).
			setActive(null);
			refresh();
		});
		return () => {
			off();
			if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
		};
	}, [rpc, refresh]);

	const download = useCallback(
		(modelKey: string): void => {
			setError(null);
			setActive({ modelKey, percent: 0, loaded: 0, total: 0, label: "" });
			void rpc?.request("stt.modelDownload", { modelKey }).catch(err => {
				// Only reachable for immediate rejections (bad key, daemon offline).
				setActive(null);
				setError({ modelKey, message: err instanceof Error ? err.message : String(err) });
			});
		},
		[rpc],
	);

	const select = (modelKey: string): void => {
		if (!rpc || modelKey === selected) return;
		setSelected(modelKey);
		setError(null);
		void rpc.request("settings.set", { key: "stt.modelName", value: modelKey }).catch(err => {
			setError({ modelKey, message: err instanceof Error ? err.message : String(err) });
		});
	};

	// Selecting an uncached tier starts its download — both for explicit
	// clicks (handled in the row's onChange via `download`) and for a seed
	// selection pointing at weights that aren't on disk yet (fresh machine).
	const selectedRow = models?.find(m => m.key === selected) ?? null;
	useEffect(() => {
		if (!selectedRow || selectedRow.cached || active !== null) return;
		download(selectedRow.key);
	}, [selectedRow, active, download]);

	const errorLabel = error ? models?.find(m => m.key === error.modelKey)?.label : undefined;

	return (
		<div className="gui-settings-section">
			<div className="gui-settings-section-title">{tLoose("speech recognition model")}</div>
			{models === null ? (
				<div className="gui-settings-row">
					<div className="gui-settings-row-desc">…</div>
				</div>
			) : (
				<div className="gui-stt-picker" role="radiogroup" aria-label={tLoose("speech recognition model")}>
					{models.map(m => {
						const isSelected = selected === m.key;
						const isActive = active?.modelKey === m.key;
						const meta = TIER_META[m.key] ?? { size: "", desc: "" };
						return (
							<div key={m.key} className={`gui-stt-row${isSelected ? " gui-stt-row--selected" : ""}`}>
								<label className="gui-stt-row-radio">
									<input
										type="radio"
										name="stt-model"
										checked={isSelected}
										disabled={!rpc}
										onChange={() => {
											select(m.key);
											// Auto-fetch on pick: a selected tier you
											// cannot use (weights missing, no download
											// running) is a broken default — mirror the
											// effect above for the click path.
											if (!m.cached && active === null) download(m.key);
										}}
									/>
									<span className="gui-stt-row-main">
										<span className="gui-stt-row-head">
											<span className="gui-stt-row-label">{m.label}</span>
											{meta.badge && <span className="gui-stt-badge">{tLoose(meta.badge)}</span>}
											<span className="gui-stt-row-size">{meta.size}</span>
										</span>
										<span className="gui-stt-row-desc">{tLoose(meta.desc)}</span>
										{isActive ? (
											<span className="gui-stt-row-progress" aria-live="polite">
												<progress
													max={100}
													value={active.percent}
													aria-label={`${m.label} ${active.percent}%`}
												/>
												<span>
													{active.percent}% · {active.label} {formatBytes(active.loaded)}
													{active.total > 0 ? ` / ${formatBytes(active.total)}` : ""}
												</span>
											</span>
										) : null}
									</span>
								</label>
								{m.cached ? (
									<span className="gui-stt-row-ready">✓ {t("model ready offline")}</span>
								) : !isActive ? (
									<button
										type="button"
										className="gui-btn"
										disabled={!rpc || active !== null}
										onClick={() => download(m.key)}
									>
										<Icon name="download" className="h-3.5 w-3.5" />
										{t("download")}
									</button>
								) : null}
							</div>
						);
					})}
				</div>
			)}
			{selectedRow && !selectedRow.cached && (
				<div className="gui-settings-row-desc">{tLoose("downloads automatically when selected")}</div>
			)}
			{error && (
				<div className="gui-settings-row">
					<div className="gui-settings-row-desc" role="alert">
						{errorLabel ? `${errorLabel}: ` : ""}
						{error.message}
					</div>
					<button type="button" className="gui-btn" aria-label="dismiss" onClick={() => setError(null)}>
						✕
					</button>
				</div>
			)}
		</div>
	);
}

/** TTS test card: synthesizes the sample phrase with the CURRENT schema
 * values (read live from settings.get, so the test always matches what
 * chat playback will use). */
function TtsTestCard({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [state, setState] = useState<"idle" | "loading" | "speaking" | "ok" | "error">("idle");
	const [err, setErr] = useState("");
	const stopRef = useRef<(() => void) | null>(null);
	useEffect(() => () => stopRef.current?.(), []);
	const toggle = (): void => {
		if (state === "speaking" || state === "loading") {
			stopRef.current?.();
			setState("idle");
			return;
		}
		setState("loading");
		setErr("");
		void rpc
			?.request<Record<string, unknown>>("settings.get", { keys: ["tts.localVoice", "tts.rate", "tts.inputMode"] })
			.then(
				v =>
					new Promise<void>(resolve => {
						stopRef.current = speak(
							t("voice output sample"),
							rpc,
							{
								voice: typeof v["tts.localVoice"] === "string" ? (v["tts.localVoice"] as string) : undefined,
								rate: typeof v["tts.rate"] === "number" ? (v["tts.rate"] as number) : undefined,
								mode:
									typeof v["tts.inputMode"] === "string"
										? (v["tts.inputMode"] as "raw" | "sanitize" | "summarize")
										: undefined,
							},
							(a: VoiceActivity) => {
								if (a.phase === "speaking") setState("speaking");
								else if (a.phase === "done") setState("ok");
								else if (a.phase === "stopped") setState("idle");
								else if (a.phase === "error") {
									setState("error");
									setErr(a.message);
								}
								if (a.phase === "done" || a.phase === "stopped" || a.phase === "error") resolve();
							},
						);
					}),
			)
			.catch(() => {})
			.finally(() => {
				/* state driven by activity callback */
			});
	};
	return (
		<div className="gui-settings-row">
			<div>
				<div className="gui-settings-row-label">{t("voice output test")}</div>
				<div className="gui-settings-row-desc" aria-live="polite">
					{state === "ok"
						? t("voice output played")
						: state === "error"
							? err
							: t("voice output test description")}
				</div>
			</div>
			<button type="button" className="gui-btn" disabled={!rpc} onClick={toggle}>
				<StateIconN
					value={state}
					options={{ loading: "download", speaking: "stop", idle: "play" }}
					className="h-3.5 w-3.5"
				/>
				{state === "speaking" || state === "loading" ? t("stop") : t("voice output test")}
			</button>
		</div>
	);
}

/** Liquid-glass input-device picker: replaces the native <select> (which
 *  broke the settings surface's visual language) with a floating menu in the
 *  composer AttachMenu style. The value stays machine-local (localStorage
 *  via setVoiceInputDevice) and is picked up by every dictation entry point. */
function InputDeviceMenu({
	devices,
	deviceId,
	onChange,
}: {
	devices: { deviceId: string; label: string }[];
	deviceId: string | null;
	onChange(deviceId: string | null): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const { anchorRef, renderMenu } = useFloatingMenu(open, setOpen);
	const current = devices.find(d => d.deviceId === deviceId);
	return (
		<div className="gui-voice-device" ref={anchorRef}>
			<button
				type="button"
				className="gui-btn"
				disabled={devices.length === 0}
				aria-label={t("voice input device")}
				aria-expanded={open}
				aria-haspopup="menu"
				onClick={() => setOpen(v => !v)}
			>
				<Icon name="mic" className="h-3.5 w-3.5" />
				<span className="gui-voice-device-label">{current?.label ?? t("system default")}</span>
				<Icon name="arrow-down-s" className="h-3.5 w-3.5" />
			</button>
			{renderMenu(
				<div className="gui-attach-menu" role="menu" aria-label={t("voice input device")}>
					<button
						type="button"
						className="gui-attach-opt"
						role="menuitemradio"
						aria-checked={deviceId === null}
						onClick={() => {
							onChange(null);
							setOpen(false);
						}}
					>
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("system default")}</span>
						</span>
						{deviceId === null && <Icon name="check" className="h-4 w-4" />}
					</button>
					{devices.map(d => (
						<button
							key={d.deviceId}
							type="button"
							className="gui-attach-opt"
							role="menuitemradio"
							aria-checked={deviceId === d.deviceId}
							onClick={() => {
								onChange(d.deviceId);
								setOpen(false);
							}}
						>
							<span className="min-w-0 flex-1">
								<span className="gui-attach-opt-title">{d.label}</span>
							</span>
							{deviceId === d.deviceId && <Icon name="check" className="h-4 w-4" />}
						</button>
					))}
				</div>,
			)}
		</div>
	);
}

/** Settings → 语音。 */
export function VoiceSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	// Schema keys render via SchemaTabSection below — minus stt.modelName,
	// which the picker card above renders as radio rows (a bare enum
	// dropdown made the tiers unreadable). Local state covers only the live
	// mic test (device enumeration + dictation round-trip).
	const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
	// Selected microphone (deviceId, null = system default). Seeded from the
	// same machine-local key the dictation entry points read.
	const [deviceId, setDeviceId] = useState<string | null>(() => getVoiceInputDevice());
	// Dictation test state machine: idle → recording (live level meter) →
	// transcribing → result / error. `dictating` owns the toggle button;
	// phase drives the status copy and meter.
	const [dictating, setDictating] = useState(false);
	const [dictationPhase, setDictationPhase] = useState<"idle" | "recording" | "transcribing">("idle");
	const [recordSeconds, setRecordSeconds] = useState(0);
	const [recordLevel, setRecordLevel] = useState(0);
	const [dictated, setDictated] = useState<string | null>(null);
	const [dictationError, setDictationError] = useState<string | null>(null);
	const stopRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		void enumerateMicDevices()
			.then(setDevices)
			.catch(() => setDevices([]));
		return () => stopRef.current?.();
	}, []);

	const toggleDictation = (): void => {
		if (dictating) {
			// Stop = "finish early and transcribe" (#23 D contract): the full
			// buffer is kept, so a manual stop still produces a result.
			stopRef.current?.();
			return;
		}
		setDictated(null);
		setDictationError(null);
		setRecordSeconds(0);
		setRecordLevel(0);
		setDictating(true);
		setDictationPhase("recording");
		const stop = startDictation(
			(text: string) => {
				setDictated(text);
				setDictating(false);
				setDictationPhase("idle");
			},
			(message: string) => {
				// startDictation routes known failures through
				// friendlyDictationError already — surface as-is.
				setDictationError(message);
				setDictating(false);
				setDictationPhase("idle");
			},
			rpc,
			(a: VoiceActivity) => {
				if (a.phase === "recording") {
					setDictationPhase("recording");
					setRecordSeconds(a.seconds);
					setRecordLevel(a.level);
				} else if (a.phase === "transcribing") {
					setDictationPhase("transcribing");
				} else if (a.phase === "stopped") {
					setDictating(false);
					setDictationPhase("idle");
				} else if (a.phase === "error") {
					setDictationError(a.message);
					setDictating(false);
					setDictationPhase("idle");
				}
			},
		);
		if (!stop) {
			// Neither daemon RPC nor Web Speech fallback available.
			setDictating(false);
			setDictationPhase("idle");
			return;
		}
		stopRef.current = stop;
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("voice")}</h2>

			{/* Schema-driven stt.* / tts.* rows — only the interaction tab's
			 * "Speech" group, NOT the whole tab (the rest of the interaction
			 * groups live on 交互; duplicating them here was the old bug).
			 * stt.modelName is excluded: the picker card owns it. */}
			<SchemaTabSection rpc={rpc} tabs={["interaction"]} groups={["Speech"]} excludeKeys={["stt.modelName"]} />
			<ModelPickerCard rpc={rpc} />

			{/* Live device + dictation test: not expressible in schema. */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("voice input test")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("voice input device")}</div>
						<div className="gui-settings-row-desc">
							{devices.length > 0 ? t("voice input device hint") : t("voice input test description")}
						</div>
					</div>
					{/* A floating-menu picker, not a native <select>: the value is
					 * stored under a machine-local key and is picked up by every
					 * dictation entry point. */}
					<InputDeviceMenu
						devices={devices}
						deviceId={deviceId}
						onChange={next => {
							setDeviceId(next);
							setVoiceInputDevice(next);
						}}
					/>
				</div>
				<div className="gui-settings-row">
					<div className="gui-voice-test">
						<div className="gui-settings-row-label">{t("voice input test")}</div>
						<div className="gui-settings-row-desc" aria-live="polite">
							{dictationError ??
								dictated ??
								(dictationPhase === "recording"
									? `${tLoose("Listening… speak now")} · ${recordSeconds}s`
									: dictationPhase === "transcribing"
										? t("voice transcribing")
										: t("voice input test description"))}
						</div>
						{dictationPhase === "recording" && (
							<div className="gui-voice-level" aria-hidden>
								<span
									className="gui-voice-level-fill"
									style={{ width: `${Math.min(100, Math.round(recordLevel * 100))}%` }}
								/>
							</div>
						)}
					</div>
					<button type="button" className="gui-btn" disabled={!rpc} onClick={toggleDictation}>
						<Icon
							name={dictationPhase === "recording" || dictationPhase === "transcribing" ? "stop" : "mic"}
							className="h-3.5 w-3.5"
						/>
						{dictationPhase === "recording"
							? t("stop")
							: dictationPhase === "transcribing"
								? t("voice transcribing")
								: t("voice input test")}
					</button>
				</div>
			</div>

			<TtsTestCard rpc={rpc} />
		</>
	);
}
