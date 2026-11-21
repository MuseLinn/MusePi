import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSecretSnapshot } from "../src/secrets/agent-runtime";
import { AgentSecretStore } from "../src/secrets/agent-store";
import { TailBuffer } from "../src/session/streaming-output";
import type { ToolSession } from "../src/tools";
import { BashTool, createRedactedTailStreamer } from "../src/tools/bash";

const VALUE = "sk-super-secret-123";
const SPLIT_AT = 6;

function makeSession(agentDir: string): ToolSession {
	return {
		cwd: agentDir,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => "session-1",
		settings: {
			getAgentDir: () => agentDir,
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "grep.enabled") return false;
				if (key === "glob.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

describe("streaming redaction across chunk boundaries", () => {
	it("foreground tail updates never expose a value split across chunks", async () => {
		const dir = mkdtempSync(join(tmpdir(), "musepi-agent-stream-"));
		await new AgentSecretStore(dir).set("API_TOKEN", VALUE, "curl");
		const snapshot = await agentSecretSnapshot(dir, dir);
		const tail = new TailBuffer(64 * 1024);
		const emitted: string[] = [];
		const stream = createRedactedTailStreamer(tail, snapshot.redact, text => emitted.push(text));

		// The value is deliberately cut in half: per-chunk redaction would miss it.
		stream(`prefix ${VALUE.slice(0, SPLIT_AT)}`);
		stream(`${VALUE.slice(SPLIT_AT)} suffix`);

		for (const text of emitted) expect(text).not.toContain(VALUE);
		expect(emitted.at(-1)).toContain("[secret:API_TOKEN]");
	});

	it("async progress text uses the same accumulated-tail redaction", async () => {
		const dir = mkdtempSync(join(tmpdir(), "musepi-agent-stream-"));
		await new AgentSecretStore(dir).set("API_TOKEN", VALUE, "curl");
		const snapshot = await agentSecretSnapshot(dir, dir);
		const tail = new TailBuffer(64 * 1024);
		const progress: string[] = [];
		const stream = createRedactedTailStreamer(tail, snapshot.redact, text => progress.push(text));

		stream(VALUE.slice(0, SPLIT_AT));
		stream(VALUE.slice(SPLIT_AT));

		for (const text of progress) expect(text).not.toContain(VALUE);
		expect(progress.at(-1)).toBe("[secret:API_TOKEN]");
	});

	it("real bash partial updates never expose a value printed in two writes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "musepi-agent-stream-"));
		await new AgentSecretStore(dir).set("API_TOKEN", VALUE, "curl");
		const tool = new BashTool(makeSession(dir));
		const updates: string[] = [];
		const result = await tool.execute(
			"call-stream",
			{ command: `printf '%s' "${VALUE.slice(0, SPLIT_AT)}"; sleep 0.2; printf '%s' "${VALUE.slice(SPLIT_AT)}"` },
			undefined,
			update => {
				const text = update.content.find(block => block.type === "text")?.text;
				if (typeof text === "string") updates.push(text);
			},
		);

		for (const text of updates) expect(text).not.toContain(VALUE);
		const finalText = result.content.find(block => block.type === "text")?.text ?? "";
		expect(finalText).toContain("[secret:API_TOKEN]");
		expect(finalText).not.toContain(VALUE);
	});
});
