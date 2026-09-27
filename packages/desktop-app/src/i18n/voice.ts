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

registerTranslations("zh-CN", {
	"speech recognition model": "语音识别模型",
	"Lightweight and fast — best for quick English notes": "极速轻量，英文速记首选",
	"Balanced default — multilingual, Chinese included": "均衡默认，多语言含中文",
	"Widest language coverage — larger download, slower": "99 种语言覆盖最广，体积更大、速度较慢",
	"Top accuracy for English & European speech — no Chinese": "英文/欧语准确率天花板，但不支持中文",
	"Chinese-optimized — Mandarin, Cantonese & mixed zh/en": "中文优化：普通话、粤语、中英混说都准",
	Lightweight: "轻量",
	"Multilingual · default": "多语言 · 默认",
	"99 languages": "99 语言",
	"SoTA · EN/EU only": "SoTA · 英文/欧语",
	"Chinese-optimized · zh/en": "中文优化 · 中英混合",
	"downloads automatically when selected": "选中后自动下载",
	"Listening… speak now": "聆听中…请说话",
});

// en-US overlay: identity map — the t() fallback already returns the key, this
// just makes the registration symmetrical with the zh-CN overlay above.
registerTranslations("en-US", {
	"speech recognition model": "speech recognition model",
	"Lightweight and fast — best for quick English notes": "Lightweight and fast — best for quick English notes",
	"Balanced default — multilingual, Chinese included": "Balanced default — multilingual, Chinese included",
	"Widest language coverage — larger download, slower": "Widest language coverage — larger download, slower",
	"Top accuracy for English & European speech — no Chinese": "Top accuracy for English & European speech — no Chinese",
	"Chinese-optimized — Mandarin, Cantonese & mixed zh/en": "Chinese-optimized — Mandarin, Cantonese & mixed zh/en",
	Lightweight: "Lightweight",
	"Multilingual · default": "Multilingual · default",
	"99 languages": "99 languages",
	"SoTA · EN/EU only": "SoTA · EN/EU only",
	"Chinese-optimized · zh/en": "Chinese-optimized · zh/en",
	"downloads automatically when selected": "downloads automatically when selected",
	"Listening… speak now": "Listening… speak now",
});
