import { describe, expect, test } from "bun:test";
import { isContextCommand } from "./context-command";

describe("isContextCommand", () => {
	test("matches bare /context and /context with args", () => {
		expect(isContextCommand("/context")).toBe(true);
		expect(isContextCommand("  /context  ")).toBe(true);
		expect(isContextCommand("/context breakdown")).toBe(true);
	});

	test("does not match prose or other commands", () => {
		expect(isContextCommand("")).toBe(false);
		expect(isContextCommand("context of the session")).toBe(false);
		expect(isContextCommand("/usage")).toBe(false);
		expect(isContextCommand("explain /context")).toBe(false);
		expect(isContextCommand("/contextx")).toBe(false);
	});
});
