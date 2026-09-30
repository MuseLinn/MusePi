import { describe, expect, it } from "bun:test";
import { parseConfigFields, parsePluginResources } from "../src/plugin-config";

/**
 * 声明式配置契约校验(设计稿 §1/§4):manifest 是用户可写 JSON,校验必须逐
 * 字段 fail-soft——坏字段进结构化 errors 并被丢弃,好字段原样通过,绝不让
 * 一个坏字段拖垮整个扩展的登记(回退保护①)。
 */

describe("parseConfigFields", () => {
	it("absent config parses to empty without errors", () => {
		expect(parseConfigFields(undefined)).toEqual({ fields: [], errors: [] });
		expect(parseConfigFields(null)).toEqual({ fields: [], errors: [] });
	});

	it("a non-array non-object config is rejected structurally", () => {
		const r = parseConfigFields("nope");
		expect(r.fields).toEqual([]);
		expect(r.errors[0]?.code).toBe("config-not-an-object");
	});

	it("accepts well-formed fields of every type", () => {
		const r = parseConfigFields([
			{ key: "verbose", type: "boolean", default: false, restart: "session" },
			{ key: "maxBytes", type: "number", default: 4096, min: 1, max: 65536, step: 1024 },
			{ key: "prompt", type: "string", description: "system prompt suffix" },
			{ key: "bin", type: "path" },
			{ key: "provider", type: "select", default: "a", options: ["a", "b"] },
		]);
		expect(r.errors).toEqual([]);
		expect(r.fields.map(f => f.key)).toEqual(["verbose", "maxBytes", "prompt", "bin", "provider"]);
		expect(r.fields[4]?.options).toEqual(["a", "b"]);
	});

	it("drops malformed fields individually while keeping good ones", () => {
		const r = parseConfigFields([
			{ key: "good", type: "boolean", default: true },
			{ type: "boolean" }, // no key
			{ key: "x", type: "wat" }, // bad type
			{ key: "n", type: "number", default: "big" }, // default type mismatch
			{ key: "s", type: "select" }, // select without options
			"garbage",
		]);
		expect(r.fields.map(f => f.key)).toEqual(["good"]);
		expect(r.errors.map(e => e.code)).toEqual([
			"field-bad-key",
			"field-bad-type",
			"field-bad-default",
			"field-bad-select",
			"field-not-an-object",
		]);
	});

	it("select filters non-string options but rejects an all-empty list", () => {
		const ok = parseConfigFields([{ key: "s", type: "select", options: ["a", 7, null, "b"] }]);
		expect(ok.errors).toEqual([]);
		expect(ok.fields[0]?.options).toEqual(["a", "b"]);
		const empty = parseConfigFields([{ key: "s", type: "select", options: [] }]);
		expect(empty.fields).toEqual([]);
		expect(empty.errors[0]?.code).toBe("field-bad-select");
	});

	it("ignores unknown restart values and keeps a valid field", () => {
		const r = parseConfigFields([{ key: "k", type: "string", restart: "whenever" }]);
		expect(r.errors).toEqual([]);
		expect(r.fields[0]?.restart).toBeUndefined();
	});
});

describe("parsePluginResources", () => {
	it("returns undefined for non-objects and all-bad shapes", () => {
		expect(parsePluginResources(undefined)).toBeUndefined();
		expect(parsePluginResources("disk")).toBeUndefined();
		expect(parsePluginResources({ disk: 5 })).toBeUndefined();
	});

	it("keeps usable fields and drops malformed model rows", () => {
		const r = parsePluginResources({
			disk: "≈2 GB",
			setupMinutes: 5,
			models: [{ name: "sensevoice", size: "230 MB", downloadUrl: "https://x/y" }, { size: "no name" }, "junk"],
		});
		expect(r?.disk).toBe("≈2 GB");
		expect(r?.setupMinutes).toBe(5);
		expect(r?.models).toHaveLength(1);
		expect(r?.models?.[0]?.name).toBe("sensevoice");
	});
});
