import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface AudioClip {
	samples: Float32Array;
	sampleRate: 16_000;
}

export type CorpusKind = "clean" | "noise" | "interferer" | "overlap";

export interface CorpusItem {
	id: string;
	kind: CorpusKind;
	mixturePath: string;
	enrollmentPaths: string[];
	transcript: string;
	targetMs: number;
}

const CORPUS_KINDS = new Set<CorpusKind>(["clean", "noise", "interferer", "overlap"]);

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0)
		throw new Error(`Corpus ${field} must be a non-empty string`);
	return value;
}

function parseItem(value: unknown, line: number): CorpusItem {
	if (typeof value !== "object" || value === null) throw new Error(`Corpus line ${line} must be an object`);
	const row = value as Record<string, unknown>;
	const kind = requiredString(row.kind, "kind") as CorpusKind;
	if (!CORPUS_KINDS.has(kind)) throw new Error(`Corpus line ${line} has unknown kind ${kind}`);
	const targetMs = row.targetMs;
	if (typeof targetMs !== "number" || !Number.isFinite(targetMs) || targetMs < 0) {
		throw new Error(`Corpus line ${line} targetMs must be a non-negative number`);
	}
	if (kind === "interferer" && targetMs !== 0)
		throw new Error(`Interferer-only item targetMs must be 0 at line ${line}`);
	if (kind !== "interferer" && targetMs === 0)
		throw new Error(`Target item targetMs must be positive at line ${line}`);
	if (!Array.isArray(row.enrollmentPaths) || row.enrollmentPaths.length === 0) {
		throw new Error(`Corpus line ${line} enrollmentPaths must not be empty`);
	}
	return {
		id: requiredString(row.id, "id"),
		kind,
		mixturePath: requiredString(row.mixturePath, "mixturePath"),
		enrollmentPaths: row.enrollmentPaths.map((entry, index) => requiredString(entry, `enrollmentPaths[${index}]`)),
		transcript: typeof row.transcript === "string" ? row.transcript : requiredString(row.transcript, "transcript"),
		targetMs,
	};
}

export async function readWavClip(filePath: string): Promise<AudioClip> {
	const bytes = await fs.readFile(filePath);
	if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error(`Invalid WAV file ${filePath}`);
	}
	if (bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1 || bytes.readUInt16LE(34) !== 16) {
		throw new Error(`WAV must be mono PCM16: ${filePath}`);
	}
	const sampleRate = bytes.readUInt32LE(24);
	if (sampleRate !== 16_000) throw new Error(`WAV sample rate must be 16000 Hz: ${filePath}`);
	const dataBytes = Math.min(bytes.readUInt32LE(40), bytes.length - 44);
	const samples = new Float32Array(Math.floor(dataBytes / 2));
	for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(44 + i * 2) / 32_768;
	return { samples, sampleRate };
}

export async function loadCorpusManifest(manifestPath: string): Promise<CorpusItem[]> {
	const text = await Bun.file(manifestPath).text();
	const items: CorpusItem[] = [];
	const ids = new Set<string>();
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error(`Invalid corpus JSON at line ${index + 1}`);
		}
		const item = parseItem(value, index + 1);
		if (ids.has(item.id)) throw new Error(`Corpus contains duplicate id ${item.id}`);
		ids.add(item.id);
		items.push(item);
	}
	if (items.length === 0) throw new Error("Corpus manifest is empty");
	const root = path.dirname(manifestPath);
	for (const item of items) {
		item.mixturePath = path.resolve(root, item.mixturePath);
		item.enrollmentPaths = item.enrollmentPaths.map(entry => path.resolve(root, entry));
		for (const audioPath of [item.mixturePath, ...item.enrollmentPaths]) await readWavClip(audioPath);
	}
	return items;
}
