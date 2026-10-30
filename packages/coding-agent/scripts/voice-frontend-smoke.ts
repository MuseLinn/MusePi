import * as os from "node:os";
import * as path from "node:path";
import { sttClient } from "../src/stt/asr-client";
import { readWavClip } from "../src/stt/eval/corpus";
import { levenshteinRate, percentile } from "../src/stt/eval/metrics";
import { createVoiceFrontendClient, type VoiceFrontendClient } from "../src/voice/frontend/client";
import type { GateState, SpeakerMode } from "../src/voice/frontend/gate";

export interface VoiceFrontendSmokeMetrics {
	cpuCount: number;
	platform: string;
	frontendRtf: number;
	tailP95Ms: number;
	cleanRelativeCer: number;
	cleanRelativeWer: number;
	rssPeakBytes: number;
	nonTargetAutoSubmit: boolean;
	offEnhancementApplied: boolean;
	shortState: GateState;
	strictOtherState: GateState;
}

async function processClip(
	client: VoiceFrontendClient,
	samples: Float32Array,
	mode: SpeakerMode,
	enhanceAudio: boolean,
	enrollment: number[][],
) {
	const started = performance.now();
	const result = await client.process({
		audio: samples,
		sampleRate: 16_000,
		targetMs: (samples.length / 16_000) * 1000,
		speakerMode: mode,
		enhanceAudio,
		enrollment,
		acceptThreshold: 0.7,
		rejectThreshold: 0.5,
	});
	return { result, elapsedMs: performance.now() - started };
}

export async function runVoiceFrontendSmoke(corpusDir: string): Promise<VoiceFrontendSmokeMetrics> {
	const client = createVoiceFrontendClient();
	const rssStart = process.memoryUsage().rss;
	try {
		const [enroll1, enroll2, enroll3, enroll4, clean, noise, other, overlap] = await Promise.all([
			readWavClip(path.join(corpusDir, "enroll-1.wav")),
			readWavClip(path.join(corpusDir, "enroll-2.wav")),
			readWavClip(path.join(corpusDir, "enroll-3.wav")),
			readWavClip(path.join(corpusDir, "enroll-4.wav")),
			readWavClip(path.join(corpusDir, "clean.wav")),
			readWavClip(path.join(corpusDir, "noise.wav")),
			readWavClip(path.join(corpusDir, "other.wav")),
			readWavClip(path.join(corpusDir, "overlap.wav")),
		]);
		const enrollment = await Promise.all(
			[enroll1, enroll2, enroll3, enroll4].map(clip =>
				client.embed(clip.samples, 16_000).then(embedding => Array.from(embedding)),
			),
		);
		await processClip(client, clean.samples, "prefer", false, enrollment);
		const measured = await Promise.all(
			[clean, noise, other, overlap].map(clip => processClip(client, clip.samples, "prefer", false, enrollment)),
		);
		const audioSeconds = [clean, noise, other, overlap].reduce((sum, clip) => sum + clip.samples.length / 16_000, 0);
		const elapsedMs = measured.reduce((sum, item) => sum + item.elapsedMs, 0);
		const otherAutoSubmit = measured[2]!.result.state === "accept";
		const strictOther = await processClip(client, other.samples, "strict", false, enrollment);
		const short = await processClip(client, clean.samples.slice(0, 8_000), "prefer", false, enrollment);
		const cleanEnhanced = await processClip(client, clean.samples, "off", true, []);
		const noisySamples = clean.samples.map((sample, index) =>
			Math.max(-1, Math.min(1, sample + (((index * 16_807) % 65_536) / 32_768 - 1) * 0.15)),
		);
		const noisyEnhanced = await processClip(client, noisySamples, "off", true, []);
		const baselineText = await sttClient.transcribe("balanced", clean.samples);
		const enhancedText = await sttClient.transcribe("balanced", cleanEnhanced.result.audio);
		return {
			cpuCount: os.cpus().length,
			platform: `${os.platform()}/${os.arch()}`,
			frontendRtf: elapsedMs / 1000 / audioSeconds,
			tailP95Ms: percentile(
				measured.map(item => item.elapsedMs),
				0.95,
			),
			cleanRelativeCer: levenshteinRate(baselineText, enhancedText, "char"),
			cleanRelativeWer: levenshteinRate(baselineText, enhancedText, "word"),
			rssPeakBytes: Math.max(rssStart, process.memoryUsage().rss),
			nonTargetAutoSubmit: otherAutoSubmit || strictOther.result.state === "accept",
			offEnhancementApplied: noisyEnhanced.result.enhanced,
			shortState: short.result.state,
			strictOtherState: strictOther.result.state,
		};
	} finally {
		client.close();
		await sttClient.terminate();
	}
}

if (import.meta.main) {
	const corpusDir = process.argv[2];
	if (!corpusDir) throw new Error("Usage: voice-frontend-smoke.ts <corpus-dir>");
	const metrics = await runVoiceFrontendSmoke(corpusDir);
	console.log(JSON.stringify(metrics, null, 2));
}
