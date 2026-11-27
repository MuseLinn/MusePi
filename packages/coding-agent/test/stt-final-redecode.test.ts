import { describe, expect, it } from "bun:test";
import { concatSegmentsForRedecode, joinSegmentTexts } from "../src/stt/asr-worker";

describe("streaming final transcript", () => {
	it("joins CJK segments without a space and Latin segments with one", () => {
		expect(joinSegmentTexts(["今天天气很好", "我们出去走走"])).toBe("今天天气很好我们出去走走");
		expect(joinSegmentTexts(["hello", "world"])).toBe("hello world");
		expect(joinSegmentTexts(["打开", "README", "文件"])).toBe("打开README文件");
		expect(joinSegmentTexts(["", "only"])).toBe("only");
	});

	it("concatenates segments with a 200 ms silence gap", () => {
		const audio = concatSegmentsForRedecode([new Float32Array(4).fill(1), new Float32Array(2).fill(2)]);
		expect(audio).not.toBeNull();
		expect(audio!.length).toBe(4 + 3_200 + 2);
		expect(Array.from(audio!.subarray(0, 4))).toEqual([1, 1, 1, 1]);
		expect(audio!.subarray(4, 3_204).every(sample => sample === 0)).toBe(true);
		expect(Array.from(audio!.subarray(3_204))).toEqual([2, 2]);
	});

	it("declines to re-decode past 60 seconds of audio", () => {
		expect(concatSegmentsForRedecode([new Float32Array(16_000 * 30), new Float32Array(16_000 * 30)])).toBeNull();
		expect(concatSegmentsForRedecode([new Float32Array(16_000 * 29), new Float32Array(16_000 * 30)])).not.toBeNull();
	});
});
