import { describe, expect, test } from "bun:test";
import { isChineseLanguage, normalizeChineseScript } from "../src/stt/zh-hans";

describe("isChineseLanguage", () => {
	test("matches zh variants regardless of case", () => {
		expect(isChineseLanguage("zh")).toBeTrue();
		expect(isChineseLanguage("zh-CN")).toBeTrue();
		expect(isChineseLanguage("ZH-tw")).toBeTrue();
	});

	test("rejects other languages and absent hints", () => {
		expect(isChineseLanguage("en")).toBeFalse();
		expect(isChineseLanguage(undefined)).toBeFalse();
		expect(isChineseLanguage("")).toBeFalse();
	});
});

describe("normalizeChineseScript", () => {
	test("converts Whisper's traditional output to simplified for zh", async () => {
		const out = await normalizeChineseScript("你好嗎？我很高興認識你，這個軟體很有用。", "zh");
		expect(out).toBe("你好吗？我很高兴认识你，这个软体很有用。");
	});

	test("leaves already-simplified text untouched", async () => {
		const text = "你好吗？我很高兴认识你。";
		expect(await normalizeChineseScript(text, "zh-CN")).toBe(text);
	});

	test("leaves non-Chinese content untouched even for zh requests", async () => {
		expect(await normalizeChineseScript("hello world 123", "zh")).toBe("hello world 123");
	});

	test("passes traditional text through when no zh language is pinned", async () => {
		const text = "這是繁體輸出";
		expect(await normalizeChineseScript(text, "en")).toBe(text);
		expect(await normalizeChineseScript(text, undefined)).toBe(text);
	});

	test("never throws when handed an empty transcript", async () => {
		expect(await normalizeChineseScript("", "zh")).toBe("");
	});
});
