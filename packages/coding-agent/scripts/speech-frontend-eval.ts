import * as os from "node:os";
import * as path from "node:path";
import { sttClient } from "../src/stt/asr-client";
import { validateCandidateAudio } from "../src/stt/eval/audio-validation";
import { type AudioClip, type CorpusItem, loadCorpusManifest, readWavClip } from "../src/stt/eval/corpus";
import { createExternalCandidate } from "../src/stt/eval/external-candidate";
import { decideGate, type GateDecision } from "../src/stt/eval/gate";
import { levenshteinRate } from "../src/stt/eval/metrics";
import {
	type BenchmarkRow,
	benchmarkAcceptanceFailures,
	mergeBenchmarkRows,
	summarizeBenchmark,
} from "../src/stt/eval/report";
import {
	cosineSimilarity,
	createSherpaSpeakerVerifier,
	ensureSpeakerEmbeddingModel,
	type SpeakerVerifier,
} from "../src/stt/eval/speaker-verifier";
import { isSttModelKey, type SttModelKey } from "../src/stt/models";
import { installSherpaRuntime } from "../src/stt/sherpa-runtime";

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name: string): string {
	const value = argument(name);
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function requiredNumber(name: string): number {
	const value = Number(requiredArgument(name));
	if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
	return value;
}

async function enrollmentCentroid(verifier: SpeakerVerifier, audioPaths: string[]): Promise<Float32Array> {
	const embeddings = [];
	for (const audioPath of audioPaths) embeddings.push(await verifier.embed(await readWavClip(audioPath)));
	const centroid = new Float32Array(embeddings[0]?.length ?? 0);
	for (const embedding of embeddings) {
		for (let i = 0; i < centroid.length; i++) centroid[i] += embedding[i]! / embeddings.length;
	}
	return centroid;
}

async function createVerifier(modelPath: string | undefined): Promise<SpeakerVerifier> {
	const resolvedModel = modelPath ?? (await ensureSpeakerEmbeddingModel());
	const runtime = await installSherpaRuntime(() => {});
	return createSherpaSpeakerVerifier({ runtime, modelPath: resolvedModel, numThreads: 2 });
}

async function verifyOnly(corpusPath: string, modelPath: string | undefined): Promise<void> {
	const corpus = await loadCorpusManifest(corpusPath);
	const verifier = await createVerifier(modelPath);
	try {
		for (const item of corpus) {
			const centroid = await enrollmentCentroid(verifier, item.enrollmentPaths);
			const score = cosineSimilarity(centroid, await verifier.embed(await readWavClip(item.mixturePath)));
			console.log(JSON.stringify({ id: item.id, score }));
		}
	} finally {
		await verifier.close();
	}
}

function errorRates(item: CorpusItem, transcript: string | null): { cer: number | null; wer: number | null } {
	if (transcript === null || !item.transcript.trim()) return { cer: null, wer: null };
	return {
		cer: levenshteinRate(item.transcript, transcript, "char"),
		wer: levenshteinRate(item.transcript, transcript, "word"),
	};
}

function baselineRow(item: CorpusItem, audioMs: number, transcript: string): BenchmarkRow {
	return {
		itemId: item.id,
		kind: item.kind,
		candidate: "passthrough",
		gate: { state: "accept", score: null, autoSubmit: true },
		...errorRates(item, transcript),
		audioMs,
		endpointMs: 0,
		loadMs: 0,
		inferenceMs: 0,
		rssBytes: 0,
	};
}

function relativeKindChange(rows: BenchmarkRow[], kind: CorpusItem["kind"]): number | null {
	const changes: number[] = [];
	for (const row of rows.filter(entry => entry.kind === kind && entry.candidate !== "passthrough")) {
		const baseline = rows.find(entry => entry.itemId === row.itemId && entry.candidate === "passthrough");
		if (!baseline) continue;
		for (const metric of ["cer", "wer"] as const) {
			const actual = row[metric];
			const expected = baseline[metric];
			if (actual !== null && expected !== null && expected > 0) changes.push((actual - expected) / expected);
		}
	}
	return changes.length > 0 ? changes.reduce((sum, value) => sum + value, 0) / changes.length : null;
}

async function transcribe(modelKey: SttModelKey, clip: AudioClip, language: string | undefined): Promise<string> {
	return sttClient.transcribe(modelKey, clip.samples, { language });
}

async function runBenchmark(corpusPath: string, outputPath: string): Promise<void> {
	const candidateId = requiredArgument("--candidate");
	const acceptThreshold = requiredNumber("--accept-threshold");
	const rejectThreshold = requiredNumber("--reject-threshold");
	const modelKeyArgument = argument("--stt-model") ?? "balanced";
	if (!isSttModelKey(modelKeyArgument)) throw new Error(`Unknown STT model ${modelKeyArgument}`);
	const modelKey = modelKeyArgument;
	const language = argument("--language");
	const workDir = path.resolve(argument("--work-dir") ?? ".tmp/speech-frontend-eval");
	const corpus = await loadCorpusManifest(corpusPath);
	for (const kind of ["clean", "noise", "interferer", "overlap"] as const) {
		if (!corpus.some(item => item.kind === kind)) throw new Error(`Corpus is missing required kind ${kind}`);
	}
	const candidate = createExternalCandidate({
		implementation: candidateId,
		python: argument("--python") ?? "python",
		workDir,
	});
	const verifier = await createVerifier(argument("--speaker-model"));
	const rows: BenchmarkRow[] = [];
	let candidateLoadMs = 0;
	try {
		const startedAt = performance.now();
		await candidate.prepare();
		const centroid = await enrollmentCentroid(verifier, corpus[0]!.enrollmentPaths);
		candidateLoadMs = performance.now() - startedAt;
		for (const item of corpus) {
			const original = await readWavClip(item.mixturePath);
			const audioMs = (original.samples.length / original.sampleRate) * 1000;
			rows.push(baselineRow(item, audioMs, await transcribe(modelKey, original, language)));
			const endpointStarted = performance.now();
			const extracted = await candidate.extract({
				id: item.id,
				mixturePath: item.mixturePath,
				enrollmentPaths: item.enrollmentPaths,
			});
			const processed = await validateCandidateAudio(extracted, {
				sampleRate: 16_000,
				durationMs: audioMs,
				maxDurationDeltaMs: 100,
			});
			let gate: GateDecision;
			if (processed === null) {
				gate = decideGate({ targetMs: 0, score: null, acceptThreshold, rejectThreshold });
			} else {
				const score = cosineSimilarity(centroid, await verifier.embed(processed));
				gate = decideGate({ targetMs: item.targetMs, score, acceptThreshold, rejectThreshold });
			}
			const frontendMs = performance.now() - endpointStarted;
			const endpointMs = extracted.endpointMs ?? frontendMs;
			const transcript =
				gate.state === "accept" && processed !== null ? await transcribe(modelKey, processed, language) : null;
			rows.push({
				itemId: item.id,
				kind: item.kind,
				candidate: candidateId,
				gate,
				...errorRates(item, transcript),
				audioMs,
				endpointMs,
				loadMs: candidateLoadMs,
				inferenceMs: frontendMs,
				rssBytes: extracted.rssBytes,
			});
		}
	} finally {
		await candidate.close();
		await verifier.close();
		await sttClient.terminate();
	}
	const summary = summarizeBenchmark(rows);
	const candidateRows = rows.filter(row => row.candidate !== "passthrough");
	const nonTargetAutoSubmits = candidateRows.filter(row => row.kind === "interferer" && row.gate.autoSubmit).length;
	const baselineNonTargetAutoSubmits = rows.filter(
		row => row.kind === "interferer" && row.candidate === "passthrough" && row.gate.autoSubmit,
	).length;
	const noiseChange = relativeKindChange(rows, "noise");
	const overlapChange = relativeKindChange(rows, "overlap");
	const failures = benchmarkAcceptanceFailures({
		summary,
		nonTargetAutoSubmits,
		noiseChange,
		overlapChange,
		maxRssBytes: Math.max(...candidateRows.map(row => row.rssBytes)),
	});
	let existing: BenchmarkRow[] = [];
	try {
		const previous = JSON.parse(await Bun.file(outputPath).text()) as { rows?: BenchmarkRow[] };
		existing = previous.rows ?? [];
	} catch {}
	const report = {
		environment: {
			cpu: os.cpus()[0]?.model ?? "unknown",
			logicalCores: os.cpus().length,
			totalMemoryBytes: os.totalmem(),
			platform: os.platform(),
			arch: os.arch(),
		},
		candidate: candidateId,
		sttModel: modelKey,
		acceptThreshold,
		rejectThreshold,
		summary: { ...summary, nonTargetAutoSubmits, baselineNonTargetAutoSubmits, noiseChange, overlapChange },
		failures,
		rows: mergeBenchmarkRows(existing, candidateId, rows),
	};
	await Bun.write(outputPath, `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify({ output: outputPath, summary: report.summary, failures }));
	if (failures.length > 0) process.exitCode = 1;
}

if (process.argv.includes("--verify-only")) {
	await verifyOnly(requiredArgument("--corpus"), argument("--speaker-model"));
} else {
	await runBenchmark(requiredArgument("--corpus"), requiredArgument("--output"));
}
