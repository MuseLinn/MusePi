import { cosineSimilarity } from "../../stt/eval/speaker-verifier";
import type {
	SherpaOnlineDenoiser,
	SherpaRuntime,
	SherpaSpeakerEmbeddingExtractor,
	SherpaVad,
} from "../../stt/sherpa-runtime";
import { installSherpaRuntime } from "../../stt/sherpa-runtime";
import { decideSpeakerGate, shouldEnhanceAudio } from "./gate";
import { ensureVoiceFrontendModel } from "./models";
import type { FrontendProcessInput, VoiceFrontendWorkerInbound, VoiceFrontendWorkerOutbound } from "./protocol";

let runtimePromise: Promise<SherpaRuntime> | null = null;
let vadPromise: Promise<SherpaVad> | null = null;
let denoiserPromise: Promise<SherpaOnlineDenoiser> | null = null;
let speakerPromise: Promise<SherpaSpeakerEmbeddingExtractor> | null = null;

function runtime(): Promise<SherpaRuntime> {
	runtimePromise ??= installSherpaRuntime(() => {});
	return runtimePromise;
}

function vad(): Promise<SherpaVad> {
	vadPromise ??= (async () => {
		const [sherpa, model] = await Promise.all([runtime(), ensureVoiceFrontendModel("sileroVad")]);
		return new sherpa.Vad(
			{
				sileroVad: {
					model,
					threshold: 0.5,
					minSpeechDuration: 0.2,
					minSilenceDuration: 0.5,
					windowSize: 512,
				},
				sampleRate: 16_000,
				numThreads: 1,
				debug: 0,
				provider: "cpu",
			},
			30,
		);
	})();
	return vadPromise;
}

function denoiser(): Promise<SherpaOnlineDenoiser> {
	denoiserPromise ??= (async () => {
		const [sherpa, model] = await Promise.all([runtime(), ensureVoiceFrontendModel("dpdfnet")]);
		return new sherpa.OnlineSpeechDenoiser({
			model: { dpdfnet: { model }, numThreads: 1, debug: 0, provider: "cpu" },
		});
	})();
	return denoiserPromise;
}

function speakerExtractor(): Promise<SherpaSpeakerEmbeddingExtractor> {
	speakerPromise ??= (async () => {
		const [sherpa, model] = await Promise.all([runtime(), ensureVoiceFrontendModel("speakerEmbedding")]);
		return new sherpa.SpeakerEmbeddingExtractor({ model, numThreads: 2, debug: 0, provider: "cpu" });
	})();
	return speakerPromise;
}

async function embed(audio: Float32Array, sampleRate: 16_000): Promise<Float32Array> {
	const extractor = await speakerExtractor();
	const stream = extractor.createStream();
	stream.acceptWaveform({ samples: audio, sampleRate });
	stream.inputFinished();
	for (let i = 0; i < 1000 && !extractor.isReady(stream); i++) {}
	if (!extractor.isReady(stream)) throw new Error("Speaker embedding extractor did not become ready");
	const embedding = extractor.compute(stream);
	let sum = 0;
	for (const value of embedding) sum += value * value;
	const norm = Math.sqrt(sum);
	if (!(norm > 0)) throw new Error("Speaker embedding has zero norm");
	return embedding.map(value => value / norm);
}

function centroid(enrollment: number[][]): Float32Array {
	if (enrollment.length === 0) return new Float32Array();
	const vectors = enrollment.map(embedding => Float32Array.from(embedding));
	const result = new Float32Array(vectors[0]!.length);
	for (const embedding of vectors) {
		for (let i = 0; i < result.length; i++) result[i] += embedding[i]! / vectors.length;
	}
	return result;
}

async function process(input: FrontendProcessInput): Promise<{
	segmentId: number;
	audio: Float32Array;
	state: "accept" | "uncertain" | "reject";
	score: number | null;
	enhanced: boolean;
}> {
	if (input.speakerMode === "off" && !input.enhanceAudio) {
		return { segmentId: 0, audio: input.audio, state: "accept", score: null, enhanced: false };
	}
	const detector = await vad();
	detector.reset();
	detector.acceptWaveform(input.audio);
	detector.flush();
	const segments: Float32Array[] = [];
	let enhanced = false;
	if (!detector.isEmpty()) {
		if (!input.enhanceAudio || !shouldEnhanceAudio(input.audio)) segments.push(input.audio);
		else {
			try {
				const denoised = await denoiser();
				const output = denoised.run({ samples: input.audio, sampleRate: input.sampleRate });
				segments.push(output.samples);
				denoised.flush();
				denoised.reset();
				enhanced = true;
			} catch {
				segments.push(input.audio);
			}
		}
	}
	const total = segments.reduce((sum, samples) => sum + samples.length, 0);
	const audio = new Float32Array(total);
	let offset = 0;
	for (const samples of segments) {
		audio.set(samples, offset);
		offset += samples.length;
	}
	let score: number | null = null;
	if (audio.length > 0 && input.enrollment.length > 0) {
		const center = centroid(input.enrollment);
		const processed = await embed(audio.length > 48_000 ? audio.slice(0, 48_000) : audio, input.sampleRate);
		if (center.length !== processed.length) {
			throw new Error(
				`Speaker embedding dimensions differ: enrollment ${center.length}, processed ${processed.length}`,
			);
		}
		score = cosineSimilarity(center, processed);
	}
	const gate = decideSpeakerGate({
		targetMs: input.targetMs,
		score,
		acceptThreshold: input.acceptThreshold,
		rejectThreshold: input.rejectThreshold,
	});
	return { segmentId: 0, audio, state: gate.state, score: gate.score, enhanced };
}

export function startVoiceFrontendWorker(transport: {
	send(message: VoiceFrontendWorkerOutbound): void;
	onMessage(handler: (message: VoiceFrontendWorkerInbound) => void): () => void;
}): void {
	transport.onMessage(message => {
		void handle(message, transport);
	});
}

async function handle(
	message: VoiceFrontendWorkerInbound,
	transport: { send(message: VoiceFrontendWorkerOutbound): void },
): Promise<void> {
	try {
		if (message.type === "ping") {
			transport.send({ type: "pong", id: message.id });
			return;
		}
		if (message.type === "embed") {
			transport.send({
				type: "embedding",
				id: message.id,
				embedding: await embed(message.audio, message.sampleRate),
			});
			return;
		}
		transport.send({ type: "result", id: message.id, ...(await process(message)) });
	} catch (error) {
		transport.send({ type: "error", id: message.id, error: error instanceof Error ? error.message : String(error) });
	}
}
