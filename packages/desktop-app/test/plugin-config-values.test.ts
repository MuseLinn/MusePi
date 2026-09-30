import { describe, expect, test } from "bun:test";
import type { ConfigFieldDesc } from "@musepi/pi-wire";
import { coerceConfigValue, defaultsConfigValues } from "../src/lib/plugin-config-values";

/**
 * 插件配置取值契约:存储里的坏值/错型/越界绝不能进到表单或写回链路——
 * 每个字段以清单声明为准回退到默认值,数字夹取声明区间。
 * 失败模式:清单声明 threshold ∈ [0,1],存储里存了 42 或 "abc",
 * 渲染与提交必须看到 42→1(夹取)、"abc"→default,而不是原样透传。
 */
const THRESHOLD: ConfigFieldDesc = { key: "threshold", type: "number", default: 0.5, min: 0, max: 1, step: 0.05 };
const FLAG: ConfigFieldDesc = { key: "flag", type: "boolean", default: true };
const MODEL: ConfigFieldDesc = { key: "model", type: "select", default: "base", options: ["base", "large"] };
const PROMPT: ConfigFieldDesc = { key: "prompt", type: "string", default: "hello" };
const BIN: ConfigFieldDesc = { key: "bin", type: "path", default: "" };

describe("coerceConfigValue", () => {
	test("boolean accepts only real booleans, non-boolean falls back to default", () => {
		expect(coerceConfigValue(FLAG, false)).toBe(false);
		// "false" 字符串不是 boolean → 回退 default(true),证明没有字符串真值转换。
		expect(coerceConfigValue(FLAG, "false")).toBe(true);
		expect(coerceConfigValue(FLAG, 0)).toBe(true);
	});

	test("number clamps into the declared range", () => {
		expect(coerceConfigValue(THRESHOLD, 42)).toBe(1);
		expect(coerceConfigValue(THRESHOLD, -3)).toBe(0);
		expect(coerceConfigValue(THRESHOLD, 0.25)).toBe(0.25);
	});

	test("number rejects NaN-producing input with the default", () => {
		expect(coerceConfigValue(THRESHOLD, "abc")).toBe(0.5);
		expect(coerceConfigValue(THRESHOLD, undefined)).toBe(0.5);
	});

	test("select only accepts declared options", () => {
		expect(coerceConfigValue(MODEL, "large")).toBe("large");
		expect(coerceConfigValue(MODEL, "turbo")).toBe("base");
		expect(coerceConfigValue(MODEL, 7)).toBe("base");
	});

	test("string and path keep strings, reject other types", () => {
		expect(coerceConfigValue(PROMPT, "world")).toBe("world");
		expect(coerceConfigValue(PROMPT, 9)).toBe("hello");
		expect(coerceConfigValue(BIN, "C:\\bin\\stt.exe")).toBe("C:\\bin\\stt.exe");
		expect(coerceConfigValue(BIN, null)).toBe("");
	});
});

describe("defaultsConfigValues", () => {
	test("builds the full value set from defaults when storage is absent", () => {
		expect(defaultsConfigValues([FLAG, THRESHOLD, MODEL], undefined)).toEqual({
			flag: true,
			threshold: 0.5,
			model: "base",
		});
	});

	test("keeps good stored values, repairs bad ones, drops undeclared keys", () => {
		const stored = { flag: false, threshold: 99, model: "nope", rogue: "x" };
		expect(defaultsConfigValues([FLAG, THRESHOLD, MODEL], stored)).toEqual({
			flag: false,
			threshold: 1,
			model: "base",
		});
	});
});
