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
	"Listening… speak now": "聆听中…请说话",
	"voice test preview": "语音测试",
	"Test dictation and read-aloud in the simulated conversation below: press the mic in the input and speak — the transcript lands as a user message; press the read-aloud button on the reply to hear voice output.":
		"在下方模拟会话中测试：点击输入框上的麦克风说话，转写结果会作为用户消息出现在预览里；点击回复旁的朗读按钮试听语音输出。",
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
	"Listening… speak now": "Listening… speak now",
	"voice test preview": "voice test preview",
	"Test dictation and read-aloud in the simulated conversation below: press the mic in the input and speak — the transcript lands as a user message; press the read-aloud button on the reply to hear voice output.":
		"Test dictation and read-aloud in the simulated conversation below: press the mic in the input and speak — the transcript lands as a user message; press the read-aloud button on the reply to hear voice output.",
} as const satisfies Record<keyof typeof zhVoice, string>);
