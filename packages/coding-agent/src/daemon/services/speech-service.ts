/**
 * SpeechService — local speech-to-text and text-to-speech over the daemon.
 *
 * Seam:
 * - Input: `stt.*` / `tts.*` routes, the session whose tiny/smol role rewrites
 *   spoken prose, and the global event channel every window listens on.
 * - Output: model rows with their on-disk state, transcription/synthesis
 *   results, and download progress plus both terminal outcomes as events.
 * - Lifecycle: in-flight downloads are process state. They live here so a
 *   second window (or a double-click race) reuses the running fetch instead of
 *   starting a parallel one into the same cache directory.
 */

import type {
	SttModelRow,
	SttModelStatusResponse,
	TtsModelRow,
	TtsModelStatusResponse,
	TtsRewriteResponse,
} from "@musepi/pi-wire";
import type { DaemonSessionHost } from "../session-host";
import type { DaemonService } from "./types";

export class SpeechService implements DaemonService {
	readonly key = "speech";
	readonly routes = {
		"stt.modelStatus": "sttModelStatus",
		"stt.modelDelete": "sttModelDelete",
		"stt.modelDownload": "sttModelDownload",
		"stt.transcribe": "sttTranscribe",
		"tts.rewrite": "ttsRewrite",
		"tts.synthesize": "ttsSynthesize",
		"tts.modelStatus": "ttsModelStatus",
		"tts.modelDelete": "ttsModelDelete",
		"tts.modelDownload": "ttsModelDownload",
	} as const;

	/** Speech-model downloads currently running (keyed by model tier key).
	 *  Guards against two windows (or a double-click race) starting parallel
	 *  fetches into the same cache directory. */
	readonly #sttDownloads = new Map<string, Promise<void>>();
	/** Local TTS model downloads, same guard contract as #sttDownloads. */
	readonly #ttsDownloads = new Map<string, Promise<void>>();

	constructor(
		private readonly host: Pick<DaemonSessionHost, "get"> & {
			broadcast(payload: Record<string, unknown>): void;
		},
	) {}

