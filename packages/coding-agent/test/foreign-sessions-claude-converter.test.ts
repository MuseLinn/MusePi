import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertClaudeSession } from "../src/foreign-sessions/claude-converter.ts";

describe("claude-converter", () => {
	let tempDir: string;
	let targetDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "claude-converter-"));
		targetDir = join(tempDir, "converted");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeClaudeJsonl(lines: string[]): string {
		const path = join(tempDir, "session.jsonl");
		writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
		return path;
	}

	it("converts a simple user message session", () => {
		const src = writeClaudeJsonl([
			JSON.stringify({
				type: "user",
				message: { role: "user", content: [{ type: "text", text: "hello" }] },
				cwd: tempDir,
				timestamp: "2026-07-24T10:00:00.000Z",
				sessionId: "test-session-1",
			}),
			JSON.stringify({
				type: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
				uuid: "assist-uuid",
				timestamp: "2026-07-24T10:00:05.000Z",
			}),
		]);

		const outPath = convertClaudeSession(src, targetDir);

		const content = readFileSync(outPath, "utf-8");
		const lines = content.trim().split("\n");

		expect(lines.length).toBe(3); // header + user + assistant
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.version).toBe(3);
		expect(header.cwd).toBe(tempDir);
	});

	it("preserves content blocks natively (not JSON.stringify)", () => {
		const contentBlock = [{ type: "text", text: "hello world" }];
		const src = writeClaudeJsonl([
			JSON.stringify({
				type: "user",
				message: { role: "user", content: contentBlock },
				cwd: tempDir,
				timestamp: "2026-07-24T10:00:00.000Z",
				sessionId: "test-content",
			}),
		]);

		const outPath = convertClaudeSession(src, targetDir);
		const content = readFileSync(outPath, "utf-8");
		const lines = content.trim().split("\n");
		const msg = JSON.parse(lines[1]);

		expect(Array.isArray(msg.message.content)).toBe(true);
		expect(msg.message.content[0].type).toBe("text");
		expect(msg.message.content[0].text).toBe("hello world");
	});

	it("generates a valid header with session id", () => {
		const src = writeClaudeJsonl([
			JSON.stringify({
				type: "user",
				message: { role: "user", content: [{ type: "text", text: "test" }] },
				sessionId: "my-session-id",
				cwd: "/tmp",
				timestamp: "2026-07-24T10:00:00.000Z",
			}),
		]);

		const outPath = convertClaudeSession(src, targetDir);
		const content = readFileSync(outPath, "utf-8");
		const header = JSON.parse(content.trim().split("\n")[0]);

		expect(header.id).toBe("my-session-id");
		expect(header.type).toBe("session");
		expect(header.version).toBe(3);
	});

	it("processes assistant-only messages into entries", () => {
		const src = writeClaudeJsonl([
			JSON.stringify({
				type: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
				timestamp: "2026-07-24T10:00:00.000Z",
			}),
		]);

		const outPath = convertClaudeSession(src, targetDir);
		const content = readFileSync(outPath, "utf-8");
		const lines = content.trim().split("\n");
		expect(lines.length).toBe(2); // header + assistant message
	});
});
