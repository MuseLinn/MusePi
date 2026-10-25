import { isSttDownloadEvent, type SttModelRow, type SttModelStatusResponse } from "@musepi/pi-wire";
import { Download, Mic, Play, Volume2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import type { SessionClient } from "../../lib/client";
import { type NativeVoiceSupport, nativeVoiceSupport } from "../../lib/native-voice";
import { readSttLangPref, type SttLang, type TtsEngine, useTts, useTtsSnapshot, writeSttLangPref } from "../../lib/tts";
import type { VoiceCapture } from "../../lib/voice";
import { startVoiceCapture, transcribeAudio } from "../../lib/voice";

/**
 * Guest voice panel (header nav 「语音」): the mobile counterpart of the
 * desktop Settings → 语音 page + openchamber's VoiceSettings. Everything
 * here is wired for real — the engine router and prefs live in the shared
 * TtsController (localStorage-backed), so the composer mini-player, the
 * transcript speak buttons and this panel always read the same truth:
 *
 * - engine: auto (daemon Kokoro → system fallback) / daemon / on-device
 * - daemon voice: the curated Kokoro catalog, each row previewable
 * - system voice: the webview's installed SpeechSynthesis voices
 * - rate: playback-side time-stretch for both engines (0.5–2.0)
 * - dictation language: rides through to `stt.transcribe(language)` and the
 *   native recognizer
 * - daemon speech models: `stt.modelStatus` + `stt.modelDownload`, with
 *   progress and BOTH terminal outcomes riding the daemon's global event
 *   stream (`stt.downloadProgress` / `Done` / `Error`) — the download RPC is
 *   fire-and-forget and never rejects on a failed fetch
 * - speech test: TTS + ~3s STT round-trip with readable outcomes
 */

/** Curated Kokoro catalog — mirrors packages/coding-agent/src/tts/models.ts
 *  (the daemon owns the canonical list; keep in lockstep when it changes). */
const KOKORO_VOICES: ReadonlyArray<{ id: string; label: string }> = [
	{ id: "af_heart", label: "Heart (American female)" },
	{ id: "af_bella", label: "Bella (American female)" },
	{ id: "af_nicole", label: "Nicole (American female)" },
	{ id: "af_aoede", label: "Aoede (American female)" },
	{ id: "af_kore", label: "Kore (American female)" },
	{ id: "af_sarah", label: "Sarah (American female)" },
	{ id: "am_michael", label: "Michael (American male)" },
	{ id: "am_fenrir", label: "Fenrir (American male)" },
	{ id: "am_puck", label: "Puck (American male)" },
	{ id: "bf_emma", label: "Emma (British female)" },
	{ id: "bm_george", label: "George (British male)" },
	{ id: "bm_fable", label: "Fable (British male)" },
];

const ENGINES: ReadonlyArray<{ id: TtsEngine; label: string }> = [
	{ id: "auto", label: "settings.voiceEngineAuto" },
	{ id: "daemon", label: "settings.voiceEngineDaemon" },
	{ id: "native", label: "settings.voiceEngineNative" },
];

const STT_LANGS: ReadonlyArray<{ id: SttLang; label: string }> = [
	{ id: "", label: "voice input lang auto" },
	{ id: "zh-CN", label: "中文" },
	{ id: "en-US", label: "English" },
];

/** One status row: feature label + per-device availability chip. */
function SupportRow({ label, supported }: { label: string; supported: boolean }): ReactNode {
	return (
		<div className="sh-vp-row">
			<div className="min-w-0 flex-1">
				<div className="sh-vp-row-label">{label}</div>
			</div>
			<span className={`sh-vp-chip sh-vp-chip--${supported ? "ok" : "no"}`}>
				{supported ? t("settings.voiceNativeStatusOk") : t("settings.voiceNativeStatusNo")}
			</span>
		</div>
	);
}

/** Three-way segmented control (engine / language pickers). */
function SegmentGroup<T extends string>({
	options,
	value,
	onChange,
	ariaLabel,
}: {
	options: ReadonlyArray<{ id: T; label: string }>;
	value: T;
	onChange(id: T): void;
	ariaLabel: string;
}): ReactNode {
	return (
		<div className="sh-vp-seg" role="radiogroup" aria-label={ariaLabel}>
			{options.map(o => (
				<button
					key={o.id}
					type="button"
					role="radio"
					aria-checked={o.id === value}
					className={`sh-vp-seg-btn${o.id === value ? " sh-vp-seg-btn--on" : ""}`}
					onClick={() => onChange(o.id)}
				>
					{t(o.label as Parameters<typeof t>[0])}
				</button>
			))}
		</div>
	);
}

/** Live download row (daemon global events → percent + bytes + label). */
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

/** No progress event for this long while a download is in flight ⇒ the
 *  daemon never joined the stream (old daemon / transport without
 *  events.subscribe); sweep `stt.modelStatus` so we can't hang at 0%. */
const SWEEP_INTERVAL_MS = 5000;

/**
 * Daemon speech models: cached ✓ / download button / live progress.
 *
 * `stt.modelDownload` is fire-and-forget — the RPC returns before the
 * GB-scale fetch starts and NEVER rejects on a failed fetch, so progress and
 * both terminal outcomes arrive only as global events (`stt.downloadProgress`
 * / `stt.downloadDone` / `stt.downloadError`). Polling alone cannot see a
 * failure: the row would sit at "下载中…" forever.
 */
function ModelDownloadCard({ client }: { client: SessionClient }): ReactNode {
	const [models, setModels] = useState<SttModelRow[] | null>(null);
	const [active, setActive] = useState<ActiveDownload | null>(null);
	const [error, setError] = useState<{ modelKey: string; message: string } | null>(null);

	const activeRef = useRef<ActiveDownload | null>(null);
	activeRef.current = active;
	/** Timestamp of the last `stt.download*` event — the sweep's liveness probe. */
	const lastEventAt = useRef(0);
	const settleTimer = useRef<number | null>(null);

	const refresh = useCallback((): void => {
		void client
			.rpc<SttModelStatusResponse>("stt.modelStatus", {})
			.then(res => {
				setModels(res.models ?? []);
				setActive(prev => {
					// Sweep path: the fetch finished but no terminal event ever
					// arrived (daemon without events.subscribe) — the cache
					// flipping is the only proof we get, so retire the row.
					if (prev && res.models?.find(m => m.key === prev.modelKey)?.cached) return null;
					// Window mounted mid-download: seed a 0% row from the
					// daemon's in-flight list instead of offering a second
					// download button.
					return (
						prev ??
						(res.downloads?.[0]
							? { modelKey: res.downloads[0], percent: 0, loaded: 0, total: 0, label: "" }
							: null)
					);
				});
			})
			.catch(() => {
				// collab-direct host (no stt.* RPC) — say so once, don't spin.
				setModels([]);
			});
	}, [client]);

	useEffect(() => {
		refresh();
		const off = client.onDaemonEvent(payload => {
			if (!isSttDownloadEvent(payload)) return;
			lastEventAt.current = Date.now();
			if (payload.type === "stt.downloadProgress") {
				setActive({
					modelKey: payload.modelKey,
					percent: payload.percent,
					loaded: payload.loaded ?? 0,
					total: payload.total ?? 0,
					label: payload.label ?? "",
				});
				return;
			}
			if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
			if (payload.type === "stt.downloadDone") {
				// Let the bar paint 100% briefly, then clear + re-check cache.
				setActive(prev => (prev ? { ...prev, percent: 100 } : prev));
				settleTimer.current = window.setTimeout(() => {
					settleTimer.current = null;
					setActive(null);
					refresh();
				}, 1200);
				return;
			}
			// stt.downloadError: the only failure signal there is.
			setActive(null);
			setError({ modelKey: payload.modelKey, message: payload.message });
			refresh();
		});
		// Safety net, not the primary mechanism: only fires while a download
		// is in flight AND the stream has gone quiet.
		const timer = window.setInterval(() => {
			if (activeRef.current !== null && Date.now() - lastEventAt.current > SWEEP_INTERVAL_MS) {
				lastEventAt.current = Date.now();
				refresh();
			}
		}, SWEEP_INTERVAL_MS);
		return () => {
			off();
			window.clearInterval(timer);
			if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
		};
	}, [client, refresh]);

	const download = (modelKey: string): void => {
		setError(null);
		setActive({ modelKey, percent: 0, loaded: 0, total: 0, label: "" });
		lastEventAt.current = Date.now();
		void client.rpc("stt.modelDownload", { modelKey }).catch((err: unknown) => {
			// Only reachable for immediate rejections (bad key, daemon offline)
			// — real fetch failures arrive as stt.downloadError.
			setActive(null);
			setError({ modelKey, message: err instanceof Error ? err.message : String(err) });
		});
	};

	const failed = models !== null && models.length === 0;
	if (failed && !error) {
		return (
			<section className="sh-vp-section">
				<p className="sh-vp-section-title">{t("settings.speechModels")}</p>
				<p className="sh-vp-section-desc">{t("composer.voiceNeedsDaemonBackend")}</p>
			</section>
		);
	}
	return (
		<section className="sh-vp-section">
			<p className="sh-vp-section-title">{t("settings.speechModels")}</p>
			{models === null && <p className="sh-vp-section-desc">…</p>}
			{models?.map(m => {
				const running = active?.modelKey === m.key;
				return (
					<div key={m.key} className="sh-vp-row">
						<div className="min-w-0 flex-1">
							<div className="sh-vp-row-label">{m.label}</div>
							{m.cached && !running && <div className="sh-vp-row-desc">{t("settings.modelReadyOffline")}</div>}
							{running && (
								<>
									<div className="sh-vp-row-desc">
										{active && active.total > 0
											? `${formatBytes(active.loaded)} / ${formatBytes(active.total)}`
											: ""}
										{active?.label ? ` · ${active.label}` : ""}
									</div>
									<div className="sh-vp-prog">
										<div
											className="sh-vp-prog-bar"
											style={{ width: `${Math.min(100, Math.max(0, active?.percent ?? 0))}%` }}
										/>
									</div>
								</>
							)}
						</div>
						{running ? (
							// Nothing reported yet (no progress event since the
							// RPC returned) ⇒ no percentage to show.
							<span className="sh-vp-chip">
								{active && (active.percent > 0 || active.total > 0)
									? t("settings.voiceModelPercent", { percent: Math.round(active.percent) })
									: t("settings.voiceModelDownloading")}
							</span>
						) : m.cached ? (
							<span className="sh-vp-chip sh-vp-chip--ok">✓</span>
						) : (
							<button type="button" className="sh-btn sh-vp-dl" onClick={() => download(m.key)}>
								<Download size={12} aria-hidden />
								<span>{t("settings.download")}</span>
							</button>
						)}
					</div>
				);
			})}
			{error && (
				<p className="sh-vp-note sh-vp-note--err">
					{models?.find(m => m.key === error.modelKey)?.label ?? t("settings.voiceModelDownloadFailed")}:{" "}
					{error.message}
				</p>
			)}
		</section>
	);
}

type SttTestState = "idle" | "recording" | "transcribing" | "ok" | "error";

export function VoicePanel({ client }: { client: SessionClient }): ReactNode {
	const support: NativeVoiceSupport = nativeVoiceSupport();
	const tts = useTts(client);
	const ttsSnap = useTtsSnapshot(tts);

	// Dictation language mirrors the localStorage pref (composer reads the
	// same key at capture time).
	const [sttLang, setSttLang] = useState<SttLang>(() => readSttLangPref());
	const pickSttLang = (lang: SttLang): void => {
		writeSttLangPref(lang);
		setSttLang(lang);
	};

	// System voices load lazily (Chrome); re-read when the engine enumerates.
	const [sysVoices, setSysVoices] = useState<SpeechSynthesisVoice[]>([]);
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.speechSynthesis === "undefined") return;
		const read = (): void => {
			const voices = window.speechSynthesis.getVoices();
			if (voices.length === 0) return;
			// Keep the list phone-friendly: prefer the UI locale's voices.
			const base = (typeof navigator !== "undefined" ? navigator.language : "en").split("-")[0];
			const scoped = voices.filter(v => v.lang.startsWith(base));
			setSysVoices((scoped.length > 0 ? scoped : voices).slice(0, 16));
		};
		read();
		window.speechSynthesis.addEventListener?.("voiceschanged", read);
		return () => window.speechSynthesis.removeEventListener?.("voiceschanged", read);
	}, []);

	// TTS test lifecycle rides the shared controller: mark the test as ours,
	// then watch for the controller settling back to idle.
	const [ttsResult, setTtsResult] = useState<"idle" | "ok" | "error">("idle");
	const ttsPendingRef = useRef(false);
	useEffect(() => {
		if (!ttsPendingRef.current) return;
		if (ttsSnap.phase === "idle") {
			ttsPendingRef.current = false;
			setTtsResult(ttsSnap.error !== null ? "error" : "ok");
		}
	}, [ttsSnap]);

	const runTtsTest = useCallback((): void => {
		if (ttsSnap.phase !== "idle") {
			// Tap again = stop: cancel the pending watch so the settle isn't
			// misread as a successful test.
			ttsPendingRef.current = false;
			tts.stop();
			setTtsResult("idle");
			return;
		}
		setTtsResult("idle");
		ttsPendingRef.current = true;
		tts.speak(t("settings.speechTestPhrase"));
	}, [tts, ttsSnap.phase]);

	// STT test: record ~3s (manual re-tap stops early), then transcribe.
	const [sttState, setSttState] = useState<SttTestState>("idle");
	const [sttResult, setSttResult] = useState("");
	const [sttError, setSttError] = useState("");
	const captureRef = useRef<VoiceCapture | null>(null);
	const timerRef = useRef<number | null>(null);

	const stopAndTranscribe = useCallback((): void => {
		const capture = captureRef.current;
		if (!capture) return;
		captureRef.current = null;
		if (timerRef.current !== null) {
			window.clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		setSttState("transcribing");
		capture
			.stop()
			.then(audio => transcribeAudio(client, audio, sttLang || undefined))
			.then(text => {
				setSttResult(text.trim());
				setSttState("ok");
			})
			.catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				// Transport miss → say "needs daemon" instead of the raw RPC error.
				const transportMiss = msg === "rpc failed" || msg === "stt timeout";
				setSttError(transportMiss ? "" : msg);
				setSttState("error");
			});
	}, [client, sttLang]);

	const runSttTest = useCallback((): void => {
		if (sttState === "recording") {
			stopAndTranscribe();
			return;
		}
		setSttState("recording");
		setSttResult("");
		setSttError("");
		startVoiceCapture()
			.then(capture => {
				captureRef.current = capture;
				timerRef.current = window.setTimeout(stopAndTranscribe, 3000);
			})
			.catch((err: unknown) => {
				setSttError(err instanceof Error ? err.message : String(err));
				setSttState("error");
			});
	}, [sttState, stopAndTranscribe]);

	// Unmount safety: never leave the mic open or the timer running.
	useEffect(
		() => () => {
			captureRef.current?.abort();
			captureRef.current = null;
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		},
		[],
	);

	return (
		<div className="sh-vp">
			<div className="sh-panel-head">
				<h2 className="sh-panel-title">{t("settings.voice")}</h2>
				<span className="sh-panel-muted">{t("settings.voiceInputOutput")}</span>
			</div>

			<section className="sh-vp-section">
				<p className="sh-vp-section-title">{t("settings.voiceOutputEngine")}</p>
				<SegmentGroup
					options={ENGINES}
					value={ttsSnap.engine}
					onChange={id => tts.setEngine(id)}
					ariaLabel={t("settings.voiceOutputEngine")}
				/>
				{ttsSnap.engine === "auto" && <p className="sh-vp-section-desc">{t("settings.voiceEngineAutoDesc")}</p>}
			</section>

			<section className="sh-vp-section">
				<p className="sh-vp-section-title">{t("settings.voiceOutputVoice")}</p>
				<p className="sh-vp-section-desc">{t("settings.voiceOutputDescription")}</p>
				<div className="sh-vp-chips" role="radiogroup" aria-label={t("settings.voiceOutputVoice")}>
					<span
						className={`sh-vp-voice${ttsSnap.voice === "" ? " sh-vp-voice--on" : ""}`}
						role="radio"
						aria-checked={ttsSnap.voice === ""}
						onClick={() => tts.setVoice("")}
						onKeyDown={e => e.key === "Enter" && tts.setVoice("")}
					>
						{t("settings.voiceDefault")}
					</span>
					{KOKORO_VOICES.map(v => (
						<span
							key={v.id}
							className={`sh-vp-voice${ttsSnap.voice === v.id ? " sh-vp-voice--on" : ""}`}
							role="radio"
							aria-checked={ttsSnap.voice === v.id}
							onClick={() => tts.setVoice(v.id)}
							onKeyDown={e => e.key === "Enter" && tts.setVoice(v.id)}
						>
							<span className="sh-vp-voice-label">{v.label}</span>
							<button
								type="button"
								className="sh-vp-voice-play"
								aria-label={`${t("settings.voicePreview")}: ${v.label}`}
								title={t("settings.voicePreview")}
								onClick={e => {
									e.stopPropagation();
									tts.speak(t("settings.voiceOutputSample"), undefined, { voice: v.id });
								}}
							>
								<Play size={10} aria-hidden />
							</button>
						</span>
					))}
				</div>
			</section>

			{ttsSnap.engine === "native" && sysVoices.length > 0 && (
				<section className="sh-vp-section">
					<p className="sh-vp-section-title">{t("settings.voiceNativeVoices")}</p>
					<div className="sh-vp-chips" role="radiogroup" aria-label={t("settings.voiceNativeVoices")}>
						<span
							className={`sh-vp-voice${ttsSnap.nativeVoice === "" ? " sh-vp-voice--on" : ""}`}
							role="radio"
							aria-checked={ttsSnap.nativeVoice === ""}
							onClick={() => tts.setNativeVoice("")}
							onKeyDown={e => e.key === "Enter" && tts.setNativeVoice("")}
						>
							{t("settings.voiceSystemDefault")}
						</span>
						{sysVoices.map(v => (
							<span
								key={v.name}
								className={`sh-vp-voice${ttsSnap.nativeVoice === v.name ? " sh-vp-voice--on" : ""}`}
								role="radio"
								aria-checked={ttsSnap.nativeVoice === v.name}
								onClick={() => tts.setNativeVoice(v.name)}
								onKeyDown={e => e.key === "Enter" && tts.setNativeVoice(v.name)}
							>
								<span className="sh-vp-voice-label">{v.name}</span>
							</span>
						))}
					</div>
				</section>
			)}

			<section className="sh-vp-section">
				<div className="sh-vp-row">
					<div className="sh-vp-row-label">{t("settings.voiceOutputRate")}</div>
					<span className="sh-vp-rate-value">×{ttsSnap.rate.toFixed(1)}</span>
				</div>
				<input
					className="sh-vp-range"
					type="range"
					min={0.5}
					max={2}
					step={0.1}
					value={ttsSnap.rate}
					aria-label={t("settings.voiceOutputRate")}
					onChange={e => tts.setRate(Number.parseFloat(e.target.value))}
				/>
			</section>

			<section className="sh-vp-section">
				<p className="sh-vp-section-title">{t("settings.voiceInputLanguage")}</p>
				<SegmentGroup
					options={STT_LANGS}
					value={sttLang}
					onChange={pickSttLang}
					ariaLabel={t("settings.voiceInputLanguage")}
				/>
				<p className="sh-vp-section-desc">{t("settings.voiceInputDescription")}</p>
			</section>

			<ModelDownloadCard client={client} />

			<section className="sh-vp-section">
				<p className="sh-vp-section-title">{t("settings.speechTest")}</p>
				<p className="sh-vp-section-desc">
					{t("settings.speechTestHint")} — {t("settings.speechTestLocalNote")}
				</p>
				<div className="sh-vp-actions">
					<button type="button" className="sh-btn" onClick={runTtsTest} title={t("settings.speechTestTtsTitle")}>
						<Volume2 size={13} aria-hidden />
						<span>{ttsSnap.phase !== "idle" ? t("settings.readAloudStop") : t("settings.speechTestTts")}</span>
					</button>
					<button type="button" className="sh-btn" onClick={runSttTest} title={t("settings.speechTestSttTitle")}>
						<Mic size={13} aria-hidden />
						<span>
							{sttState === "recording" ? t("settings.voiceRecordingStop") : t("settings.speechTestStt")}
						</span>
					</button>
				</div>
				{ttsSnap.phase === "loading" && <p className="sh-vp-note">{t("settings.voiceOutputTesting")}</p>}
				{ttsResult === "ok" && <p className="sh-vp-note sh-vp-note--ok">{t("settings.speechTestTtsOk")}</p>}
				{ttsResult === "error" && (
					<p className="sh-vp-note sh-vp-note--err">
						{t("settings.voiceOutputUnavailable")}
						{ttsSnap.error !== null ? ` — ${ttsSnap.error}` : ""}
					</p>
				)}
				{sttState === "recording" && <p className="sh-vp-note">{t("settings.recording")}</p>}
				{sttState === "transcribing" && <p className="sh-vp-note">{t("settings.voiceTranscribing")}</p>}
				{sttState === "ok" && (
					<p className="sh-vp-note sh-vp-note--ok">
						{t("settings.speechTestSttOk")}: “{sttResult || "—"}”
					</p>
				)}
				{sttState === "error" && (
					<p className="sh-vp-note sh-vp-note--err">{sttError || t("composer.voiceNeedsDaemonBackend")}</p>
				)}
			</section>

			<section className="sh-vp-section">
				<div className="sh-vp-row">
					<div className="min-w-0 flex-1">
						<div className="sh-vp-row-label">{t("settings.voiceOutputAutoRead")}</div>
						<div className="sh-vp-row-desc">{t("settings.voiceOutputDescription")}</div>
					</div>
					<button
						type="button"
						className={`sh-btn${ttsSnap.autoRead ? " sh-vp-toggle--on" : ""}`}
						onClick={() => tts.toggleAutoRead()}
						aria-pressed={ttsSnap.autoRead}
						title={t("settings.voiceOutputAutoRead")}
					>
						{ttsSnap.autoRead ? t("settings.on") : t("settings.off")}
					</button>
				</div>
			</section>

			<section className="sh-vp-section">
				<p className="sh-vp-section-title">{t("settings.voiceInput")}</p>
				<SupportRow label={t("settings.voiceNativeStt")} supported={support.recognition} />
				<SupportRow label={t("settings.voiceNativeTts")} supported={support.synthesis} />
			</section>
		</div>
	);
}
