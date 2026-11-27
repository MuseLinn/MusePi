/**
 * Neural sentence endpointing with energy-based phrase previews. Sample ranges
 * always refer to the original stream; detector-owned audio is never authoritative.
 */
import type { EndpointerEvent, LiveEndpointer } from "./endpointer";

export interface DetectedSpeech {
	start: number;
	samples: Float32Array;
}

export interface SpeechDetector {
	acceptWaveform(samples: Float32Array): void;
	isEmpty(): boolean;
	isDetected(): boolean;
	front(enableExternalBuffer?: boolean): DetectedSpeech;
	pop(): void;
	flush(): void;
}

export interface SpeechEndpointerConfig {
	sampleRate: number;
	preRollMs: number;
	tailMs: number;
	onsetLookbackMs: number;
	phraseSilenceMs: number;
	minPhraseMs: number;
	energyFrameMs: number;
	minThreshold: number;
	partialIntervalMs: number;
	fallbackWindowMs: number;
	fallbackMinRms: number;
}

export const DEFAULT_SPEECH_ENDPOINTER_CONFIG: SpeechEndpointerConfig = {
	sampleRate: 16_000,
	preRollMs: 250,
	tailMs: 120,
	onsetLookbackMs: 500,
	phraseSilenceMs: 160,
	minPhraseMs: 1_000,
	energyFrameMs: 20,
	minThreshold: 0.008,
	partialIntervalMs: 450,
	fallbackWindowMs: 30_000,
	fallbackMinRms: 0.003,
};

class FloatBuffer {
	#data = new Float32Array(1 << 14);
	#len = 0;

	get length(): number {
		return this.#len;
	}

