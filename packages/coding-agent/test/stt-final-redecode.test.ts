import { describe, expect, it } from "bun:test";
import { joinSegmentTexts } from "../src/stt/asr-worker";

describe("streaming final transcript", () => {
	it("joins CJK sentences without a space and Latin sentences with one", () => {
		expect(joinSegmentTexts(["今天天气很好", "我们出去走走"])).toBe("今天天气很好我们出去走走");
		expect(joinSegmentTexts(["hello", "world"])).toBe("hello world");
		expect(joinSegmentTexts(["打开", "README", "文件"])).toBe("打开README文件");
		expect(joinSegmentTexts(["", "only"])).toBe("only");
	});
});
