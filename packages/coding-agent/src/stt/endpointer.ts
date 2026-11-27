/**
 * Energy-based fallback endpointer for live transcription. Events carry absolute
 * sample ranges so the worker can decode retained raw audio instead of VAD output.
 */

export interface EndpointerConfig {
	sampleRate: number;
	frameMs: number;
	endSilenceMs: number;
	minSpeechMs: number;
	maxSegmentMs: number;
	preRollMs: number;
	tailMs: number;
	phraseSilenceMs: number;
	minPhraseMs: number;
	partialIntervalMs: number;
	energyRatio: number;
	floorAttack: number;
	minThreshold: number;
}

export const DEFAULT_ENDPOINTER_CONFIG: EndpointerConfig = {
	sampleRate: 16_000,
	frameMs: 30,
	endSilenceMs: 700,
	minSpeechMs: 200,
	maxSegmentMs: 30_000,
	preRollMs: 250,
	tailMs: 120,
	phraseSilenceMs: 160,
	minPhraseMs: 1_000,
	partialIntervalMs: 450,
	energyRatio: 2.5,
	floorAttack: 0.05,
	minThreshold: 0.008,
};

export type EndpointerEvent = {
	kind: "partial" | "segment";
	audio: Float32Array;
	start: number;
	end: number;
};

export interface LiveEndpointer {
	push(samples: Float32Array, now?: number): EndpointerEvent[];
	flush(): EndpointerEvent[];
	readonly partialsEnabled: boolean;
	notePartialDecode(ms: number, now?: number): void;
}

class FloatBuffer {
	#data = new Float32Array(0);
	#len = 0;

	get length(): number {
		return this.#len;
	}

