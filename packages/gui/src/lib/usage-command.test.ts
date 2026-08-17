import { describe, expect, test } from "bun:test";
import { isUsageCommand } from "./usage-command";

describe("isUsageCommand", () => {
	test("matches bare /usage and /usage with args", () => {
		expect(isUsageCommand("/usage")).toBe(true);
		expect(isUsageCommand("  /usage  ")).toBe(true);
		expect(isUsageCommand("/usage show")).toBe(true);
		expect(isUsageCommand("/usage reset account 1")).toBe(true);
	});

	test("does not match normal prompts or other commands", () => {
		expect(isUsageCommand("")).toBe(false);
		expect(isUsageCommand("usage of the api")).toBe(false);
		expect(isUsageCommand("/compact")).toBe(false);
		expect(isUsageCommand("explain /usage")).toBe(false);
		expect(isUsageCommand("/usagex")).toBe(false);
	});
});
