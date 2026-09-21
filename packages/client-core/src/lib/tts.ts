/**
 * Voice output (design frames 「语音输出四帧」): the daemon exposes
 * `tts.synthesize` (local Kokoro-82M), so the client only ships cleaned text
 * and plays the returned PCM through Web Audio — no on-device model.
 *
 * One controller per session client (WeakMap singleton): the transcript's
 * per-message speak buttons, the composer mini-player and the voice-input
 * barge-in all share it without prop drilling. The controller is an external
 * store (`subscribe`/`getSnapshot`) so playback progress never re-renders the
 * shell — only the components that opt in via `useTtsSnapshot`.
 *
 * Auto-read ("自动朗读") watches the client snapshot directly: when a NEW
 * settled assistant entry lands, its text is synthesized and spoken — the
 * newest answer supersedes anything in flight (no stale queues).
 */

import { useSyncExternalStore } from "react";
import type { SessionClient } from "./client";
import { haptic } from "./haptics";
import { nativeVoiceSupport, speakNative } from "./native-voice";

export type TtsEngine = "auto" | "daemon" | "native";
export type SttLang = "" | "zh-CN" | "en-US";

export interface TtsSnapshot {
	phase: "idle" | "loading" | "playing";
	/** Assistant entry id being spoken — the message-row button highlight. */
	speakingId: string | null;
	/** 0..1 playback progress; 0 while loading. */
	progress: number;
	/** Elapsed / total playback seconds (0 while loading). */
	elapsedSec: number;
	totalSec: number;
	autoRead: boolean;
	/** True after a tts.* failure that means "this transport can't do TTS" —
	 *  the guide state (collab-direct host), not a transient error. */
	guide: boolean;
	/** Readable daemon error (model not ready, …); cleared on next action. */
	error: string | null;
	/** Speech engine routing (voice panel setting). */
	engine: TtsEngine;
	/** Daemon Kokoro voice id; "" = the daemon's configured default. */
	voice: string;
	/** System voice name for the native engine; "" = OS language match. */
	nativeVoice: string;
	/** 0.5–2.0 playback speed (daemon playbackRate / native utterance.rate). */
	rate: number;
}

const PROGRESS_TICK_MS = 250;
const TTS_TIMEOUT_MS = 20_000;
/** Native speechSynthesis reports no duration — elapsed-only one-second ticks. */
const NATIVE_TICK_MS = 1_000;
/** Bound the RPC payload: Kokoro PCM over JSON is ~100KB per spoken second. */
const MAX_SPEAK_CHARS = 1200;
const AUTO_READ_KEY = "omp.collab.tts.autoRead";
const ENGINE_KEY = "omp.collab.tts.engine";
const VOICE_KEY = "omp.collab.tts.voice";
const NATIVE_VOICE_KEY = "omp.collab.tts.nativeVoice";
const RATE_KEY = "omp.collab.tts.rate";
const STT_LANG_KEY = "omp.collab.stt.lang";
const MAX_TRACKED_ENTRIES = 200;

/** Dictation language pref — shared with the composer's voice input. */
export function readSttLangPref(): SttLang {
	try {
		const v = globalThis.localStorage.getItem(STT_LANG_KEY);
		return v === "zh-CN" || v === "en-US" ? v : "";
	} catch {
		return "";
	}
}

export function writeSttLangPref(lang: SttLang): void {
	try {
		globalThis.localStorage.setItem(STT_LANG_KEY, lang);
	} catch {
		// storage unavailable — session-only preference
	}
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("tts timeout")), TTS_TIMEOUT_MS);
		promise.then(
			value => {
				clearTimeout(timer);
				resolve(value);
			},
			err => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

/** Whether an RPC failure means "transport has no TTS" vs a readable error. */
function isTransportMiss(message: string): boolean {
	return message === "rpc failed" || message === "tts timeout";
}

/** Strip markdown to something Kokoro can read aloud naturally. */
function cleanForSpeech(raw: string): string {
	return raw
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_SPEAK_CHARS);
}

/** Concatenate the plain-text blocks of an assistant message. */
function extractText(message: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return message.content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text as string)
		.join("\n");
}