	push(samples: Float32Array): void {
		const needed = this.#len + samples.length;
		if (needed > this.#data.length) {
			const next = new Float32Array(Math.max(this.#data.length * 2, needed, 1 << 14));
			next.set(this.#data.subarray(0, this.#len));
			this.#data = next;
		}
		this.#data.set(samples, this.#len);
		this.#len = needed;
	}

	take(end = this.#len): Float32Array {
		return this.#data.slice(0, Math.max(0, Math.min(end, this.#len)));
	}

	reset(): void {
		this.#len = 0;
	}
}

function rms(frame: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < frame.length; i += 1) sum += frame[i]! * frame[i]!;
	return Math.sqrt(sum / Math.max(1, frame.length));
}

export class StreamEndpointer implements LiveEndpointer {
	readonly #cfg: EndpointerConfig;
	readonly #frameSamples: number;
	readonly #preRollSamples: number;
	readonly #tailSamples: number;
	#slowPartials = 0;
	#lastPartialAt = 0;
	#leftover = new Float32Array(0);
	#consumed = 0;
	#inSpeech = false;
	#noiseFloor: number;
	#silenceMs = 0;
	#segmentMs = 0;
	#segmentStart = -1;
	#phraseStart = 0;
	#lastVoicedEnd = 0;
	#partialDirty = false;
	readonly #segment = new FloatBuffer();
	readonly #preRoll = new FloatBuffer();

	constructor(config: Partial<EndpointerConfig> = {}) {
		this.#cfg = { ...DEFAULT_ENDPOINTER_CONFIG, ...config };
		this.#frameSamples = Math.max(1, Math.round((this.#cfg.sampleRate * this.#cfg.frameMs) / 1000));
		this.#preRollSamples = Math.max(0, Math.round((this.#cfg.sampleRate * this.#cfg.preRollMs) / 1000));
		this.#tailSamples = Math.max(0, Math.round((this.#cfg.sampleRate * this.#cfg.tailMs) / 1000));
		this.#noiseFloor = this.#cfg.minThreshold;
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
		let buf: Float32Array;
		if (this.#leftover.length === 0) {
			buf = samples;
		} else {
			buf = new Float32Array(this.#leftover.length + samples.length);
			buf.set(this.#leftover, 0);
			buf.set(samples, this.#leftover.length);
		}
		let offset = 0;
		for (; offset + this.#frameSamples <= buf.length; offset += this.#frameSamples) {
			const start = this.#consumed;
			this.#consumed += this.#frameSamples;
			this.#processFrame(buf.subarray(offset, offset + this.#frameSamples), start, now, events);
		}
		this.#leftover = buf.slice(offset);
		return events;
	}

	flush(): EndpointerEvent[] {
		const events: EndpointerEvent[] = [];
		let end = this.#consumed;
		if (this.#inSpeech && this.#leftover.length > 0) {
			this.#segment.push(this.#leftover);
			this.#segmentMs += (this.#leftover.length / this.#cfg.sampleRate) * 1000;
			end += this.#leftover.length;
		}
		this.#leftover = new Float32Array(0);
		if (this.#inSpeech && this.#segmentMs - this.#silenceMs >= this.#cfg.minSpeechMs) {
			this.#emitSegment(events, end);
		}
		this.#reset();
		return events;
	}

	#processFrame(frame: Float32Array, start: number, now: number, events: EndpointerEvent[]): void {
		const energy = rms(frame);
		const threshold = Math.max(this.#cfg.minThreshold, this.#noiseFloor * this.#cfg.energyRatio);
		const voiced = energy > threshold;
		if (!voiced) this.#noiseFloor = this.#noiseFloor * (1 - this.#cfg.floorAttack) + energy * this.#cfg.floorAttack;
		const end = start + frame.length;

		if (!this.#inSpeech) {
			if (voiced) {
				this.#beginSegment(frame, start);
			} else {
				this.#preRoll.push(frame);
				if (this.#preRoll.length > this.#preRollSamples) {
					const tail = this.#preRoll.take().slice(this.#preRoll.length - this.#preRollSamples);
					this.#preRoll.reset();
					this.#preRoll.push(tail);
				}
			}
			return;
		}

		this.#segment.push(frame);
		this.#segmentMs += (frame.length / this.#cfg.sampleRate) * 1000;
		if (voiced) {
			this.#silenceMs = 0;
			this.#lastVoicedEnd = end;
			this.#partialDirty = true;
		} else {
			this.#silenceMs += (frame.length / this.#cfg.sampleRate) * 1000;
		}

		if (this.#silenceMs >= this.#cfg.endSilenceMs) {
			this.#finalizeSegment(events, end);
			return;
		}
		if (this.#segmentMs >= this.#cfg.maxSegmentMs) {
			this.#emitSegment(events, end);
			this.#segmentStart = end;
			this.#phraseStart = end;
			this.#lastVoicedEnd = end;
			this.#segment.reset();
			this.#segmentMs = 0;
			this.#silenceMs = 0;
			this.#partialDirty = false;
			return;
		}

		const phrasePause =
			this.#silenceMs >= this.#cfg.phraseSilenceMs &&
			this.#lastVoicedEnd - this.#phraseStart >= (this.#cfg.minPhraseMs * this.#cfg.sampleRate) / 1000;
		if (
			this.partialsEnabled &&
			this.#partialDirty &&
			(phrasePause || now - this.#lastPartialAt >= this.#cfg.partialIntervalMs)
		) {
			const partialEnd = Math.min(end, this.#lastVoicedEnd + this.#tailSamples);
			if (partialEnd <= this.#segmentStart) return;
			events.push({
				kind: "partial",
				start: this.#segmentStart,
				end: partialEnd,
				audio: this.#segment.take(partialEnd - this.#segmentStart),
			});
			this.#lastPartialAt = now;
			if (phrasePause) this.#phraseStart = partialEnd;
			this.#partialDirty = false;
		}
	}

	#beginSegment(onsetFrame: Float32Array, start: number): void {
		this.#inSpeech = true;
		this.#segment.reset();
		const preRoll = this.#preRoll.take();
		this.#segmentStart = Math.max(0, start - preRoll.length);
		if (preRoll.length > 0) this.#segment.push(preRoll);
		this.#segment.push(onsetFrame);
		this.#preRoll.reset();
		this.#silenceMs = 0;
		this.#segmentMs = (this.#segment.length / this.#cfg.sampleRate) * 1000;
		this.#phraseStart = this.#segmentStart;
		this.#lastVoicedEnd = start + onsetFrame.length;
		this.#partialDirty = true;
	}

	#finalizeSegment(events: EndpointerEvent[], end: number): void {
		if (this.#segmentMs - this.#silenceMs >= this.#cfg.minSpeechMs) this.#emitSegment(events, end);
		this.#inSpeech = false;
		this.#segmentStart = -1;
		this.#segment.reset();
		this.#preRoll.reset();
		this.#silenceMs = 0;
		this.#segmentMs = 0;
		this.#partialDirty = false;
		this.#slowPartials = 0;
		this.#lastPartialAt = 0;
	}

	#emitSegment(events: EndpointerEvent[], frameEnd: number): void {
		const dropMs = Math.max(0, this.#silenceMs - this.#cfg.tailMs);
		const drop = Math.round((this.#cfg.sampleRate * dropMs) / 1000);
		const end = Math.max(this.#segmentStart, frameEnd - drop);
		events.push({
			kind: "segment",
			start: this.#segmentStart,
			end,
			audio: this.#segment.take(end - this.#segmentStart),
		});
	}

	#reset(): void {
		this.#inSpeech = false;
		this.#segmentStart = -1;
		this.#segment.reset();
		this.#preRoll.reset();
		this.#silenceMs = 0;
		this.#segmentMs = 0;
		this.#partialDirty = false;
		this.#noiseFloor = this.#cfg.minThreshold;
		this.#slowPartials = 0;
		this.#lastPartialAt = 0;
	}
}
