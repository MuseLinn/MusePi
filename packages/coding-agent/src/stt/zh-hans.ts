/**
 * Script normalisation for Chinese transcripts (Traditional → Simplified).
 *
 * Whisper checkpoints decode Mandarin into Traditional characters far more
 * often than Simplified — the tokenizer's zh training corpus is Taiwan-heavy —
 * which reads as "Chinese is not supported" to a zh-CN user. Neither engine
 * (transformers.js, sherpa-onnx) exposes a decoder prompt that could bias the
 * output script, so the transcript is normalised after the fact with OpenCC
 * (t → cn) whenever the request pinned a `zh` language.
 *
 * The converter loads lazily (a ~1 MB pure-JS dictionary) so English-only
 * sessions never pay for it, and a failed load degrades to the raw
 * transcript instead of failing the request.
 */

type OpenccConverter = (input: string) => string;

let converterPromise: Promise<OpenccConverter | null> | undefined;

function loadConverter(): Promise<OpenccConverter | null> {
	return import("opencc-js")
		.then(opencc => {
			const create = opencc.Converter ?? opencc.default?.Converter;
			return create ? create({ from: "t", to: "cn" }) : null;
		})
		.catch(() => null);
}

function getConverter(): Promise<OpenccConverter | null> {
	converterPromise ??= loadConverter();
	return converterPromise;
}

/** True when the ASR `language` hint selects a Chinese variant (zh, zh-CN…). */
export function isChineseLanguage(language: string | undefined): boolean {
	return typeof language === "string" && language.toLowerCase().startsWith("zh");
}

/** OpenCC-normalise a transcript to Simplified when the request is zh. */
export async function normalizeChineseScript(text: string, language: string | undefined): Promise<string> {
	if (!text || !isChineseLanguage(language)) return text;
	const convert = await getConverter();
	return convert ? convert(text) : text;
}