export class TtsController {
	readonly #client: SessionClient;
	readonly #listeners = new Set<() => void>();
	readonly #unsub: () => void;
	/** Assistant entry ids already consumed by auto-read (baseline on join so
	 *  existing history is never read aloud). */
	readonly #seen = new Set<string>();
	#state: TtsSnapshot;
	#ctx: AudioContext | null = null;
	#src: AudioBufferSourceNode | null = null;
	#tick: number | null = null;
	/** Active system-speech stop handle (native fallback playback). */
	#nativeStop: (() => void) | null = null;
	#startedAt = 0;
	#duration = 0;
	/** Stop epoch — every stop()/new speak() invalidates in-flight callbacks. */
	#gen = 0;

	constructor(client: SessionClient) {
		this.#client = client;
		this.#state = {
			phase: "idle",
			speakingId: null,
			progress: 0,
			elapsedSec: 0,
			totalSec: 0,
			autoRead: readAutoReadPref(),
			guide: false,
			error: null,
			engine: readEnginePref(),
			voice: readVoicePref(),
			nativeVoice: readNativeVoicePref(),
			rate: readRatePref(),
		};
		this.#unsub = client.subscribe(() => this.#onClientNotify());
		for (const entry of client.getSnapshot().entries) this.#markSeen(entry.id);
	}

	getSnapshot = (): TtsSnapshot => this.#state;

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	/** Synthesize + play a text (per-message button, auto-read, or the
	 *  voice-panel test/preview). `opts.voice` previews a candidate without
	 *  touching the persisted pick. */
	speak(text: string, messageId?: string, opts?: { voice?: string; rate?: number }): void {
		const clean = cleanForSpeech(text);
		if (!clean) return;
		this.#stopAudio();
		const gen = ++this.#gen;
		const voice = opts?.voice ?? this.#state.voice;
		const rate = opts?.rate ?? this.#state.rate;
		this.#publish({
			phase: "loading",
			speakingId: messageId ?? null,
			progress: 0,
			elapsedSec: 0,
			totalSec: 0,
			error: null,
		});
		haptic(8);
		// Pinned native engine: skip the daemon round-trip entirely.
		if (this.#state.engine === "native") {
			this.#speakNative(clean, gen, messageId ?? null, rate);
			return;
		}
		withTimeout(
			this.#client.rpc<{ audio: number[]; sampleRate: number }>("tts.synthesize", {
				text: clean,
				...(voice ? { voice } : {}),
			}),
		)
			.then(res => {
				if (gen !== this.#gen) return;
				this.#play(Float32Array.from(res?.audio ?? []), res?.sampleRate || 24_000, gen, messageId ?? null, rate);
			})
			.catch((err: unknown) => {
				if (gen !== this.#gen) return;
				const msg = err instanceof Error ? err.message : String(err);
				if (isTransportMiss(msg)) {
					// collab-direct host (or a silent one): fall back to the
					// webview's system speech engine (openchamber parity) —
					// read-aloud keeps working with no daemon at all. Only a
					// device without speechSynthesis lands in the guide.
					if (this.#state.engine !== "daemon" && nativeVoiceSupport().synthesis) {
						this.#speakNative(clean, gen, messageId ?? null, rate);
					} else {
						this.#publish({ phase: "idle", speakingId: null, guide: true });
						haptic(30);
					}
				} else {
					this.#publish({ phase: "idle", speakingId: null, error: msg });
					haptic(30);
				}
			});
	}

	/** Stop playback / cancel synthesis (message button re-tap, mini player, barge-in). */
	stop(): void {
		this.#gen++;
		this.#stopAudio();
		if (this.#state.phase !== "idle") {
			this.#publish({ phase: "idle", speakingId: null, progress: 0, elapsedSec: 0, totalSec: 0 });
		}
	}

	toggleAutoRead(): void {
		const next = !this.#state.autoRead;
		writeAutoReadPref(next);
		this.#publish({ autoRead: next });
		if (!next) this.stop();
		else haptic(8);
	}

	/** Voice-panel setters: persist + publish so every subscriber (mini
	 *  player, transcript highlight, panel rows) sees the same truth. */
	setEngine(engine: TtsEngine): void {
		writeEnginePref(engine);
		this.#publish({ engine });
	}

	setVoice(voice: string): void {
		writeVoicePref(voice);
		this.#publish({ voice });
	}

	setNativeVoice(name: string): void {
		writeNativeVoicePref(name);
		this.#publish({ nativeVoice: name });
	}

	setRate(rate: number): void {
		const clamped = Math.min(2, Math.max(0.5, rate));
		writeRatePref(clamped);
		this.#publish({ rate: clamped });
	}

	dismissGuide(): void {
		this.#publish({ guide: false });
	}

	dismissError(): void {
		this.#publish({ error: null });
	}

	dispose(): void {
		this.#unsub();
		this.stop();
		if (this.#ctx) void this.#ctx.close();
	}

	#onClientNotify(): void {
		const snap = this.#client.getSnapshot();
		if (snap.phase === "ended" || snap.phase === "reconnecting") {
			this.stop();
			for (const entry of snap.entries) this.#markSeen(entry.id);
			return;
		}
		if (!this.#state.autoRead) {
			for (const entry of snap.entries) this.#markSeen(entry.id);
			return;
		}
		// Auto-read: the newest NEW settled assistant entry wins; anything in
		// flight is replaced (speak() already stops the previous playback).
		let newestText: string | null = null;
		let newestId: string | null = null;
		for (const entry of snap.entries) {
			if (this.#seen.has(entry.id)) continue;
			this.#markSeen(entry.id);
			if (entry.type === "message" && entry.message.role === "assistant") {
				const text = extractText(entry.message as { content: ReadonlyArray<{ type: string; text?: string }> });
				if (text.trim()) {
					newestText = text;
					newestId = entry.id;
				}
			}
		}
		if (newestText !== null && !snap.readOnly) {
			this.speak(newestText, newestId ?? undefined);
		}
	}

	#play(pcm: Float32Array<ArrayBuffer>, sampleRate: number, gen: number, messageId: string | null, rate = 1): void {
		if (pcm.length === 0) {
			this.#publish({ phase: "idle", speakingId: null, error: "empty audio" });
			return;
		}
		this.#ctx ??= new window.AudioContext();
		void this.#ctx.resume();
		const buffer = this.#ctx.createBuffer(1, pcm.length, sampleRate);
		buffer.copyToChannel(pcm, 0);
		const src = this.#ctx.createBufferSource();
		src.buffer = buffer;
		// Rate is a playback-side time-stretch (pitch-preserving in Chromium/
		// WebKit) — the daemon's Kokoro PCM needs no resampling, same as the
		// desktop HTMLAudioElement approach.
		if (rate !== 1) src.playbackRate.value = rate;
		src.connect(this.#ctx.destination);
		src.onended = () => {
			// Only a still-current source settles the UI; a superseded one was
			// already stopped by #stopAudio + a fresh publish.
			if (gen !== this.#gen) return;
			this.stop();
		};
		src.start();
		this.#src = src;
		this.#duration = buffer.duration / rate;
		this.#startedAt = this.#ctx.currentTime;
		this.#publish({ phase: "playing" });
		this.#tick = window.setInterval(() => {
			const elapsed = Math.max(0, (this.#ctx?.currentTime ?? 0) - this.#startedAt);
			this.#publish({
				progress: Math.min(1, elapsed / this.#duration),
				elapsedSec: Math.floor(elapsed),
				totalSec: Math.max(1, Math.round(this.#duration)),
			});
		}, PROGRESS_TICK_MS);
	}

	/**
	 * Native fallback playback: the system speech engine can't report a
	 * duration up front, so progress stays 0 and the mini player shows
	 * elapsed-only ticks until `onend` settles the state.
	 */
	#speakNative(text: string, gen: number, messageId: string | null, rate = 1): void {
		this.#stopAudio();
		this.#publish({ phase: "playing", progress: 0, elapsedSec: 0, totalSec: 0 });
		this.#tick = window.setInterval(() => {
			this.#publish({ elapsedSec: this.#state.elapsedSec + 1 });
		}, NATIVE_TICK_MS);
		this.#nativeStop = speakNative(
			text,
			{ voiceName: this.#state.nativeVoice || undefined, rate },
			{
				onEnd: () => {
					if (gen !== this.#gen) return;
					this.stop();
				},
				onError: message => {
					if (gen !== this.#gen) return;
					this.#publish({ phase: "idle", speakingId: null, error: message });
					haptic(30);
				},
			},
		);
	}

	#stopAudio(): void {
		if (this.#tick !== null) {
			window.clearInterval(this.#tick);
			this.#tick = null;
		}
		if (this.#nativeStop) {
			const stop = this.#nativeStop;
			this.#nativeStop = null;
			stop();
		}
		if (this.#src) {
			this.#src.onended = null;
			try {
				this.#src.stop();
			} catch {
				// already stopped
			}
			this.#src.disconnect();
			this.#src = null;
		}
	}

	#markSeen(id: string): void {
		this.#seen.add(id);
		if (this.#seen.size > MAX_TRACKED_ENTRIES) {
			// Bound memory: drop the oldest half (insertion order).
			const ids = [...this.#seen];
			for (const old of ids.slice(0, ids.length - MAX_TRACKED_ENTRIES / 2)) this.#seen.delete(old);
		}
	}

	#publish(partial: Partial<TtsSnapshot>): void {
		this.#state = { ...this.#state, ...partial };
		for (const listener of this.#listeners) listener();
	}
}

function readAutoReadPref(): boolean {
	try {
		return globalThis.localStorage.getItem(AUTO_READ_KEY) === "1";
	} catch {
		return false;
	}
}

function writeAutoReadPref(on: boolean): void {
	try {
		globalThis.localStorage.setItem(AUTO_READ_KEY, on ? "1" : "0");
	} catch {
		// storage unavailable — session-only preference
	}
}

function readEnginePref(): TtsEngine {
	try {
		const v = globalThis.localStorage.getItem(ENGINE_KEY);
		return v === "daemon" || v === "native" ? v : "auto";
	} catch {
		return "auto";
	}
}

function writeEnginePref(engine: TtsEngine): void {
	try {
		globalThis.localStorage.setItem(ENGINE_KEY, engine);
	} catch {
		// storage unavailable — session-only preference
	}
}

function readVoicePref(): string {
	try {
		return globalThis.localStorage.getItem(VOICE_KEY) ?? "";
	} catch {
		return "";
	}
}

function writeVoicePref(voice: string): void {
	try {
		globalThis.localStorage.setItem(VOICE_KEY, voice);
	} catch {
		// storage unavailable — session-only preference
	}
}

function readNativeVoicePref(): string {
	try {
		return globalThis.localStorage.getItem(NATIVE_VOICE_KEY) ?? "";
	} catch {
		return "";
	}
}

function writeNativeVoicePref(name: string): void {
	try {
		globalThis.localStorage.setItem(NATIVE_VOICE_KEY, name);
	} catch {
		// storage unavailable — session-only preference
	}
}

function readRatePref(): number {
	try {
		const v = Number.parseFloat(globalThis.localStorage.getItem(RATE_KEY) ?? "");
		if (Number.isFinite(v)) return Math.min(2, Math.max(0.5, v));
	} catch {
		// fall through
	}
	return 1;
}

function writeRatePref(rate: number): void {
	try {
		globalThis.localStorage.setItem(RATE_KEY, String(rate));
	} catch {
		// storage unavailable — session-only preference
	}
}

// ── React glue ───────────────────────────────────────────────────────────────

const controllers = new WeakMap<object, TtsController>();

/** Per-client singleton — TranscriptPane buttons and the composer mini-player
 *  share one controller without prop drilling through the shell. */
export function useTts(client: SessionClient): TtsController {
	let controller = controllers.get(client);
	if (!controller) {
		controller = new TtsController(client);
		controllers.set(client, controller);
	}
	return controller;
}

/** Subscribe a component to the controller state (mini player, highlights).
 *  The server-snapshot mirror keeps renderToString tests happy. */
export function useTtsSnapshot(tts: TtsController): TtsSnapshot {
	return useSyncExternalStore(tts.subscribe, tts.getSnapshot, tts.getSnapshot);
}
