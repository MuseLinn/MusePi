import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTinyModelsCacheDir } from "@musepi/pi-utils";

export const VOICE_FRONTEND_MODEL_FILES = {
	sileroVad: "silero_vad.onnx",
	dpdfnet: "dpdfnet2.onnx",
	speakerEmbedding: "3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx",
} as const;

export const VOICE_FRONTEND_MODEL_URLS = {
	sileroVad: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
	dpdfnet: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/dpdfnet2.onnx",
	speakerEmbedding:
		"https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx",
} as const;

export type VoiceFrontendModelKind = keyof typeof VOICE_FRONTEND_MODEL_FILES;

export async function ensureVoiceFrontendModel(kind: VoiceFrontendModelKind): Promise<string> {
	const destination = path.join(getTinyModelsCacheDir(), "voice-frontend", VOICE_FRONTEND_MODEL_FILES[kind]);
	try {
		const stat = await fs.stat(destination);
		if (stat.size > 0) return destination;
	} catch {}
	const response = await fetch(VOICE_FRONTEND_MODEL_URLS[kind]);
	if (!response.ok) throw new Error(`Failed to download voice frontend model ${kind}: HTTP ${response.status}`);
	const partial = `${destination}.part`;
	await Bun.write(partial, await response.arrayBuffer());
	await fs.rename(partial, destination);
	return destination;
}
