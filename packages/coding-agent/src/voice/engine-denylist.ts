/**
 * 语音引擎级黑名单（插件「包含的组件」的 voice 通道落地）。组件开关写
 * 隐藏设置键 `voice.disabledEngines`（组件 id 形如 "stt:whisper" /
 * "tts:kokoro"），本模块是唯一读取方：模型状态列表、下载入口、实际
 * 转写/合成路径都经这里过滤——被禁用的引擎对 GUI 与 agent 同时消失，
 * 不是纯展示层。与 tools.disabled（工具组件通道）同哲学、正交存储。
 */
import { settings } from "../config/settings";
import { STT_MODELS, type SttModel } from "../stt/models";
import { TTS_LOCAL_MODELS, type TtsLocalModelSpec } from "../tts/models";

export type VoiceChannel = "stt" | "tts";

/** STT 模型 → 引擎组件 id（fast/balanced/turbo 同属 Whisper/transformers 一家）。 */
const STT_ENGINE_BY_KEY: Record<string, string> = {
	fast: "whisper",
	balanced: "whisper",
	turbo: "whisper",
	sensevoice: "sensevoice",
	parakeet: "parakeet",
};

/** TTS 模型 key 即引擎组件 id（每个本地模型自成组件）。 */
export function ttsEngineComponentId(modelKey: string): string {
	return modelKey;
}

export function sttEngineComponentId(modelKey: string): string {
	return STT_ENGINE_BY_KEY[modelKey] ?? modelKey;
}

function denyKey(channel: VoiceChannel, componentId: string): string {
	return `${channel}:${componentId}`;
}

/** 读黑名单（fail-soft：坏值/非数组/设置未初始化 = 空集）。 */
export function readDisabledVoiceEngines(source: { get(key: string): unknown } = settings): Set<string> {
	let raw: unknown;
	try {
		raw = source.get("voice.disabledEngines");
	} catch {
		return new Set();
	}
	if (!Array.isArray(raw)) return new Set();
	return new Set(raw.filter((item): item is string => typeof item === "string"));
}

export function isVoiceEngineDisabled(
	channel: VoiceChannel,
	componentId: string,
	source: { get(key: string): unknown } = settings,
): boolean {
	return readDisabledVoiceEngines(source).has(denyKey(channel, componentId));
}

/** STT：黑名单过滤后的可用模型表（状态列表/下载入口用）。 */
export function enabledSttModels(source: { get(key: string): unknown } = settings): SttModel[] {
	const denied = readDisabledVoiceEngines(source);
	return STT_MODELS.filter(m => !denied.has(denyKey("stt", sttEngineComponentId(m.key))));
}

/** TTS：黑名单过滤后的可用本地模型表。 */
export function enabledTtsModels(source: { get(key: string): unknown } = settings): TtsLocalModelSpec[] {
	const denied = readDisabledVoiceEngines(source);
	return TTS_LOCAL_MODELS.filter(m => !denied.has(denyKey("tts", ttsEngineComponentId(m.key))));
}

/** STT：解析用户选择，被禁用的引擎回退到第一个可用模型（与
 *  resolveSttModelSpec 对未知 key 的回退同哲学）；全部禁用时回退默认。 */
export function resolveEnabledSttModel(
	key: string | undefined,
	source: { get(key: string): unknown } = settings,
): SttModel {
	const enabled = enabledSttModels(source);
	const preferredKey = key ?? "balanced";
	return enabled.find(m => m.key === preferredKey) ?? enabled[0] ?? STT_MODELS.find(m => m.key === "balanced")!;
}

/** TTS：同上——被禁用的选择回退到第一个可用模型。 */
export function resolveEnabledTtsModel(
	key: string | undefined,
	source: { get(key: string): unknown } = settings,
): TtsLocalModelSpec {
	const enabled = enabledTtsModels(source);
	const preferred = enabled.find(m => m.key === key) ?? enabled[0];
	if (!preferred) throw new Error("No local TTS model enabled (all engine components disabled)");
	return preferred;
}
