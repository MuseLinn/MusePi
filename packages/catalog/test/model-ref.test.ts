import { describe, expect, test } from "bun:test";
import { asModelRef, modelRef } from "../src/identity/ref";

describe("model ref", () => {
	test("builds the canonical provider/id form", () => {
		expect(String(modelRef("openai", "gpt-4o"))).toBe("openai/gpt-4o");
	});

	test("keeps model ids that contain slashes intact", () => {
		expect(String(modelRef("openrouter", "openai/gpt-oss-120b"))).toBe("openrouter/openai/gpt-oss-120b");
	});

	test("accepts only values with both halves", () => {
		expect(String(asModelRef("openai/gpt-4o"))).toBe("openai/gpt-4o");
		expect(String(asModelRef("openrouter/openai/gpt-oss-120b"))).toBe("openrouter/openai/gpt-oss-120b");
		expect(asModelRef("gpt-4o")).toBeUndefined();
		expect(asModelRef("/gpt-4o")).toBeUndefined();
		expect(asModelRef("openai/")).toBeUndefined();
	});
});
