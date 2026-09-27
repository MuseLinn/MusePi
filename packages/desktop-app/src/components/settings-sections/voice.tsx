/*
 * Settings → 语音: dedicated voice I/O section. The stt.* / tts.* schema keys
 * render through <SchemaTabSection tabs={["interaction"]}> (the daemon
 * schema is the single source of truth — the same rows used to be
 * hand-duplicated here with hardcoded defaults that never loaded real
 * values, and drifted from the 交互 tab's schema-driven copies), EXCEPT
 * `stt.modelName` and `tts.localModel`, which this file renders as two
 * radio-row picker cards (a bare enum dropdown buried in the list made the
 * tiers unreadable; the TTS one matters doubly because zh users otherwise
 * cannot pick the Mandarin tier at all).
 * This file keeps only what the schema cannot express: the two speech-model
 * pickers, live mic enumeration (liquid-glass floating menu), and the
 * dictation / TTS tests — both hosted by the SHARED simulated conversation
 * view (MockConversationPreview, same component 外观 → 效果预览 renders):
 * dictation starts from the preview composer's real mic button and the
 * transcript lands as a user message in the preview (multi-turn), while the
 * fixed assistant sample carries the read-aloud action, so testing voice I/O
 * previews exactly what chat will look and sound like.
 */
import { t, tLoose } from "@musepi/client-core";
import {
	isSttDownloadEvent,
	isTtsDownloadEvent,
	type SttDownloadEvent,
	type SttModelRow,
	type SttModelStatusResponse,
	type TtsDownloadEvent,
	type TtsModelStatusResponse,
} from "@musepi/pi-wire";
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
import { MockComposer, MockConversationPreview, MockUserRow } from "../MockConversationPreview";
import { SchemaTabSection } from "./schema";

/* ── Speech-model download state (stt/tts .modelStatus / .modelDownload) ──
 *  The RPC contracts (`SttModelRow`/`TtsModelRow`, the status responses, the
 *  `*.download*` event unions + their guards) live in @musepi/pi-wire so the
 *  desktop and guest shells can never drift apart. Both channels share one
 *  shape: fire-and-forget download RPC, progress AND both terminal outcomes
 *  riding the global event stream, so state survives page remounts and stays
 *  in sync across every open window. Only the renderer's own row state
 *  stays local. */

/** Either wire download-event union — the picker normalizes both STT
 *  (percent + bytes + file label) and TTS (percent + stage label) ticks
 *  through this one shape. */
type AnyModelDownloadEvent = SttDownloadEvent | TtsDownloadEvent;

/** Active-download row, normalized from whichever wire event arrived. */
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

/** Per-tier presentation metadata (openchamber model-card parity): size
 *  mirrors the daemon registry's download footprint; badge/desc are
 *  humanized one-liners (i18n keys registered by i18n/voice.ts — the
 *  English sentence IS the key, matching the core map's contract). Local UI
 *  data only — the wire row stays { key, label, cached }. Kept in sync with
 *  composer/voice-setup.tsx SIZE_HINTS (STT half). */
interface TierMeta {
	size: string;
	badge?: string;
	desc: string;
}