	async sttModelStatus(params: unknown): Promise<unknown> {
		// GUI voice page: which speech models are already on disk, so
		// the panel can show "ready" vs "needs download" per option.
		// `downloads` lists tiers mid-fetch so a freshly-mounted window
		// renders its progress row immediately, not after the next tick.
		const { isSttModelCached } = await import("../../stt/downloader");
		const { enabledSttModels, resolveEnabledSttModel } = await import("../../voice/engine-denylist");
		// `satisfies` (not `:`) — the wire contract in @musepi/pi-wire
		// is the single source of truth for both shells; if the shape
		// here drifts, typecheck fails instead of the UI breaking.
		// Engine components disabled from the plugin page are filtered
		// out of the catalog entirely (same list drives the settings
		// picker and this status route — one source, no drift).
		const models: SttModelRow[] = await Promise.all(
			enabledSttModels().map(async m => ({
				key: m.key,
				label: m.label,
				cached: await isSttModelCached(m.key),
			})),
		);
		// First-use guide: the tier a bare `stt.transcribe` loads
		// (settings `stt.modelName`, same resolution as the route) —
		// the client decides "guided install" vs "dictate now" from
		// this pair without duplicating settings access. Settings may
		// be uninitialized in bare harness contexts; fall back to the
		// built-in default tier (Whisper small) instead of throwing.
		// A selected tier whose engine component got disabled falls
		// back to the first enabled tier, same as the route.
		let defaultKey: string;
		try {
			const { settings: sttSettings } = await import("../../config/settings");
			defaultKey = resolveEnabledSttModel(sttSettings.get("stt.modelName") as string | undefined).key;
		} catch {
			defaultKey = resolveEnabledSttModel(undefined).key;
		}
		return {
			models,
			downloads: [...this.#sttDownloads.keys()],
			defaultKey,
			defaultCached: models.find(m => m.key === defaultKey)?.cached ?? false,
		} satisfies SttModelStatusResponse;
	}

	async sttModelDelete(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as { modelKey?: string };
		if (!p.modelKey) throw new Error("modelKey required");
		const { isSttModelKey } = await import("../../stt/models");
		if (!isSttModelKey(p.modelKey)) throw new Error(`unknown speech model: ${p.modelKey}`);
		if (this.#sttDownloads.size > 0) throw new Error("stop the model download before deleting it");
		const { deleteSttModel } = await import("../../stt/downloader");
		await deleteSttModel(p.modelKey);
		return { ok: true };
	}

	async sttModelDownload(params: unknown): Promise<unknown> {
		// Kick off a speech-model download WITHOUT awaiting it: the
		// RPC client times out at 15s but Whisper tiers are GB-scale,
		// so the request must return immediately. Progress AND both
		// terminal outcomes (stt.downloadDone / stt.downloadError)
		// ride the global event stream — same channel as
		// extensions.changed — so every open window stays in sync.
		const p = (params ?? {}) as { modelKey?: string };
		if (!p.modelKey) throw new Error("modelKey required");
		const { isSttModelKey } = await import("../../stt/models");
		// Reject unknown keys explicitly: resolveSttModelSpec silently
		// falls back to the default tier, which would download a
		// GB-scale model the user never asked for.
		if (!isSttModelKey(p.modelKey)) throw new Error(`unknown speech model: ${p.modelKey}`);
		// Engine component disabled from the plugin page: the download
		// entry point closes too (status list no longer shows the tier).
		const { isVoiceEngineDisabled, sttEngineComponentId } = await import("../../voice/engine-denylist");
		if (isVoiceEngineDisabled("stt", sttEngineComponentId(p.modelKey))) {
			throw new Error(`speech engine disabled for model: ${p.modelKey}`);
		}
		const modelKey = p.modelKey;
		// Idempotent re-trigger: a second window (or a double-click
		// race) must reuse the running fetch, not start a parallel one
		// into the same cache directory. Reserve the slot SYNCHRONOUSLY
		// so a second RPC racing the dynamic import below can't slip
		// past the guard; it is replaced by the real promise right after.
		if (this.#sttDownloads.has(modelKey)) return { ok: true, alreadyRunning: true };
		this.#sttDownloads.set(modelKey, Promise.resolve());
		try {
			const { downloadSttModel } = await import("../../stt/downloader");
			const emitSttEvent = (payload: Record<string, unknown>): void => {
				this.host.broadcast(payload);
			};
			// Exactly one run per key lives in #sttDownloads at a time,
			// so the finally can drop it unconditionally.
			const run = (async (): Promise<void> => {
				try {
					await downloadSttModel(modelKey, progress => {
						emitSttEvent({
							type: "stt.downloadProgress",
							modelKey,
							percent: progress.percent,
							loaded: progress.loaded,
							total: progress.total,
							label: progress.label,
						});
					});
					emitSttEvent({ type: "stt.downloadDone", modelKey });
				} catch (err) {
					emitSttEvent({
						type: "stt.downloadError",
						modelKey,
						message: err instanceof Error ? err.message : String(err),
					});
				} finally {
					this.#sttDownloads.delete(modelKey);
				}
			})();
			this.#sttDownloads.set(modelKey, run);
		} catch (err) {
			// Setup failed (import/dispatch): release the reservation.
			this.#sttDownloads.delete(modelKey);
			throw err;
		}
		return { ok: true };
	}

	async sttTranscribe(params: unknown): Promise<unknown> {
		// TUI-parity speech-to-text: same asr-client + local worker
		// (sherpa-ONNX) the TUI uses — not Google's web service.
		const p = (params ?? {}) as { audio: number[]; modelKey?: string; language?: string };
		if (!Array.isArray(p.audio) || p.audio.length === 0) throw new Error("audio required (16kHz mono floats)");
		const { sttClient } = await import("../../stt/asr-client");
		const { resolveEnabledSttModel } = await import("../../voice/engine-denylist");
		// Default follows the user's config (`stt.modelName`, TUI parity)
		// instead of a hardcoded tier — the GUI mic otherwise silently
		// uses a different model than the settings panel shows. Engine
		// components disabled from the plugin page fall back to the
		// first enabled tier (resolveEnabledSttModel), never a denied one.
		const { settings: appSettings } = await import("../../config/settings");
		const modelKey = p.modelKey
			? resolveEnabledSttModel(p.modelKey).key
			: resolveEnabledSttModel(appSettings.get("stt.modelName") as string | undefined).key;
		const text = await sttClient.transcribe(modelKey, Float32Array.from(p.audio), {
			...(p.language ? { language: p.language } : {}),
		});
		return { text };
	}

	async ttsRewrite(params: unknown): Promise<unknown> {
		// Enhanced read-aloud (`tts.enhanced`): rewrite one markdown
		// block into spoken prose with the session's tiny/smol role.
		// The terminal vocalizer constructs SpeechEnhancer directly;
		// this route gives the desktop the SAME service through RPC so
		// both shells share one rewrite implementation. Returns null
		// on any failure — the caller keeps the sanitized text.
		const p = (params ?? {}) as { sessionId: string; text: string };
		if (typeof p.sessionId !== "string" || typeof p.text !== "string" || !p.text.trim()) {
			throw new Error("sessionId and text required");
		}
		const live = this.host.get(p.sessionId);
		if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
		const session = live.agentSession;
		if (!session.settings.get("tts.enhanced")) return { text: null } satisfies TtsRewriteResponse;
		const { SpeechEnhancer } = await import("../../tts/speech-enhancer");
		const enhancer = new SpeechEnhancer({
			settings: session.settings,
			registry: session.modelRegistry,
			sessionId: p.sessionId,
			metadataResolver: provider => session.agent.metadataForProvider(provider),
		});
		const text = await enhancer.rewrite(p.text);
		return { text } satisfies TtsRewriteResponse;
	}

	async ttsSynthesize(params: unknown): Promise<unknown> {
		// TUI-parity speech synthesis: Kokoro-82M local model via the
		// same tts-client worker the TUI uses.
		const p = (params ?? {}) as { text: string; modelKey?: string; voice?: string };
		if (!p.text?.trim()) throw new Error("text required");
		const { ttsClient } = await import("../../tts/tts-client");
		const { resolveEnabledTtsModel } = await import("../../voice/engine-denylist");
		// Default follows the user's config (`tts.localModel`, TUI
		// parity) instead of the hardcoded model key.
		const { settings: appSettings } = await import("../../config/settings");
		const configured = appSettings.get("tts.localModel") as string | undefined;
		// Engine components disabled from the plugin page fall back to
		// the first enabled tier (resolveEnabledTtsModel) — same
		// resolution the modelStatus route reports as defaultKey.
		const modelKey = resolveEnabledTtsModel(p.modelKey ?? configured).key;
		// A failure resolves `audio: null` — without the worker's error
		// text the GUI cannot tell "模型未下载" from "合成失败", so the
		// client's onError hook captures it and the response carries it.
		let failure: string | undefined;
		const audio = await ttsClient.synthesize(modelKey as never, p.text, {
			...(p.voice ? { voice: p.voice } : {}),
			onError: message => {
				failure = message;
			},
		});
		if (!audio) return { audio: null, sampleRate: 0, error: failure ?? "synthesis failed" };
		return { audio: Array.from(audio.pcm), sampleRate: audio.sampleRate };
	}

	async ttsModelStatus(params: unknown): Promise<unknown> {
		// GUI voice page (stt.modelStatus parity): which local TTS tiers
		// are already on disk, so the 朗读模型 card can show "ready" vs
		// "needs download" per option. `downloads` lists model keys
		// mid-fetch so a freshly-mounted window renders its progress
		// row immediately, not after the next tick.
		const { isTtsModelCached } = await import("../../tts/downloader");
		const { enabledTtsModels, resolveEnabledTtsModel } = await import("../../voice/engine-denylist");
		// `satisfies` (not `:`) — the wire contract in @musepi/pi-wire
		// is the single source of truth for both shells; if the shape
		// here drifts, typecheck fails instead of the UI breaking.
		// Engine components disabled from the plugin page are filtered
		// out of the catalog entirely (settings picker reads the same
		// route — one source, no drift).
		const models: TtsModelRow[] = await Promise.all(
			enabledTtsModels().map(async m => ({
				key: m.key,
				label: m.label,
				cached: await isTtsModelCached(m.key),
				// The tier's voice catalog drives the picker's per-tier
				// voice radios (tts.localVoice): catalog order is the
				// sherpa sid order, so the GUI must never invent ids.
				voices: m.voices.map(voice => ({ id: voice.id, label: voice.label })),
			})),
		);
		// The card's radio seed follows the user's config (`tts.localModel`,
		// same resolution as tts.synthesize). Settings may be uninitialized
		// in bare harness contexts; fall back to the built-in default tier.
		// A selected tier whose engine component got disabled falls back
		// to the first enabled tier, same as the synthesis route.
		let defaultKey: string;
		try {
			const { settings: ttsSettings } = await import("../../config/settings");
			defaultKey = resolveEnabledTtsModel(ttsSettings.get("tts.localModel") as string | undefined).key;
		} catch {
			defaultKey = resolveEnabledTtsModel(undefined).key;
		}
		return { models, downloads: [...this.#ttsDownloads.keys()], defaultKey } satisfies TtsModelStatusResponse;
	}

	async ttsModelDelete(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as { modelKey?: string };
		if (!p.modelKey) throw new Error("modelKey required");
		const { isTtsLocalModelKey } = await import("../../tts/models");
		if (!isTtsLocalModelKey(p.modelKey)) throw new Error(`unknown TTS model: ${p.modelKey}`);
		if (this.#ttsDownloads.size > 0) throw new Error("stop the model download before deleting it");
		const { deleteTtsModel } = await import("../../tts/downloader");
		await deleteTtsModel(p.modelKey);
		return { ok: true };
	}

	async ttsModelDownload(params: unknown): Promise<unknown> {
		// Kick off a local TTS model download WITHOUT awaiting it —
		// stt.modelDownload parity (the fetch outlives the RPC timeout).
		// Progress AND both terminal outcomes (tts.downloadDone /
		// tts.downloadError) ride the global event stream, so every
		// open window stays in sync.
		const p = (params ?? {}) as { modelKey?: string };
		if (!p.modelKey) throw new Error("modelKey required");
		const { isTtsLocalModelKey } = await import("../../tts/models");
		// Reject unknown keys explicitly: downloadTtsModel would silently
		// return false, leaving the GUI's progress row hanging forever.
		if (!isTtsLocalModelKey(p.modelKey)) throw new Error(`unknown TTS model: ${p.modelKey}`);
		// Engine component disabled from the plugin page: the download
		// entry point closes too (status list no longer shows the tier).
		const { isVoiceEngineDisabled } = await import("../../voice/engine-denylist");
		if (isVoiceEngineDisabled("tts", p.modelKey)) {
			throw new Error(`TTS engine disabled for model: ${p.modelKey}`);
		}
		const modelKey = p.modelKey;
		// Idempotent re-trigger: a second window (or a double-click
		// race) must reuse the running fetch, not start a parallel one
		// into the same cache directory. Reserve the slot SYNCHRONOUSLY
		// so a second RPC racing the dynamic import below can't slip
		// past the guard; it is replaced by the real promise right after.
		if (this.#ttsDownloads.has(modelKey)) return { ok: true, alreadyRunning: true };
		this.#ttsDownloads.set(modelKey, Promise.resolve());
		try {
			const { downloadTtsModel } = await import("../../tts/downloader");
			const emitTtsEvent = (payload: Record<string, unknown>): void => {
				this.host.broadcast(payload);
			};
			// Exactly one run per key lives in #ttsDownloads at a time,
			// so the finally can drop it unconditionally.
			const run = (async (): Promise<void> => {
				try {
					let downloadError: string | undefined;
					const ok = await downloadTtsModel(
						modelKey,
						progress => {
							emitTtsEvent({
								type: "tts.downloadProgress",
								modelKey,
								percent: progress.percent ?? 0,
								label: progress.stage,
							});
						},
						undefined,
						message => {
							downloadError = message;
						},
					);
					// Preserve the worker's actionable failure text; use the generic
					// message only when a false result has no diagnostic.
					if (!ok) throw new Error(downloadError ?? "TTS model download failed");
					emitTtsEvent({ type: "tts.downloadDone", modelKey });
				} catch (err) {
					emitTtsEvent({
						type: "tts.downloadError",
						modelKey,
						message: err instanceof Error ? err.message : String(err),
					});
				} finally {
					this.#ttsDownloads.delete(modelKey);
				}
			})();
			this.#ttsDownloads.set(modelKey, run);
		} catch (err) {
			// Setup failed (import/dispatch): release the reservation.
			this.#ttsDownloads.delete(modelKey);
			throw err;
		}
		return { ok: true };
	}
}
