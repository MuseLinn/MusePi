/**
 * Settings → 语音 strings contributed by the desktop shell. The core
 * translation map lives in client-core (a frozen dependency of this
 * package), so new voice-settings copy registers here at module load via
 * `registerTranslations` — the same runtime seam plugins use. Keys are the
 * English source sentences; the zh-CN overlay maps them to Chinese and the
 * en-US overlay pins the source so both locales resolve identically to the
 * core map's contract (a missing en entry would still fall back to the key,
 * the registration just makes it explicit).
 *
 * Import this file for side effects from the voice settings section.
 */
import { registerTranslations } from "@musepi/client-core";

const zhVoice = {
	"speech recognition model": "语音识别模型",
	"speech synthesis model": "朗读模型",
	"Lightweight and fast — best for quick English notes": "极速轻量，英文速记首选",
	"Balanced default — multilingual, Chinese included": "均衡默认，多语言含中文",
	"Widest language coverage — larger download, slower": "99 种语言覆盖最广，体积更大、速度较慢",
	"Top accuracy for English & European speech — no Chinese": "英文/欧语准确率天花板，但不支持中文",
	"Chinese-optimized — Mandarin, Cantonese & mixed zh/en": "中文优化：普通话、粤语、中英混说都准",
	"SoTA English & code narration — no Chinese": "英文/代码朗读天花板，不支持中文",
	"Mandarin narration with mixed zh/en": "普通话朗读，中英混合",
	Lightweight: "轻量",
	"Multilingual · default": "多语言 · 默认",
	"99 languages": "99 语言",
	"SoTA · EN/EU only": "SoTA · 英文/欧语",
	"Chinese-optimized · zh/en": "中文优化 · 中英混合",
	"English-first": "英文优先",
	Chinese: "中文",
	"downloads automatically when selected": "选中后自动下载",
	voice: "音色",
	"voice settings": "语音",
	"Listening… speak now": "聆听中…请说话",
	"voice test preview": "语音测试",
	"Test dictation and read-aloud in the simulated conversation below: press the mic in the input and speak — the transcript lands as a user message; press the read-aloud button on the reply to hear voice output.":
		"在下方模拟会话中测试：点击输入框上的麦克风说话，转写结果会作为用户消息出现在预览里；点击回复旁的朗读按钮试听语音输出。",
	// ── 插件详情弹层（voice:stt / voice:tts 单元）字段与组件文案：键即
	//    builtin-registry 声明的英文原文/label,ConfigFormRenderer 与组件
	//    段经 t() 解析,与设置页语音分区同一套译文。──
	"Recognition model": "识别模型",
	"Recognition language hint": "识别语言提示",
	"End-of-speech pause (ms)": "停顿判定（毫秒）",
	"Submit trigger": "提交触发",
	"Read-aloud model": "朗读模型",
	Voice: "音色",
	"Playback rate": "朗读速率",
	"Content preparation": "朗读内容",
	"Auto read new replies": "自动朗读新回复",
	"Recognition language hint; empty = auto-detect (recommended for mixed zh/en).":
		"识别语言提示；留空 = 自动检测（中英混合推荐留空）。",
	"How long of a pause counts as the end of dictation (milliseconds).": "多长的停顿算说话结束（毫秒）。",
	"When dictation auto-submits: never / on release (2+ words) / release with complete sentence / say-submit.":
		"语音听写何时自动提交：手动 / 松开时（2 词以上）/ 完整句子后 / 说「submit」。",
	"On-device speech model: Whisper small (default, multilingual, Chinese-ready), SenseVoiceSmall (zh/yue-optimized, INT8), Parakeet v3 (English/European top tier, no Chinese).":
		"端侧语音识别模型：Whisper small（默认，多语言含中文）、SenseVoiceSmall（中文/粤优化，INT8）、Parakeet v3（英文/欧语顶级，不支持中文）。",
	"Playback rate for local TTS — 0.8x is common for reading aloud.": "本地 TTS 播放速率——朗读常用 0.8x。",
	"How the reply is prepared before synthesis: raw / sanitized (strip code & markdown) / summarized.":
		"朗读前如何处理回复：原文 / 净化（去代码与 Markdown）/ 摘要。",
	"Automatically read aloud new assistant replies.": "新的助手回复自动朗读。",
	"Local neural TTS model: Kokoro-82M (English-first, multi-voice) or MeloTTS-zh (Mandarin / mixed zh-en).":
		"本地神经 TTS 模型：Kokoro-82M（英文优先、多音色）或 MeloTTS-zh（普通话 / 中英混合）。",
	"Voice id for the local TTS backend (per-model voice list).": "本地 TTS 后端音色（按模型列出可选音色）。",
	"Submit manually": "手动提交",
	"On release (2+ words)": "松开时（2 词以上）",
	"On complete sentence": "完整句子后",
	"Say “submit”": "说「submit」",
	"Raw text": "原文",
	"Sanitized (no code/markdown)": "净化（去代码/Markdown）",
	Summarized: "摘要",
	"ext builtin stt component whisper": "Whisper 引擎",
	"Whisper tiers (Fast / Balanced / Turbo) on the transformers.js engine.":
		"transformers.js 引擎上的 Whisper 档位（Fast / Balanced / Turbo）。",
	"ext builtin stt component sensevoice": "SenseVoice 引擎",
	"SenseVoiceSmall (INT8) on sherpa-onnx — the Chinese-optimized tier.":
		"sherpa-onnx 上的 SenseVoiceSmall（INT8）——中文优化档。",
	"ext builtin stt component parakeet": "Parakeet 引擎",
	"NVIDIA Parakeet TDT v3 on sherpa-onnx — English/European SoTA tier.":
		"sherpa-onnx 上的 NVIDIA Parakeet TDT v3——英文/欧语 SoTA 档。",
	"ext builtin tts component kokoro": "Kokoro 引擎",
	"Kokoro-82M neural TTS on kokoro-js — English-first, multi-voice.":
		"kokoro-js 上的 Kokoro-82M 神经 TTS——英文优先、多音色。",
	"ext builtin tts component melotts-zh": "MeloTTS 引擎",
	"MeloTTS 中文 on sherpa-onnx — Mandarin + mixed zh/en, single speaker.":
		"sherpa-onnx 上的 MeloTTS 中文——普通话 + 中英混合，单发音人。",
} as const;

