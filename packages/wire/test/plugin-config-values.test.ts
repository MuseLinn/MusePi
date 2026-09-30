import { describe, expect, test } from "bun:test";
import type { ConfigFieldDesc } from "@musepi/pi-wire";
import { coerceConfigFieldValue, coerceConfigValues } from "@musepi/pi-wire";

/**
 * 取值钳制契约:写入与读取共用这一个函数——存储/传输里的坏值、错型、
 * 越界绝不能原样透出:回退默认值、数字夹取声明区间、select 只认声明项。
 * 失败模式:threshold ∈ [0,1] 存了 42 或 "abc",两端都必须看到 1 / default。
 */
const THRESHOLD: ConfigFieldDesc = { key: "threshold", type: "number", default: 0.5, min: 0, max: 1, step: 0.05 };
const FLAG: ConfigFieldDesc = { key: "flag", type: "boolean", default: true };
const MODEL: ConfigFieldDesc = { key: "model", type: "select", default: "base", options: ["base", "large"] };
const PROMPT: ConfigFieldDesc = { key: "prompt", type: "string", default: "hello" };
const BIN: ConfigFieldDesc = { key: "bin", type: "path", default: "" };

describe("coerceConfigFieldValue", () => {
	test("boolean accepts only real booleans, non-boolean falls back to default", () => {
		expect(coerceConfigFieldValue(FLAG, false)).toBe(false);
		// "false" 字符串不是 boolean → 回退 default(true),证明没有字符串真值转换。
		expect(coerceConfigFieldValue(FLAG, "false")).toBe(true);
		expect(coerceConfigFieldValue(FLAG, 0)).toBe(true);
	});

	test("number clamps into the declared range and rejects NaN input", () => {
		expect(coerceConfigFieldValue(THRESHOLD, 42)).toBe(1);
		expect(coerceConfigFieldValue(THRESHOLD, -3)).toBe(0);
		expect(coerceConfigFieldValue(THRESHOLD, 0.25)).toBe(0.25);
		expect(coerceConfigFieldValue(THRESHOLD, "abc")).toBe(0.5);
		expect(coerceConfigFieldValue(THRESHOLD, undefined)).toBe(0.5);
	});

	test("select only accepts declared options", () => {
		expect(coerceConfigFieldValue(MODEL, "large")).toBe("large");
		expect(coerceConfigFieldValue(MODEL, "turbo")).toBe("base");
		expect(coerceConfigFieldValue(MODEL, 7)).toBe("base");
	});

	test("string and path keep strings, reject other types", () => {
		expect(coerceConfigFieldValue(PROMPT, "world")).toBe("world");
		expect(coerceConfigFieldValue(PROMPT, 9)).toBe("hello");
		expect(coerceConfigFieldValue(BIN, "C:\\bin\\stt.exe")).toBe("C:\\bin\\stt.exe");
		expect(coerceConfigFieldValue(BIN, null)).toBe("");
	});
});

describe("coerceConfigValues", () => {
	test("builds the full value set from defaults when storage is absent", () => {
		expect(coerceConfigValues([FLAG, THRESHOLD, MODEL], undefined)).toEqual({
			flag: true,
			threshold: 0.5,
			model: "base",
		});
	});

	test("keeps good stored values, repairs bad ones, drops undeclared keys", () => {
		const stored = { flag: false, threshold: 99, model: "nope", rogue: "x" };
		expect(coerceConfigValues([FLAG, THRESHOLD, MODEL], stored)).toEqual({
			flag: false,
			threshold: 1,
			model: "base",
		});
	});
});
