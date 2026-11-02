/** Voice catalogs projected from Cordis component activation. An unloaded
 * engine disappears from model selection, download, transcription, and speech
 * synthesis without a second settings-based enablement state. */
import { STT_MODELS, type SttModel } from "../stt/models";
import { TTS_LOCAL_MODELS, type TtsLocalModelSpec } from "../tts/models";
import { isSttEngineActive, isTtsEngineActive } from "./engine-registry";

export type VoiceChannel = "stt" | "tts";

const STT_ENGINE_BY_KEY: Record<string, string> = {
	fast: "whisper",
	balanced: "whisper",
	turbo: "whisper",
	sensevoice: "sensevoice",
	parakeet: "parakeet",
};

export function ttsEngineComponentId(modelKey: string): string {
	return modelKey;
}

export function sttEngineComponentId(modelKey: string): string {
	return STT_ENGINE_BY_KEY[modelKey] ?? modelKey;
}

export function isVoiceEngineDisabled(channel: VoiceChannel, componentId: string): boolean {
	return channel === "stt" ? !isSttEngineActive(componentId) : !isTtsEngineActive(componentId);
}

export function enabledSttModels(): SttModel[] {
	return STT_MODELS.filter(model => isSttEngineActive(sttEngineComponentId(model.key)));
}

export function enabledTtsModels(): TtsLocalModelSpec[] {
	return TTS_LOCAL_MODELS.filter(model => isTtsEngineActive(ttsEngineComponentId(model.key)));
}

export function resolveEnabledSttModel(key: string | undefined): SttModel {
	const enabled = enabledSttModels();
	const preferred = enabled.find(model => model.key === (key ?? "balanced")) ?? enabled[0];
	if (!preferred) throw new Error("No STT model enabled (all engine components disabled)");
	return preferred;
}

export function resolveEnabledTtsModel(key: string | undefined): TtsLocalModelSpec {
	const enabled = enabledTtsModels();
	const preferred = enabled.find(model => model.key === key) ?? enabled[0];
	if (!preferred) throw new Error("No local TTS model enabled (all engine components disabled)");
	return preferred;
}
