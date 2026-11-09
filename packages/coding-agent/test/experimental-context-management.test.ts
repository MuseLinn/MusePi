import { beforeAll, describe, expect, it } from "bun:test";
import { type } from "@musepi/musepi-type";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import {
	formatCurrentBranchFullHistory,
	HistoryProtocolHandler,
} from "@musepi/pi-coding-agent/internal-urls/history-protocol";
import type { InternalUrl } from "@musepi/pi-coding-agent/internal-urls/types";
import {
	CONTEXT_NOTES_ENTRY_TYPE,
	getContextNotes,
	renderContextNotes,
} from "@musepi/pi-coding-agent/session/context-notes";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { apply as applyContextNotes } from "../src/bundled-plugins/context-notes/index";

const notesSettings = Settings.isolated({ "compaction.experimentalContextManagement": true });

function currentFullUrl(): InternalUrl {
	return {
		href: "history://current/full",
		rawHost: "current",
		hostname: "current",
		pathname: "/full",
		search: "",
		hash: "",
	} as unknown as InternalUrl;
}

describe("experimental context notes", () => {
	let sessionManager: SessionManager;

	beforeAll(() => {
		sessionManager = SessionManager.inMemory();
	});

	function appendNotes(text: string): string {
		return sessionManager.appendCustomEntry(CONTEXT_NOTES_ENTRY_TYPE, { version: 1, text });
	}

	function pluginContext(session = sessionManager) {
		return {
			sessionManager: session,
			ensureSessionOnDisk: () => session.ensureOnDisk(),
			appendCustomEntry: (customType: string, data?: unknown) => session.appendCustomEntry(customType, data),
			flushSession: () => session.flush(),
		};
	}

	function pluginTools(session = sessionManager) {
		const tools = new Map<string, any>();
		const handlers = new Map<string, any>();
		const pi = {
			arktype: type,
			registerTool: (definition: any) => tools.set(definition.name, definition),
			on: (event: string, handler: any) => handlers.set(event, handler),
		} as any;
		applyContextNotes(pi);
		return { tools, handlers, ctx: pluginContext(session) };
	}

	it("reads the latest valid notebook and clears it at a reset boundary", () => {
		const first = appendNotes("first");
		expect(getContextNotes(sessionManager.getBranch())).toEqual({ text: "first", entryId: first });

		const second = appendNotes("second");
		expect(getContextNotes(sessionManager.getBranch())).toEqual({ text: "second", entryId: second });
		expect(renderContextNotes(sessionManager.getBranch())).toContain("second");

		sessionManager.appendResetBoundary();
		expect(getContextNotes(sessionManager.getBranch())).toBeUndefined();
		expect(renderContextNotes(sessionManager.getBranch())).toBe("");
	});

	it("ignores a malformed notebook entry instead of masking an earlier revision", () => {
		const session = SessionManager.inMemory();
		session.appendCustomEntry(CONTEXT_NOTES_ENTRY_TYPE, { version: 1, text: "valid" });
		session.appendCustomEntry(CONTEXT_NOTES_ENTRY_TYPE, { version: 2, text: "invalid" });

		expect(getContextNotes(session.getBranch())?.text).toBe("valid");
	});

	it("round-trips the notebook through the plugin tools and requests a new context", async () => {
		const session = SessionManager.inMemory();
		const { tools, ctx } = pluginTools(session);
		const notesTool = tools.get("context_notes");
		const newContextTool = tools.get("new_context");
		if (!notesTool || !newContextTool) throw new Error("Expected experimental tools");

		const write = await notesTool.execute("call", { text: "remember the plan" }, undefined, undefined, ctx);
		expect(write.details?.text).toBe("remember the plan");
		expect(write.content[0]?.type === "text" ? write.content[0].text : "").toBe("Context notes saved.");

		const read = await notesTool.execute("call", {}, undefined, undefined, ctx);
		expect(read.details?.text).toBe("remember the plan");

		const requested = await newContextTool.execute("call", {}, undefined, undefined, ctx);
		expect(requested.details?.requested).toBe(true);
	});

	it("injects the notebook through the plugin context hook", async () => {
		const session = SessionManager.inMemory();
		session.appendCustomEntry(CONTEXT_NOTES_ENTRY_TYPE, { version: 1, text: "remember the plan" });
		const { handlers, ctx } = pluginTools(session);
		const handler = handlers.get("context");
		if (!handler) throw new Error("Expected context handler");

		const result = await handler(
			{ type: "context", messages: [{ role: "user", content: "next", timestamp: Date.now() }] },
			ctx,
		);
		expect(result?.messages?.[0]).toMatchObject({
			role: "custom",
			customType: CONTEXT_NOTES_ENTRY_TYPE,
		});
		expect(JSON.stringify(result?.messages?.[0])).toContain("remember the plan");
	});

	it("gates the plugin tools on the experimental setting", () => {
		const { tools } = pluginTools();
		const gate = tools.get("context_notes")?.enabled;
		expect(gate({ settings: notesSettings })).toBe(true);
		expect(gate({ settings: Settings.isolated({ "compaction.experimentalContextManagement": false }) })).toBe(false);
	});

	it("serves history://current/full only with the experimental setting and a bound branch", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
		const handler = new HistoryProtocolHandler();

		await expect(handler.resolve(currentFullUrl())).rejects.toThrow(/experimentalContextManagement/);
		await expect(handler.resolve(currentFullUrl(), { experimentalContextManagement: true })).rejects.toThrow(
			/bound live session branch/,
		);

		const resource = await handler.resolve(currentFullUrl(), {
			experimentalContextManagement: true,
			getSessionBranch: () => session.getBranch(),
		});
		expect(resource.content).toContain("# Current branch — full history");
		expect(resource.content).toContain("### user");
		expect(resource.content).toContain("hello");
	});
});

describe("formatCurrentBranchFullHistory", () => {
	it("keeps entry ids and context-window boundaries", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: [{ type: "text", text: "before" }], timestamp: Date.now() });
		session.appendCompaction("summary text", undefined, session.getBranch().at(-1)?.id ?? "", 42, {});
		session.appendMessage({ role: "user", content: [{ type: "text", text: "after" }], timestamp: Date.now() });

		const content = formatCurrentBranchFullHistory(session.getBranch());
		expect(content).toContain("Context window boundary: compaction");
		expect(content).toContain("First kept entry:");
		expect(content).toContain("summary text");
		expect(content).toContain("### user");
		expect(content).toContain("before");
		expect(content).toContain("after");
	});
});