/** STT tiers — sizes mirror `stt/models.ts` `sizeHint`. */
const TIER_META: Record<string, TierMeta> = {
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

/** TTS tiers — sizes mirror `tts/models.ts`: MeloTTS-zh ships model.onnx
 *  ~163 MB (+tokens/lexicon, negligible); Kokoro-82M loads at the default
 *  q8 precision, i.e. the 82M-param weights ≈ 85 MB on disk. */
const TTS_TIER_META: Record<string, TierMeta> = {
	kokoro: {
		size: "~85 MB",
		badge: "English-first",
		desc: "SoTA English & code narration — no Chinese",
	},
	"melotts-zh": {
		size: "~165 MB",
		badge: "Chinese",
		desc: "Mandarin narration with mixed zh/en",
	},
};

/** Speech-model picker: ONE card where each tier is a radio row — selecting
 *  a tier writes the backing setting. The STT and TTS pickers are the same
 *  card over two wire channels, so the component takes the channel endpoints
 *  as props instead of forking. They differ in one behavior: the STT card
 *  auto-fetches on pick (a selected tier you cannot use is a broken default),
 *  while the TTS card leaves the download to the per-row button — synthesis
 *  falls back across tiers by text script, so an uncached pick still reads
 *  aloud through the other model. */
interface SpeechModelPickerProps {
	rpc: RpcClient | null;
	/** i18n key for the section title and the radiogroup's aria-label. */
	titleKey: string;
	/** DOM radio-group name (keeps the two cards' radios independent). */
	radioName: string;
	statusMethod: "stt.modelStatus" | "tts.modelStatus";
	downloadMethod: "stt.modelDownload" | "tts.modelDownload";
	/** Setting a radio write commits to (`settings.set <key>`). */
	settingsKey: "stt.modelName" | "tts.localModel";
	meta: Record<string, TierMeta>;
	isDownloadEvent: (value: unknown) => value is AnyModelDownloadEvent;
	/** STT passes true: selecting an uncached tier starts its download AND a
	 *  seeded selection pointing at missing weights auto-fetches (fresh
	 *  machine). TTS omits it (default false): local synthesis routes zh text
	 *  to the Mandarin tier automatically, so an uncached pick still reads
	 *  aloud — the per-row download button is the only fetch trigger. */
	autoFetchOnSelect?: boolean;
}

/** The STT/TTS pickers are one component over two wire channels — exported
 *  for the voice-settings contract tests (the TTS half is the only part
 *  without a pre-existing card to lean on). */
export function SpeechModelPicker({
	rpc,
	titleKey,
	radioName,
	statusMethod,
	downloadMethod,
	settingsKey,
	meta,
	isDownloadEvent,
	autoFetchOnSelect,
}: SpeechModelPickerProps): ReactNode {
	const [models, setModels] = useState<SttModelRow[] | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [active, setActive] = useState<ActiveDownload | null>(null);
	const [error, setError] = useState<{ modelKey: string; message: string } | null>(null);
	// Single settlement timer: cleared before rescheduling and on unmount,
	// so stacked terminal events can never fire stale refreshes.
	const settleTimer = useRef<number | null>(null);

	const refresh = useCallback(() => {
		void rpc
			?.request<SttModelStatusResponse | TtsModelStatusResponse>(statusMethod, {})
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
				// Seed the radio from the daemon-resolved default when the
				// setting itself gave us nothing (unset → built-in default).
				setSelected(prev => (prev === null && typeof res.defaultKey === "string" ? res.defaultKey : prev));
			})
			.catch(() => setModels([]));
	}, [rpc, statusMethod]);

	useEffect(() => {
		refresh();
		// Seed the radio selection from the live setting (default tier when unset).
		void rpc
			?.request<Record<string, unknown>>("settings.get", { keys: [settingsKey] })
			.then(v => {
				if (typeof v?.[settingsKey] === "string") setSelected(v[settingsKey] as string);
			})
			.catch(() => {});
		if (!rpc) return;
		const off = rpc.addEventListener(event => {
			const p = event.payload;
			if (!isDownloadEvent(p)) return;
			// Discriminate on the exact literal (endsWith would not narrow).
			if (p.type === "stt.downloadProgress" || p.type === "tts.downloadProgress") {
				setActive({
					modelKey: p.modelKey,
					percent: p.percent,
					loaded: p.loaded ?? 0,
					total: p.total ?? 0,
					label: p.label ?? "",
				});
				return;
			}
			if (p.type === "stt.downloadDone" || p.type === "tts.downloadDone") {
				// Let the bar paint 100% briefly, then clear + re-check cache.
				if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
				settleTimer.current = window.setTimeout(() => {
					settleTimer.current = null;
					setActive(null);
					refresh();
				}, 1200);
				return;
			}
			// *.downloadError: fire-and-forget request means the RPC itself
			// never rejects — the failure only arrives here. Keep the tier key
			// so the row can be named; other models' UI state is untouched.
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
	}, [rpc, refresh, settingsKey, isDownloadEvent]);

	const download = useCallback(
		(modelKey: string): void => {
			setError(null);
			setActive({ modelKey, percent: 0, loaded: 0, total: 0, label: "" });
			void rpc?.request(downloadMethod, { modelKey }).catch(err => {
				// Only reachable for immediate rejections (bad key, daemon offline).
				setActive(null);
				setError({ modelKey, message: err instanceof Error ? err.message : String(err) });
			});
		},
		[rpc, downloadMethod],
	);

	const select = (modelKey: string): void => {
		if (!rpc || modelKey === selected) return;
		setSelected(modelKey);
		setError(null);
		void rpc.request("settings.set", { key: settingsKey, value: modelKey }).catch(err => {
			setError({ modelKey, message: err instanceof Error ? err.message : String(err) });
		});
	};

	// Auto-fetch (STT only): selecting an uncached tier starts its download —
	// both for explicit clicks (handled in the row's onChange via `download`)
	// and for a seed selection pointing at weights that aren't on disk yet
	// (fresh machine). TTS never auto-fetches — see the prop's contract.
	const selectedRow = models?.find(m => m.key === selected) ?? null;
	useEffect(() => {
		if (!autoFetchOnSelect) return;
		if (!selectedRow || selectedRow.cached || active !== null) return;
		download(selectedRow.key);
	}, [selectedRow, active, download, autoFetchOnSelect]);

	const errorLabel = error ? models?.find(m => m.key === error.modelKey)?.label : undefined;

	return (
		<div className="gui-settings-section">
			<div className="gui-settings-section-title">{tLoose(titleKey)}</div>
			{models === null ? (
				<div className="gui-settings-row">
					<div className="gui-settings-row-desc">…</div>
				</div>
			) : (
				<div className="gui-stt-picker" role="radiogroup" aria-label={tLoose(titleKey)}>
					{models.map(m => {
						const isSelected = selected === m.key;
						const isActive = active?.modelKey === m.key;
						const tierMeta = meta[m.key] ?? { size: "", desc: "" };
						return (
							<div key={m.key} className={`gui-stt-row${isSelected ? " gui-stt-row--selected" : ""}`}>
								<label className="gui-stt-row-radio">
									<input
										type="radio"
										name={radioName}
										checked={isSelected}
										disabled={!rpc}
										onChange={() => {
											select(m.key);
											// Auto-fetch on pick (STT only): a selected
											// tier you cannot use (weights missing, no
											// download running) is a broken default —
											// mirror the effect above for the click path.
											if (autoFetchOnSelect && !m.cached && active === null) download(m.key);
										}}
									/>
									<span className="gui-stt-row-main">
										<span className="gui-stt-row-head">
											<span className="gui-stt-row-label">{m.label}</span>
											{tierMeta.badge && <span className="gui-stt-badge">{tLoose(tierMeta.badge)}</span>}
											<span className="gui-stt-row-size">{tierMeta.size}</span>
										</span>
										<span className="gui-stt-row-desc">{tLoose(tierMeta.desc)}</span>
										{isActive ? (
											<span className="gui-stt-row-progress" aria-live="polite">
												<progress
													max={100}
													value={active.percent}
													aria-label={`${m.label} ${active.percent}%`}
												/>
												<span>
													{active.percent}% · {active.label}
													{active.loaded > 0
														? ` · ${formatBytes(active.loaded)}${active.total > 0 ? ` / ${formatBytes(active.total)}` : ""}`
														: ""}
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
			{autoFetchOnSelect && selectedRow && !selectedRow.cached && (
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

/** STT picker card (语音识别模型): the four tiers write `stt.modelName` and
 *  auto-fetch on pick — a selected tier you cannot use is a broken default. */
function SttModelPickerCard({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<SpeechModelPicker
			rpc={rpc}
			titleKey="speech recognition model"
			radioName="stt-model"
			statusMethod="stt.modelStatus"
			downloadMethod="stt.modelDownload"
			settingsKey="stt.modelName"
			meta={TIER_META}
			isDownloadEvent={isSttDownloadEvent}
			autoFetchOnSelect
		/>
	);
}

/** TTS picker card (朗读模型): two tiers write `tts.localModel`. Selecting
 *  NEVER auto-downloads — local synthesis routes zh text to the Mandarin tier
 *  automatically, so an uncached pick still reads aloud; the per-row download
 *  button is the only fetch trigger. Exported: the contract test mounts this
 *  card directly against a fake RPC. */
export function TtsModelPickerCard({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<SpeechModelPicker
			rpc={rpc}
			titleKey="speech synthesis model"
			radioName="tts-model"
			statusMethod="tts.modelStatus"
			downloadMethod="tts.modelDownload"
			settingsKey="tts.localModel"
			meta={TTS_TIER_META}
			isDownloadEvent={isTtsDownloadEvent}
			autoFetchOnSelect={false}
		/>
	);
}

/** Built-in assistant reply the 语音测试 preview speaks — deliberately
 * zh/en mixed with a fenced code block so the default `sanitize` read mode
 * (tts.inputMode) has something to strip (the spoken stream never reads
 * code aloud) and a zh user can hear the MeloTTS-zh tier. Demo content,
 * not locale chrome — it must stay mixed-script by design. */
const TTS_SAMPLE_MARKDOWN = [
	"已经帮你把这段配置改好了，简单说两个要点：",
	"",
	"```ts",
	'const model = await downloadTtsModel("melotts-zh");',
	"```",
	"",
	"上面的代码块在 sanitize 模式下会被整段跳过，不会被朗读；inline terms like *neural TTS* and `sampleRate` stay in the stream. 语速可以在「朗读速率」里调整。",
].join("\n");

/** 测试语音输出 — the read-aloud entry (the transcript's .tr-action slot)
 *  mounted on the preview's assistant row. Synthesis uses the CURRENT schema
 *  values (read live from settings.get, so the test always matches what
 *  chat playback will use). State machine carried over from the former
 *  TtsTestCard, unchanged. Exported for the voice-settings contract tests. */
export function SpeakAction({ rpc, markdown }: { rpc: RpcClient | null; markdown: string }): ReactNode {
	const [state, setState] = useState<"idle" | "loading" | "speaking" | "error">("idle");
	const [err, setErr] = useState("");
	const stopRef = useRef<(() => void) | null>(null);
	useEffect(() => () => stopRef.current?.(), []);
	const speaking = state === "speaking" || state === "loading";
	const toggle = (): void => {
		if (speaking) {
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
							markdown,
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
								else if (a.phase === "done") setState("idle");
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
		<button
			type="button"
			className={`tr-action${speaking ? " tr-action--speaking" : ""}`}
			title={state === "error" ? err : speaking ? t("read aloud stop") : t("read aloud")}
			aria-label={speaking ? t("read aloud stop") : t("read aloud")}
			disabled={!rpc}
			onClick={toggle}
		>
			<Icon name="volume-up" className="h-3.5 w-3.5" />
		</button>
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
	// Schema keys render via SchemaTabSection below — minus stt.modelName and
	// tts.localModel, which the two picker cards render as radio rows (bare
	// enum dropdowns made the tiers unreadable). Local state covers only the
	// live mic test (device enumeration + dictation round-trip).
	const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
	// Selected microphone (deviceId, null = system default). Seeded from the
	// same machine-local key the dictation entry points read.
	const [deviceId, setDeviceId] = useState<string | null>(() => getVoiceInputDevice());
	// Dictation test state machine: idle → recording (live level meter) →
	// transcribing → result / error. Phase drives the status copy, the
	// dictating-capsule mic button and the meter.
	const [dictating, setDictating] = useState(false);
	const [dictationPhase, setDictationPhase] = useState<"idle" | "recording" | "transcribing">("idle");
	const [recordSeconds, setRecordSeconds] = useState(0);
	const [recordLevel, setRecordLevel] = useState(0);
	// Multi-turn: every finished dictation appends a user message to the
	// preview (re-record = press the mic again — no separate reset affordance).
	const [dictatedMessages, setDictatedMessages] = useState<string[]>([]);
	const [dictationError, setDictationError] = useState<string | null>(null);
	const stopRef = useRef<(() => void) | null>(null);
	// Session chrome mirrors the chat surface (same localStorage keys
	// ChatView reads), so the preview shows exactly what a conversation
	// looks like under the current 外观 toggles.
	const showAvatars = (() => {
		try {
			return localStorage.getItem("musepi-gui-avatars") !== "0";
		} catch {
			return true;
		}
	})();
	const statusBarInfo = (() => {
		try {
			return localStorage.getItem("musepi-gui-statusbar-info") === "1";
		} catch {
			return false;
		}
	})();

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
		setDictationError(null);
		setRecordSeconds(0);
		setRecordLevel(0);
		setDictating(true);
		setDictationPhase("recording");
		const stop = startDictation(
			(text: string) => {
				setDictatedMessages(prev => [...prev, text]);
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
			 * stt.modelName and tts.localModel are excluded: the picker cards
			 * own them (a bare enum dropdown buried in the list made the four
			 * STT tiers unreadable, and left zh users no way at all to pick
			 * the Mandarin TTS tier). */}
			<SchemaTabSection
				rpc={rpc}
				tabs={["interaction"]}
				groups={["Speech"]}
				excludeKeys={["stt.modelName", "tts.localModel"]}
			/>
			<SttModelPickerCard rpc={rpc} />
			<TtsModelPickerCard rpc={rpc} />

			{/* Live voice I/O test: not expressible in schema. Hosted by the
			 * SHARED simulated conversation view — dictation starts from the
			 * preview composer's real mic button (re-record = press the mic
			 * again) and every transcript lands as a user message in the
			 * preview (multi-turn accumulation), while the fixed assistant
			 * sample carries the read-aloud action — exactly how chat will
			 * look and sound. */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{tLoose("voice test preview")}</div>
				<div className="gui-settings-section-desc">{tLoose("voice test preview description")}</div>
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
				<MockConversationPreview
					showAvatars={showAvatars}
					statusBarInfo={statusBarInfo}
					assistantMarkdown={TTS_SAMPLE_MARKDOWN}
					assistantActions={<SpeakAction rpc={rpc} markdown={TTS_SAMPLE_MARKDOWN} />}
					extraMessages={dictatedMessages.map((text, i) => (
						<MockUserRow key={`${i}:${text}`} markdown={text} showAvatar={showAvatars} />
					))}
					composer={
						<MockComposer
							input={
								<span aria-live="polite">
									{dictationError ??
										(dictationPhase === "recording"
											? `${tLoose("Listening… speak now")} · ${recordSeconds}s`
											: dictationPhase === "transcribing"
												? t("voice transcribing")
												: t("voice input test description"))}
								</span>
							}
							mic={
								<button
									type="button"
									className={`gui-composer-ico gui-effect-preview-mic${
										dictationPhase === "recording" ? " gui-composer-ico--dictating" : ""
									}`}
									disabled={!rpc}
									onClick={toggleDictation}
									aria-label={
										dictationPhase === "recording" || dictationPhase === "transcribing"
											? t("stop")
											: t("voice input test")
									}
									title={
										dictationPhase === "recording"
											? t("stop")
											: dictationPhase === "transcribing"
												? t("voice transcribing")
												: t("voice input test")
									}
								>
									<Icon
										name={
											dictationPhase === "recording" || dictationPhase === "transcribing" ? "stop" : "mic"
										}
										className="h-3.5 w-3.5"
									/>
									{dictationPhase === "recording" && (
										<>
											<span className="gui-voice-seconds">{recordSeconds}s</span>
											{/* Live level meter rides the dictating capsule's
											 * inner bottom edge (same contract as the real
											 * composer mic — .gui-voice-level is absolutely
											 * positioned inside the button). */}
											<span
												className="gui-voice-level"
												style={{ width: `${Math.min(100, Math.round(recordLevel * 100))}%` }}
											/>
										</>
									)}
								</button>
							}
						/>
					}
				/>
			</div>
		</>
	);
}
