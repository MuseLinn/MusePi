import { afterEach, describe, expect, test } from "bun:test";
import {
	activateCapability,
	isCapabilityActive,
	resetCapabilityActivations,
} from "@musepi/pi-coding-agent/extensibility/capability-activation";
import {
	isToolOwnerActive,
	ownedToolNames,
	registerToolOwner,
	toolOwnerOf,
} from "@musepi/pi-coding-agent/tools/tool-ownership";

afterEach(() => resetCapabilityActivations());

describe("tool ownership", () => {
	test("an unowned tool stays implicitly available", () => {
		expect(toolOwnerOf("ask")).toBeUndefined();
		expect(isToolOwnerActive("ask")).toBe(true);
	});

	test("a packaged tool follows its component", () => {
		const release = activateCapability("file", "read");
		try {
			expect(isToolOwnerActive("read")).toBe(true);
			expect(isToolOwnerActive("write")).toBe(false);
		} finally {
			release();
		}
		// A domain that has been mounted keeps deciding: once file-tools has
		// registered anything, an id it does not hold is unavailable. That is
		// what removes a tool family when its package is unloaded.
		expect(isToolOwnerActive("read")).toBe(false);
		expect(isToolOwnerActive("write")).toBe(false);
	});

	test("a domain that was never mounted leaves its tools available", () => {
		// No registration for this domain at all (CLI, isolated worker): the
		// tools stay in the slate instead of vanishing.
		expect(isCapabilityActive("never-mounted", "anything")).toBe(true);
		expect(isToolOwnerActive("read")).toBe(true);
	});

	test("the computer and lsp tools follow their own components", () => {
		const release = activateCapability("tool", "computer");
		try {
			expect(isToolOwnerActive("computer")).toBe(true);
			expect(isToolOwnerActive("lsp")).toBe(false);
		} finally {
			release();
		}
	});

	test("a runtime claim wins over the declared table and restores on release", () => {
		expect(toolOwnerOf("ask")).toBeUndefined();
		const release = registerToolOwner("ask", { domain: "tool", id: "ask" });
		expect(toolOwnerOf("ask")).toEqual({ domain: "tool", id: "ask" });
		expect(ownedToolNames()).toContain("ask");
		release();
		expect(toolOwnerOf("ask")).toBeUndefined();
		expect(ownedToolNames()).not.toContain("ask");
	});

	test("the declared table covers every file family and the packaged single tools", () => {
		const owned = ownedToolNames();
		for (const name of ["read", "write", "edit", "glob", "grep", "computer", "lsp"]) {
			expect(owned).toContain(name);
		}
	});
});