	push(samples: Float32Array): void {
		const needed = this.#len + samples.length;
		if (needed > this.#data.length) {
			const next = new Float32Array(Math.max(this.#data.length * 2, needed));
			next.set(this.#data.subarray(0, this.#len));
			this.#data = next;
		}
		this.#data.set(samples, this.#len);
		this.#len = needed;
	}

	slice(start: number, end: number): Float32Array {
		return this.#data.slice(start, end);
	}

	discard(count: number): void {
		this.#data.copyWithin(0, count, this.#len);
		this.#len -= count;
	}
}

function rms(frame: Float32Array): number {
	let energy = 0;
	for (const sample of frame) energy += sample * sample;
	return Math.sqrt(energy / Math.max(1, frame.length));
}

export class SpeechEndpointer implements LiveEndpointer {
	readonly #cfg: SpeechEndpointerConfig;
	readonly #detector: SpeechDetector;
	readonly #preRoll: number;
	readonly #tail: number;
	readonly #lookback: number;
	readonly #fallbackWindow: number;
	readonly #energyFrame: number;
	readonly #audio = new FloatBuffer();
	#base = 0;
	#committedEnd = 0;
	#onset = -1;
	#lastPartialAt = 0;
	#slowPartials = 0;
	#heardSpeech = false;
	#energyLeftover = new Float32Array(0);
	#energyConsumed = 0;
	#energySilenceMs = 0;
	#phraseStart = 0;
	#lastVoicedEnd = 0;

	constructor(detector: SpeechDetector, config: Partial<SpeechEndpointerConfig> = {}) {
		this.#cfg = { ...DEFAULT_SPEECH_ENDPOINTER_CONFIG, ...config };
		this.#detector = detector;
		const samples = (ms: number) => Math.round((this.#cfg.sampleRate * ms) / 1000);
		this.#preRoll = samples(this.#cfg.preRollMs);
		this.#tail = samples(this.#cfg.tailMs);
		this.#lookback = samples(this.#cfg.onsetLookbackMs);
		this.#fallbackWindow = samples(this.#cfg.fallbackWindowMs);
		this.#energyFrame = Math.max(1, samples(this.#cfg.energyFrameMs));
	}

	get partialsEnabled(): boolean {
		return this.#slowPartials < 2;
	}

	notePartialDecode(ms: number, now = performance.now()): void {
		this.#lastPartialAt = now;
		this.#slowPartials = ms >= this.#cfg.partialIntervalMs ? this.#slowPartials + 1 : 0;
	}

	push(samples: Float32Array, now = performance.now()): EndpointerEvent[] {
		const events: EndpointerEvent[] = [];
		this.#audio.push(samples);
		this.#detector.acceptWaveform(samples);
		this.#drain(events);
		const end = this.#base + this.#audio.length;
		if (!this.#detector.isDetected()) {
			this.#onset = -1;
			if (this.#heardSpeech) this.#release(end - this.#lookback - this.#preRoll);
			return events;
		}
		if (this.#onset < 0) {
			this.#onset = Math.max(this.#committedEnd, end - this.#lookback);
			this.#phraseStart = this.#onset;
			this.#lastVoicedEnd = this.#onset;
			this.#energySilenceMs = 0;
		}
		this.#processEnergy(samples, end - samples.length, now, events);
		if (this.partialsEnabled && now - this.#lastPartialAt >= this.#cfg.partialIntervalMs) {
			this.#emitPartial(events, end, now, false);
		}
		return events;
	}

	flush(): EndpointerEvent[] {
		const events: EndpointerEvent[] = [];
		this.#detector.flush();
		this.#drain(events);
		this.#onset = -1;
		if (this.#heardSpeech) return events;
		const end = this.#base + this.#audio.length;
		for (let from = this.#base; from < end; from += this.#fallbackWindow) {
			const to = Math.min(end, from + this.#fallbackWindow);
			const audio = this.#slice(from, to);
			if (rms(audio) >= this.#cfg.fallbackMinRms) events.push({ kind: "segment", start: from, end: to, audio });
		}
		this.#committedEnd = end;
		this.#release(end);
		return events;
	}

	#processEnergy(samples: Float32Array, chunkStart: number, now: number, events: EndpointerEvent[]): void {
		let buf = samples;
		if (this.#energyLeftover.length > 0) {
			buf = new Float32Array(this.#energyLeftover.length + samples.length);
			buf.set(this.#energyLeftover, 0);
			buf.set(samples, this.#energyLeftover.length);
		}
		let offset = 0;
		for (; offset + this.#energyFrame <= buf.length; offset += this.#energyFrame) {
			const start = Math.max(this.#energyConsumed, chunkStart - this.#energyLeftover.length + offset);
			const end = start + this.#energyFrame;
			this.#energyConsumed += this.#energyFrame;
			if (end <= this.#onset) continue;
			const frame = buf.subarray(offset, offset + this.#energyFrame);
			if (rms(frame) > this.#cfg.minThreshold) {
				this.#energySilenceMs = 0;
				this.#lastVoicedEnd = end;
				continue;
			}
			this.#energySilenceMs += this.#cfg.energyFrameMs;
			if (
				this.#energySilenceMs >= this.#cfg.phraseSilenceMs &&
				this.#lastVoicedEnd - this.#phraseStart >= (this.#cfg.minPhraseMs * this.#cfg.sampleRate) / 1000
			) {
				this.#emitPartial(events, Math.min(end, this.#lastVoicedEnd + this.#tail), now, true);
			}
		}
		this.#energyLeftover = buf.slice(offset);
	}

	#emitPartial(events: EndpointerEvent[], end: number, now: number, phrase: boolean): void {
		if (!this.partialsEnabled || this.#onset < 0 || end <= this.#onset) return;
		if (now - this.#lastPartialAt < this.#cfg.partialIntervalMs) return;
		events.push({ kind: "partial", start: this.#onset, end, audio: this.#slice(this.#onset, end) });
		this.#lastPartialAt = now;
		if (phrase) this.#phraseStart = end;
	}

	#drain(events: EndpointerEvent[]): void {
		const end = this.#base + this.#audio.length;
		while (!this.#detector.isEmpty()) {
			const speech = this.#detector.front(false);
			this.#detector.pop();
			const from = Math.max(this.#committedEnd, this.#base, speech.start - this.#preRoll);
			const to = Math.min(end, speech.start + speech.samples.length + this.#tail);
			if (to <= from) continue;
			events.push({ kind: "segment", start: from, end: to, audio: this.#slice(from, to) });
			this.#committedEnd = to;
			this.#onset = -1;
			this.#slowPartials = 0;
			this.#lastPartialAt = 0;
			this.#heardSpeech = true;
		}
		this.#release(this.#committedEnd);
	}

	#release(upTo: number): void {
		const count = Math.max(this.#committedEnd, upTo) - this.#base;
		if (count <= 0) return;
		this.#audio.discard(count);
		this.#base += count;
	}

	#slice(from: number, to: number): Float32Array {
		return this.#audio.slice(from - this.#base, to - this.#base);
	}
}