registerTranslations("zh-CN", zhVoice);

// en-US overlay: identity map — the t() fallback already returns the key, this
// just makes the registration symmetrical with the zh-CN overlay above.
// `satisfies` pins key parity: a zh key without an en entry (or vice versa)
// is a compile error, same contract the guest-client domain files enforce.
registerTranslations("en-US", {
	"speech recognition model": "speech recognition model",
	"speech synthesis model": "speech synthesis model",
	"Lightweight and fast — best for quick English notes": "Lightweight and fast — best for quick English notes",
	"Balanced default — multilingual, Chinese included": "Balanced default — multilingual, Chinese included",
	"Widest language coverage — larger download, slower": "Widest language coverage — larger download, slower",
	"Top accuracy for English & European speech — no Chinese": "Top accuracy for English & European speech — no Chinese",
	"Chinese-optimized — Mandarin, Cantonese & mixed zh/en": "Chinese-optimized — Mandarin, Cantonese & mixed zh/en",
	"SoTA English & code narration — no Chinese": "SoTA English & code narration — no Chinese",
	"Mandarin narration with mixed zh/en": "Mandarin narration with mixed zh/en",
	Lightweight: "Lightweight",
	"Multilingual · default": "Multilingual · default",
	"99 languages": "99 languages",
	"SoTA · EN/EU only": "SoTA · EN/EU only",
	"Chinese-optimized · zh/en": "Chinese-optimized · zh/en",
	"English-first": "English-first",
	Chinese: "Chinese",
	"downloads automatically when selected": "downloads automatically when selected",
	voice: "Voice",
	"voice settings": "Voice Settings",
	"Listening… speak now": "Listening… speak now",
	"voice test preview": "voice test preview",
	"Test dictation and read-aloud in the simulated conversation below: press the mic in the input and speak — the transcript lands as a user message; press the read-aloud button on the reply to hear voice output.":
		"Test dictation and read-aloud in the simulated conversation below: press the mic in the input and speak — the transcript lands as a user message; press the read-aloud button on the reply to hear voice output.",
	"Recognition model": "Recognition model",
	"Recognition language hint": "Recognition language hint",
	"End-of-speech pause (ms)": "End-of-speech pause (ms)",
	"Submit trigger": "Submit trigger",
	"Read-aloud model": "Read-aloud model",
	Voice: "Voice",
	"Playback rate": "Playback rate",
	"Content preparation": "Content preparation",
	"Auto read new replies": "Auto read new replies",
	"Recognition language hint; empty = auto-detect (recommended for mixed zh/en).":
		"Recognition language hint; empty = auto-detect (recommended for mixed zh/en).",
	"How long of a pause counts as the end of dictation (milliseconds).":
		"How long of a pause counts as the end of dictation (milliseconds).",
	"When dictation auto-submits: never / on release (2+ words) / release with complete sentence / say-submit.":
		"When dictation auto-submits: never / on release (2+ words) / release with complete sentence / say-submit.",
	"On-device speech model: Whisper small (default, multilingual, Chinese-ready), SenseVoiceSmall (zh/yue-optimized, INT8), Parakeet v3 (English/European top tier, no Chinese).":
		"On-device speech model: Whisper small (default, multilingual, Chinese-ready), SenseVoiceSmall (zh/yue-optimized, INT8), Parakeet v3 (English/European top tier, no Chinese).",
	"Playback rate for local TTS — 0.8x is common for reading aloud.":
		"Playback rate for local TTS — 0.8x is common for reading aloud.",
	"How the reply is prepared before synthesis: raw / sanitized (strip code & markdown) / summarized.":
		"How the reply is prepared before synthesis: raw / sanitized (strip code & markdown) / summarized.",
	"Automatically read aloud new assistant replies.": "Automatically read aloud new assistant replies.",
	"Local neural TTS model: Kokoro-82M (English-first, multi-voice) or MeloTTS-zh (Mandarin / mixed zh-en).":
		"Local neural TTS model: Kokoro-82M (English-first, multi-voice) or MeloTTS-zh (Mandarin / mixed zh-en).",
	"Voice id for the local TTS backend (per-model voice list).":
		"Voice id for the local TTS backend (per-model voice list).",
	"Submit manually": "Submit manually",
	"On release (2+ words)": "On release (2+ words)",
	"On complete sentence": "On complete sentence",
	"Say “submit”": "Say “submit”",
	"Raw text": "Raw text",
	"Sanitized (no code/markdown)": "Sanitized (no code/markdown)",
	Summarized: "Summarized",
	"ext builtin stt component whisper": "ext builtin stt component whisper",
	"Whisper tiers (Fast / Balanced / Turbo) on the transformers.js engine.":
		"Whisper tiers (Fast / Balanced / Turbo) on the transformers.js engine.",
	"ext builtin stt component sensevoice": "ext builtin stt component sensevoice",
	"SenseVoiceSmall (INT8) on sherpa-onnx — the Chinese-optimized tier.":
		"SenseVoiceSmall (INT8) on sherpa-onnx — the Chinese-optimized tier.",
	"ext builtin stt component parakeet": "ext builtin stt component parakeet",
	"NVIDIA Parakeet TDT v3 on sherpa-onnx — English/European SoTA tier.":
		"NVIDIA Parakeet TDT v3 on sherpa-onnx — English/European SoTA tier.",
	"ext builtin tts component kokoro": "ext builtin tts component kokoro",
	"Kokoro-82M neural TTS on kokoro-js — English-first, multi-voice.":
		"Kokoro-82M neural TTS on kokoro-js — English-first, multi-voice.",
	"ext builtin tts component melotts-zh": "ext builtin tts component melotts-zh",
	"MeloTTS 中文 on sherpa-onnx — Mandarin + mixed zh/en, single speaker.":
		"MeloTTS 中文 on sherpa-onnx — Mandarin + mixed zh/en, single speaker.",
} as const satisfies Record<keyof typeof zhVoice, string>);
