import { afterEach, describe, expect, it, vi } from "bun:test";
import { toolWireSchema, validateJsonSchemaValue } from "@musepi/pi-ai/utils/schema";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ToolSession } from "@musepi/pi-coding-agent/sdk";
import { BrowserTool } from "@musepi/pi-coding-agent/tools/browser";
import type { BrowserDialogInfo, BrowserHandledDialog } from "@musepi/pi-coding-agent/tools/browser/tab-protocol";
import * as supervisor from "@musepi/pi-coding-agent/tools/browser/tab-supervisor";
import { ToolError } from "@musepi/pi-coding-agent/tools/tool-errors";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

const pending: BrowserDialogInfo = {
	dialogId: "PAGE1:1",
	tabId: "PAGE1",
	kind: "prompt" as const,
	message: "Your name?",
	defaultValue: "MusePi",
	ageMs: 25,
};

const handled: BrowserHandledDialog = {
	dialogId: "PAGE1:1",
	tabId: "PAGE1",
	kind: "prompt",
	message: "Your name?",
	defaultValue: "MusePi",
	outcome: "accepted",
	answerer: "agent",
	text: "MusePi Agent",
};

function tab() {
	return {
		targetId: "PAGE1",
		info: { url: "https://example.test", title: "Example", targetId: "PAGE1" },
		browser: { kind: { kind: "connected", gui: true } },
	};
}

afterEach(() => vi.restoreAllMocks());

describe("browser dialogs", () => {
	it("accepts dialog inspection and response actions", () => {
		const schema = toolWireSchema(new BrowserTool(makeSession()));
		expect(validateJsonSchemaValue(schema, { action: "dialog", name: "docs" }).success).toBe(true);
		expect(
			validateJsonSchemaValue(schema, {
				action: "dialog_respond",
				name: "docs",
				accept: true,
				text: "MusePi Agent",
			}).success,
		).toBe(true);
	});

	it("returns the real pending dialog observed by the worker", async () => {
		vi.spyOn(supervisor, "getTab").mockReturnValue(tab() as never);
		vi.spyOn(supervisor, "runInTab").mockResolvedValue({
			displays: [],
			returnValue: pending,
			screenshots: [],
			operations: [],
			pendingDialogs: [pending],
			handledDialogs: [],
		});
		const result = await new BrowserTool(makeSession()).execute("dialog", { action: "dialog", name: "docs" });
		expect(result.isError).not.toBe(true);
		expect(result.details?.pendingDialogs).toEqual([pending]);
		expect(result.content).toContainEqual({
			type: "text",
			text: JSON.stringify({ pendingDialogs: [pending], handledDialogs: [] }, null, 2),
		});
	});

	it("records an Agent prompt response and its text", async () => {
		vi.spyOn(supervisor, "getTab").mockReturnValue(tab() as never);
		vi.spyOn(supervisor, "runInTab").mockResolvedValue({
			displays: [],
			returnValue: handled,
			screenshots: [],
			operations: [],
			pendingDialogs: [],
			handledDialogs: [handled],
		});
		const result = await new BrowserTool(makeSession()).execute("respond", {
			action: "dialog_respond",
			name: "docs",
			accept: true,
			text: "MusePi Agent",
		});
		expect(result.isError).not.toBe(true);
		expect(result.details?.handledDialogs).toEqual([handled]);
		expect(result.details?.pendingDialogs).toEqual([]);
	});

	it("surfaces an explicit error when no dialog is pending", async () => {
		vi.spyOn(supervisor, "getTab").mockReturnValue(tab() as never);
		vi.spyOn(supervisor, "runInTab").mockRejectedValue(new ToolError("No pending dialog"));
		const result = await new BrowserTool(makeSession()).execute("respond", {
			action: "dialog_respond",
			name: "docs",
			accept: false,
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContainEqual({ type: "text", text: "No pending dialog" });
	});
});
