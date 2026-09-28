import { describe, expect, it } from "bun:test";
import {
	getTtsLocalModelSpec,
	isPredominantlyCjkText,
	resolveSherpaSpeakerId,
	resolveTtsModelForText,
	type SherpaTtsLocalModelSpec,
	sherpaTtsRequiredFiles,
} from "./models";

/**
 * MeloTTS-zh registration contract. The 2026-09-28 silent-TTS incident came
 * from a registry entry that under-declared the official sherpa-onnx
 * vits-melo-tts-zh_en manifest (no jieba dict dir, no rule FSTs) — the tier
 * showed "ready" while synthesizing wrong or not at all. These tests pin the
 * manifest against the k2-fsa release layout so trimming it fails loudly.
 */
describe("melotts-zh registry manifest", () => {
	const spec = getTtsLocalModelSpec("melotts-zh");

	it("is registered as a sherpa vits tier at the official repo", () => {
		expect(spec).toBeDefined();
		expect(spec?.engine).toBe("sherpa");
		if (spec?.engine !== "sherpa") return;
		expect(spec.modelType).toBe("vits");
		expect(spec.repo).toBe("csukuangfj/vits-melo-tts-zh_en");
	});

	it("declares exactly the model's real speaker catalog (single ZH voice, sid 0)", () => {
		// Downstream consumers: the GUI renders this catalog as the tier's voice
		// radios and resolveSherpaSpeakerId maps catalog index → sid directly, so
		// an over-declared catalog offers speaker ids the model does not have
		// (the sherpa addon then rejects synthesis). k2-fsa's official manifest
		// documents vits-melo-tts-zh_en as a 1-speaker export.
		if (spec?.engine !== "sherpa") throw new Error("melotts-zh must be a sherpa tier");
		expect(spec.voices.length).toBe(1);
		expect(resolveSherpaSpeakerId(spec, spec.voices[0]!.id)).toBe(0);
	});

	it("declares the full official file set (weights + jieba dict + rule FSTs)", () => {
		if (spec?.engine !== "sherpa") throw new Error("melotts-zh must be a sherpa tier");
		const required = sherpaTtsRequiredFiles(spec);
		// Flat sherpa-onnx VITS inputs.
		for (const file of ["model.onnx", "tokens.txt", "lexicon.txt"]) {
			expect(required).toContain(file);
		}
		// Jieba dictionary the zh frontend loads via vits.dictDir — without it
		// word segmentation is missing and Chinese synthesis degrades.
		expect(spec.dict?.dir).toBe("dict");
		for (const file of ["jieba.dict.utf8", "hmm_model.utf8", "user.dict.utf8"]) {
			expect(required).toContain(`dict/${file}`);
		}
		// Number/date/phone verbalization + heteronym disambiguation rules.
		for (const file of ["new_heteronym.fst", "number.fst", "phone.fst", "date.fst"]) {
			expect(required).toContain(file);
		}
		// The manifest must not double-count or omit: exactly flat + dict + fsts.
		expect(required.length).toBe(3 + (spec.dict?.files.length ?? 0) + (spec.ruleFsts?.length ?? 0));
	});

	it("declares the model's native 44100 Hz sample rate", () => {
		expect(spec?.sampleRate).toBe(44_100);
	});
});

/**
 * Voice→speaker-id mapping contract: the sherpa node addon rejects generate
 * requests without an explicit `sid` ("The argument object should have a field
 * sid"), so synthesis must always resolve a concrete sid in range.
 */
describe("resolveSherpaSpeakerId", () => {
	it("maps the tier's default voice to sid 0", () => {
		const spec = getTtsLocalModelSpec("melotts-zh");
		if (spec?.engine !== "sherpa") throw new Error("melotts-zh must be a sherpa tier");
		expect(resolveSherpaSpeakerId(spec, undefined)).toBe(0);
		expect(resolveSherpaSpeakerId(spec, "default")).toBe(0);
	});

	it("maps catalog order to sid and clamps unknown voices to the default", () => {
		const multiVoice: SherpaTtsLocalModelSpec = {
			key: "melotts-zh",
			engine: "sherpa",
			modelType: "vits",
			repo: "example/repo",
			sampleRate: 44_100,
			label: "test",
			description: "test",
			voices: [
				{ id: "default", label: "A" },
				{ id: "alt", label: "B" },
			],
			files: { model: "model.onnx", tokens: "tokens.txt", lexicon: "lexicon.txt" },
		};
		expect(resolveSherpaSpeakerId(multiVoice, "alt")).toBe(1);
		expect(resolveSherpaSpeakerId(multiVoice, "kokoro-only-voice")).toBe(0);
	});
});

/**
 * Auto-routing contract: Kokoro is English-only, so CJK text must land on the
 * registered Chinese tier no matter which model is selected; Latin text stays
 * on the requested model.
 */
describe("resolveTtsModelForText", () => {
	it("routes Chinese test-voice text to melotts-zh even when kokoro is selected", () => {
		expect(resolveTtsModelForText("kokoro", "测试语音输出")).toBe("melotts-zh");
	});

	it("keeps Chinese text on melotts-zh when it is the requested model", () => {
		expect(resolveTtsModelForText("melotts-zh", "测试语音输出")).toBe("melotts-zh");
	});

	it("keeps English text on kokoro", () => {
		expect(resolveTtsModelForText("kokoro", "Hello world, this is a test.")).toBe("kokoro");
	});

	it("treats mixed zh/en text as Chinese when CJK outnumbers Latin", () => {
		expect(isPredominantlyCjkText("中文 voice 测试文字")).toBe(true);
		expect(resolveTtsModelForText("kokoro", "中文 voice 测试文字")).toBe("melotts-zh");
		// Latin outnumbers CJK → not predominantly CJK.
		expect(isPredominantlyCjkText("使用 voice 设置")).toBe(false);
	});

	it("falls back to the default tier for unknown model keys", () => {
		expect(resolveTtsModelForText("bogus", "Hello")).toBe("kokoro");
	});
});
