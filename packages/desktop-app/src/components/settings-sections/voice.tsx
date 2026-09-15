/*
 * Settings → 语音: dedicated voice I/O section. The stt.* / tts.* schema keys
 * render through <SchemaTabSection tabs={["interaction"]}> (the daemon
 * schema is the single source of truth — the same rows used to be
 * hand-duplicated here with hardcoded defaults that never loaded real
 * values, and drifted from the 交互 tab's schema-driven copies). This file
 * keeps only what the schema cannot express: live mic enumeration, the
 * dictation test, and the TTS test card.
 */
import { t } from "@musepi/guest-client";
import { isSttDownloadEvent, type SttModelRow, type SttModelStatusResponse } from "@musepi/pi-wire";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import {
	enumerateMicDevices,
	getVoiceInputDevice,
	setVoiceInputDevice,
	speak,
	startDictation,
	type VoiceActivity,
} from "../../lib/voice";
import { Icon } from "../../vendor/oc-icons";
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
/** Per-tier presentation metadata (openchamber model-card parity): accuracy /
 *  speed are 0-100 bars derived from the Open ASR Leaderboard positioning in
 *  `stt/models.ts`; size mirrors that file's sizeHint. Local UI data only — the
 *  wire row stays { key, label, cached }. */
const TIER_META: Record<string, { accuracy: number; speed: number; size: string; badge?: string }> = {
	fast: { accuracy: 35, speed: 92, size: "~60 MB", badge: "轻量" },
	balanced: { accuracy: 55, speed: 72, size: "~190 MB" },
	turbo: { accuracy: 85, speed: 45, size: "~600 MB" },
	parakeet: { accuracy: 97, speed: 96, size: "~680 MB", badge: "SoTA" },
};

function ModelDownloadCard({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [models, setModels] = useState<SttModelRow[] | null>(null);
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

	const download = (modelKey: string): void => {
		setError(null);
		setActive({ modelKey, percent: 0, loaded: 0, total: 0, label: "" });
		void rpc?.request("stt.modelDownload", { modelKey }).catch(err => {
			// Only reachable for immediate rejections (bad key, daemon offline).
			setActive(null);
			setError({ modelKey, message: err instanceof Error ? err.message : String(err) });
		});
	};

	const errorLabel = error ? models?.find(m => m.key === error.modelKey)?.label : undefined;

	return (
		<div className="gui-settings-section">
			<div className="gui-settings-section-title">{t("speech models")}</div>
			{models === null ? (
				<div className="gui-settings-row">
					<div className="gui-settings-row-desc">…</div>
				</div>
			) : (
				models.map(m => {
					const isActive = active?.modelKey === m.key;
					const meta = TIER_META[m.key] ?? { accuracy: 50, speed: 50, size: "" };
					return (
						<div key={m.key} className="gui-stt-card">
							<div className="gui-stt-card-main">
								<div className="gui-stt-card-head">
									<span className="gui-stt-card-label">{m.label}</span>
									{meta.badge && <span className="gui-stt-card-badge">{meta.badge}</span>}
									<span className="gui-stt-card-size">{meta.size}</span>
									{m.cached && <span className="gui-stt-card-ready">✓ {t("model ready offline")}</span>}
								</div>
								<div className="gui-stt-card-bars">
									<span className="gui-stt-card-metric">
										<span className="gui-stt-card-metric-label">{t("accuracy")}</span>
										<span className="gui-stt-card-bar">
											<span className="gui-stt-card-bar-fill" style={{ width: `${meta.accuracy}%` }} />
										</span>
									</span>
									<span className="gui-stt-card-metric">
										<span className="gui-stt-card-metric-label">{t("speed")}</span>
										<span className="gui-stt-card-bar">
											<span
												className="gui-stt-card-bar-fill gui-stt-card-bar-fill--speed"
												style={{ width: `${meta.speed}%` }}
											/>
										</span>
									</span>
								</div>
								{isActive ? (
									<div className="gui-stt-card-progress" aria-live="polite">
										<progress max={100} value={active.percent} aria-label={`${m.label} ${active.percent}%`} />
										<span>
											{active.percent}% · {active.label} {formatBytes(active.loaded)}
											{active.total > 0 ? ` / ${formatBytes(active.total)}` : ""}
										</span>
									</div>
								) : null}
							</div>
							{!isActive && !m.cached ? (
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
				})
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
				<Icon
					name={state === "loading" ? "download" : state === "speaking" ? "stop" : "play"}
					className="h-3.5 w-3.5"
				/>
				{state === "speaking" || state === "loading" ? t("stop") : t("voice output test")}
			</button>
		</div>
	);
}

/** Settings → 语音。 */
export function VoiceSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	// Schema keys render via SchemaTabSection below. Local state covers
	// only the live mic test (device enumeration + dictation round-trip).
	const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
	// Selected microphone (deviceId, null = system default). Seeded from the
	// same machine-local key the dictation entry points read.
	const [deviceId, setDeviceId] = useState<string | null>(() => getVoiceInputDevice());
	const [dictating, setDictating] = useState(false);
	const [dictated, setDictated] = useState<string | null>(null);
	const stopRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		void enumerateMicDevices()
			.then(setDevices)
			.catch(() => setDevices([]));
		return () => stopRef.current?.();
	}, []);

	const toggleDictation = (): void => {
		if (dictating) {
			stopRef.current?.();
			setDictating(false);
			return;
		}
		setDictated(null);
		setDictating(true);
		stopRef.current = startDictation(
			(text: string) => {
				setDictated(text);
				setDictating(false);
			},
			() => setDictating(false),
			rpc,
		);
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("voice")}</h2>

			{/* Schema-driven stt.* / tts.* rows — only the interaction tab's
			 * "Speech" group, NOT the whole tab (the rest of the interaction
			 * groups live on 交互; duplicating them here was the old bug). */}
			<SchemaTabSection rpc={rpc} tabs={["interaction"]} groups={["Speech"]} />
			<ModelDownloadCard rpc={rpc} />

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
					{/* A PICKER, not a list: this row used to print the enumerated
					 *  labels as one joined string, so the microphone could not be
					 *  chosen at all. The value is stored under a machine-local key
					 *  and is picked up by every dictation entry point. */}
					<select
						className="gui-settings-select"
						aria-label={t("voice input device")}
						value={deviceId ?? ""}
						disabled={devices.length === 0}
						onChange={e => {
							const next = e.target.value || null;
							setDeviceId(next);
							setVoiceInputDevice(next);
						}}
					>
						<option value="">{t("system default")}</option>
						{devices.map(d => (
							<option key={d.deviceId} value={d.deviceId}>
								{d.label}
							</option>
						))}
					</select>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("voice input test")}</div>
						<div className="gui-settings-row-desc" aria-live="polite">
							{dictated ?? t("voice input test description")}
						</div>
					</div>
					<button type="button" className="gui-btn" disabled={!rpc} onClick={toggleDictation}>
						<Icon name="mic" className="h-3.5 w-3.5" />
						{dictating ? t("recording…") : t("voice input test")}
					</button>
				</div>
			</div>

			<TtsTestCard rpc={rpc} />
		</>
	);
}
