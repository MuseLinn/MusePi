import type { SttWorkerOutbound } from "./asr-protocol";
import type { EndpointerEvent, LiveEndpointer } from "./endpointer";

export const STREAMING_MAX_SECONDS = 600;
export const MIN_DECODE_MS = 1_000;

interface DecodeWork {
	start: number;
	end: number;
	audio?: Float32Array;
	timed?: boolean;
}

export interface LiveStreamingSessionOptions {
	id: string;
	sampleRate?: number;
	minDecodeMs?: number;
	maxSamples?: number;
	createEndpointer: () => Promise<LiveEndpointer>;
	decode(audio: Float32Array, kind: "partial" | "segment"): Promise<string>;
	send(message: SttWorkerOutbound): void;
}

class Pcm16Audio {
	#data = new Int16Array(1 << 14);
	#length = 0;
	readonly #maxSamples: number;

	constructor(maxSamples: number) {
		this.#maxSamples = maxSamples;
	}

	get length(): number {
		return this.#length;
	}

	append(samples: Float32Array): void {
		const needed = this.#length + samples.length;
		if (needed > this.#maxSamples) throw new Error("Streaming dictation reached its 10 minute audio limit");
		if (needed > this.#data.length) {
			const next = new Int16Array(Math.max(this.#data.length * 2, needed));
			next.set(this.#data.subarray(0, this.#length));
			this.#data = next;
		}
		for (let index = 0; index < samples.length; index += 1) {
			this.#data[this.#length + index] = Math.max(-32_768, Math.min(32_767, Math.round(samples[index]! * 32_768)));
		}
		this.#length = needed;
	}

	slice(start: number, end: number): Float32Array {
		const from = Math.max(0, Math.min(this.#length, start));
		const to = Math.max(from, Math.min(this.#length, end));
		const audio = new Float32Array(to - from);
		for (let index = from; index < to; index += 1) audio[index - from] = this.#data[index]! / 32_768;
		return audio;
	}
}

const CJK_CHAR = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/u;

export function joinSegmentTexts(texts: readonly string[]): string {
	let out = "";
	for (const text of texts) {
		if (text.length === 0) continue;
		if (out.length > 0 && !CJK_CHAR.test(out.at(-1)!) && !CJK_CHAR.test(text[0]!)) out += " ";
		out += text;
	}
	return out;
}

export function stripPreviewPunctuation(text: string): string {
	return text.replace(/[\s.!?。！？，,、；;：:…]+$/u, "");
}

const CAPTION_ARTEFACTS = new Set([
	"subtitles by",
	"subtitles by amara.org",
	"subtitles by the amara.org community",
	"subtitles created by",
	"subtitled by",
	"translated by",
	"transcribed by",
	"captioned by",
	"amara.org",
	"www.mooji.org",
]);

export function filterFinalTranscript(text: string): string {
	const trimmed = text.trim();
	const normalized = trimmed.replace(/[.!?,;:。！？，；：\s]+$/u, "").toLowerCase();
	return CAPTION_ARTEFACTS.has(normalized) ? "" : trimmed;
}

export class LiveStreamingSession {
	readonly #options: LiveStreamingSessionOptions;
	readonly #sampleRate: number;
	readonly #minDecodeSamples: number;
	readonly #raw: Pcm16Audio;
	readonly #done = Promise.withResolvers<void>();
	#endpointer: LiveEndpointer | null = null;
	#endpointerLoad: Promise<void> | null = null;
	#earlyAudio: Float32Array[] = [];
	#flushed = false;
	#segmentQueue: DecodeWork[] = [];
	#pendingPartial: DecodeWork | null = null;
	#committed: string[] = [];
	#segmentIndex = 0;
	#pumping = false;
	#cancelled = false;
	#ended = false;

	constructor(options: LiveStreamingSessionOptions) {
		this.#options = options;
		this.#sampleRate = options.sampleRate ?? 16_000;
		this.#minDecodeSamples = Math.round((this.#sampleRate * (options.minDecodeMs ?? MIN_DECODE_MS)) / 1000);
		this.#raw = new Pcm16Audio(options.maxSamples ?? this.#sampleRate * STREAMING_MAX_SECONDS);
	}

	pushAudio(audio: Float32Array): void {
		if (!this.#active()) return;
		try {
			this.#raw.append(audio);
		} catch (error) {
			this.#fail(error);
			return;
		}
		if (this.#endpointer) {
			this.#ingest(this.#endpointer.push(audio));
			void this.#pump();
			return;
		}
		this.#earlyAudio.push(audio);
		this.#endpointerLoad ??= this.#options.createEndpointer().then(endpointer => {
			if (this.#cancelled) return;
			this.#endpointer = endpointer;
			for (const early of this.#earlyAudio) this.#ingest(endpointer.push(early));
			this.#earlyAudio = [];
			if (this.#ended) this.#flush(endpointer);
			void this.#pump();
		});
		void this.#endpointerLoad.catch(error => this.#fail(error));
	}

	pushUtterance(audio: Float32Array): void {
		if (!this.#active()) return;
		this.#pendingPartial = null;
		this.#segmentQueue.push({ start: 0, end: audio.length, audio });
		void this.#pump();
	}

	pushPreview(audio: Float32Array): void {
		if (!this.#active()) return;
		this.#pendingPartial = { start: 0, end: audio.length, audio, timed: false };
		void this.#pump();
	}

	stop(): Promise<void> {
		if (this.#cancelled) return this.#done.promise;
		this.#ended = true;
		this.#pendingPartial = null;
		if (this.#endpointer) this.#flush(this.#endpointer);
		else if (!this.#endpointerLoad) this.#flushed = true;
		void this.#pump();
		return this.#done.promise;
	}

	cancel(): void {
		this.#cancelled = true;
		this.#ended = true;
		this.#segmentQueue = [];
		this.#pendingPartial = null;
		this.#done.resolve();
	}

	#active(): boolean {
		return !this.#cancelled && !this.#ended;
	}

	#flush(endpointer: LiveEndpointer): void {
		if (this.#flushed) return;
		this.#ingest(endpointer.flush());
		this.#flushed = true;
	}

	#ingest(events: EndpointerEvent[]): void {
		for (const event of events) {
			const work = { start: event.start, end: event.end, timed: true };
			if (event.kind === "segment") this.#segmentQueue.push(work);
			else this.#pendingPartial = work;
		}
	}

	#audio(work: DecodeWork): Float32Array {
		const audio = work.audio ?? this.#raw.slice(work.start, work.end);
		if (audio.length >= this.#minDecodeSamples) return audio;
		const padded = new Float32Array(this.#minDecodeSamples);
		padded.set(audio);
		return padded;
	}

	async #pump(): Promise<void> {
		if (this.#pumping || this.#cancelled) return;
		this.#pumping = true;
		try {
			while (!this.#cancelled) {
				if (this.#segmentQueue.length > 0) {
					const work = this.#segmentQueue.shift()!;
					this.#pendingPartial = null;
					const decoded = await this.#options.decode(this.#audio(work), "segment");
					if (this.#cancelled) return;
					const text = filterFinalTranscript(decoded);
					this.#committed.push(text);
					this.#options.send({ type: "segment", id: this.#options.id, index: this.#segmentIndex++, text });
					continue;
				}
				if (this.#pendingPartial) {
					const work = this.#pendingPartial;
					this.#pendingPartial = null;
					const startedAt = performance.now();
					const decoded = await this.#options.decode(this.#audio(work), "partial");
					if (work.timed) this.#endpointer?.notePartialDecode(performance.now() - startedAt);
					if (this.#cancelled) return;
					const text = stripPreviewPunctuation(decoded.trim());
					if (text && this.#segmentQueue.length === 0) {
						this.#options.send({ type: "partial", id: this.#options.id, text });
					}
					continue;
				}
				break;
			}
			if (this.#ended && this.#flushed && !this.#cancelled && !this.#segmentQueue.length && !this.#pendingPartial) {
				this.#options.send({ type: "stream_done", id: this.#options.id, text: joinSegmentTexts(this.#committed) });
				this.#done.resolve();
			}
		} catch (error) {
			this.#fail(error);
		} finally {
			this.#pumping = false;
		}
	}

	#fail(error: unknown): void {
		if (this.#cancelled) return;
		this.#cancelled = true;
		this.#options.send({
			type: "error",
			id: this.#options.id,
			error: error instanceof Error ? error.message : String(error),
		});
		this.#done.resolve();
	}
}
