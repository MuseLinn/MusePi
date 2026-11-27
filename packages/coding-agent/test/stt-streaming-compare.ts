import * as path from "node:path";
import { shutdownSttClient, sttClient } from "../src/stt/asr-client";
import { joinSegmentTexts } from "../src/stt/asr-worker";
import { readWavClip } from "../src/stt/eval/corpus";
import { levenshteinRate } from "../src/stt/eval/metrics";
import type { SttModelKey } from "../src/stt/models";

interface ComparisonInput {
	id: string;
	file: string;
	reference: string;
}

interface ComparisonResult extends ComparisonInput {
	durationSeconds: number;
	whole: string;
	streamed: string;
	redecoded: string;
	streamedCer: number;
	redecodedCer: number;
	streamedContentCer: number;
	redecodedContentCer: number;
	wholePunctuation: string;
	streamedPunctuation: string;
	redecodedPunctuation: string;
}

function content(text: string): string {
	return text.replace(/[\s\p{P}\p{S}]/gu, "");
}

function punctuation(text: string): string {
	return Array.from(text.matchAll(/[\p{P}\p{S}]/gu), match => match[0]).join("");
}

function cer(reference: string, actual: string, stripPunctuation = false): number {
	const expected = stripPunctuation ? content(reference) : reference;
	const observed = stripPunctuation ? content(actual) : actual;
	if (!expected) return 0;
	return levenshteinRate(expected, observed || " ", "char");
}

async function compare(item: ComparisonInput, root: string, modelKey: SttModelKey): Promise<ComparisonResult> {
	const { samples } = await readWavClip(path.resolve(root, item.file));
	const whole = await sttClient.transcribe(modelKey, samples, { language: "zh" });
	const segments: string[] = [];
	const stream = sttClient.startStream(modelKey, {
		language: "zh",
		onSegment: text => segments.push(text),
	});
	for (let offset = 0; offset < samples.length; offset += 1_600) {
		stream.pushAudio(samples.slice(offset, Math.min(samples.length, offset + 1_600)));
	}
	const redecoded = await stream.stop();
	const streamed = joinSegmentTexts(segments);
	return {
		...item,
		durationSeconds: samples.length / 16_000,
		whole,
		streamed,
		redecoded,
		streamedCer: cer(whole, streamed),
		redecodedCer: cer(whole, redecoded),
		streamedContentCer: cer(whole, streamed, true),
		redecodedContentCer: cer(whole, redecoded, true),
		wholePunctuation: punctuation(whole),
		streamedPunctuation: punctuation(streamed),
		redecodedPunctuation: punctuation(redecoded),
	};
}

const manifestPath = process.argv[2];
if (!manifestPath) {
	throw new Error("Usage: bun test/stt-streaming-compare.ts MANIFEST.json [MODEL_KEY]");
}
const modelKey = (process.argv[3] ?? "sensevoice") as SttModelKey;
const root = path.dirname(path.resolve(manifestPath));
const inputs = (await Bun.file(manifestPath).json()) as ComparisonInput[];
const results: ComparisonResult[] = [];
try {
	for (const input of inputs) {
		const result = await compare(input, root, modelKey);
		results.push(result);
		console.log(JSON.stringify(result, null, 2));
	}
	const outputPath = path.join(root, "comparison-results.json");
	await Bun.write(outputPath, `${JSON.stringify(results, null, 2)}\n`);
	console.log(`Wrote ${outputPath}`);
} finally {
	await shutdownSttClient();
}
