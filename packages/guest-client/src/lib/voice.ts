/**
 * Voice input for the mobile composer (design frames 「语音入口/录音中/转写回填」).
 *
 * The heavy lifting is host-side: the daemon exposes `stt.transcribe` (the same
 * sherpa-ONNX stack the TUI uses), so the client only captures microphone audio
 * as 16 kHz mono floats and ships them over the existing RPC channel. No on-device
 * model, no network beyond the session transport.
 *
 * Capture notes:
 * - `AudioContext({ sampleRate: 16000 })` is honored by Chromium/WebKit on the
 *   platforms the guest client targets; when a engine ignores it we resample
 *   linearly from the context's actual rate before returning.
 * - ScriptProcessor is deprecated but universally supported and sufficient for a
 *   push-to-talk capture; AudioWorklet would need a separate module asset.
 * - collab-direct guests have no `stt.*` RPC — the caller maps the rejected
 *   promise to the guide state instead of spinning forever.
 */

/** 16 kHz mono — the format `stt.transcribe` expects. */
const TARGET_RATE = 16_000;

export type VoicePhase = "idle" | "recording" | "transcribing";

/** A live microphone capture. `stop()` resolves the recorded floats; `abort()` discards. */
export interface VoiceCapture {
	stop(): Promise<Float32Array>;
	abort(): void;
}

/** Open the mic and start buffering 16 kHz mono samples. Throws on denied/missing mic. */
export async function startVoiceCapture(): Promise<VoiceCapture> {
	if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
		throw new Error("microphone unavailable in this context");
	}
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
	});
	const Ctor = window.AudioContext;
	const ctx = new Ctor({ sampleRate: TARGET_RATE });
	const source = ctx.createMediaStreamSource(stream);
	const chunks: Float32Array[] = [];
	const processor = ctx.createScriptProcessor(4096, 1, 1);
	processor.onaudioprocess = e => {
		chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
	};
	// The processor only pulls when connected to a destination; a zero-gain node
	// keeps the graph alive without feeding audio back to the speaker.
	const sink = ctx.createGain();
	sink.gain.value = 0;
	source.connect(processor);
	processor.connect(sink);
	sink.connect(ctx.destination);
	await ctx.resume();

	const teardown = (): void => {
		processor.onaudioprocess = null;
		source.disconnect();
		processor.disconnect();
		sink.disconnect();
		for (const track of stream.getTracks()) track.stop();
		void ctx.close();
	};

	return {
		async stop(): Promise<Float32Array> {
			teardown();
			return Promise.resolve(resample(concat(chunks), ctx.sampleRate));
		},
		abort(): void {
			teardown();
		},
	};
}

/** Transcribe recorded floats through the daemon's local ASR stack.
 *  `language` (BCP 47 hint) rides through to the worker like the desktop's
 *  startDictationOpts; undefined lets the daemon auto-detect.
 *
 *  Payload is quantised exactly like the desktop's `quantiseForWire` (#23 C):
 *  float JSON prints ~20 bytes/sample, so a raw minute of 16 kHz audio would
 *  be ~115 MB — 5 decimals (~8 bytes/sample, inaudible for 16-bit ASR) keeps
 *  long recordings comfortably inside the daemon's 16 MiB request cap. */
export async function transcribeAudio(
	client: { rpc<T>(method: string, params?: unknown): Promise<T> },
	audio: Float32Array,
	language?: string,
): Promise<string> {
	const res = await client.rpc<{ text: string }>("stt.transcribe", {
		audio: Array.from(audio, v => Math.round(v * 1e5) / 1e5),
		...(language ? { language } : {}),
	});
	return res?.text ?? "";
}

function concat(chunks: Float32Array[]): Float32Array {
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Float32Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

/** Linear-interpolation downsample to {@link TARGET_RATE}; no-op when already 16 kHz. */
function resample(input: Float32Array, fromRate: number): Float32Array {
	if (fromRate === TARGET_RATE || input.length === 0) return input;
	const ratio = fromRate / TARGET_RATE;
	const outLen = Math.floor(input.length / ratio);
	const out = new Float32Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const pos = i * ratio;
		const left = Math.floor(pos);
		const right = Math.min(left + 1, input.length - 1);
		const frac = pos - left;
		out[i] = input[left]! * (1 - frac) + input[right]! * frac;
	}
	return out;
}
