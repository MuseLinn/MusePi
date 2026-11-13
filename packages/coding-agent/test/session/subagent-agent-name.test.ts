/**
 * Real transcripts write `session_init` as one record carrying the full system
 * prompt (~120 KB in production) with `agent` as its last field. A list-scan
 * prefix cannot reach it, so the fallback read must cover the whole record —
 * and must not mistake the word inside prompt text for the field.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readSubagentAgentName, resetSubagentAgentNameCache } from "../../src/session/subagent-agent-name";

const dirs: string[] = [];
beforeEach(() => resetSubagentAgentNameCache());

function scratch(file = "child.jsonl"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-agent-name-"));
	dirs.push(dir);
	return path.join(dir, file);
}

function sessionInit(agent: string, promptBytes: number): string {
	const prompt = `{"type":"session_init","id":"i1","parentId":null,"timestamp":"2026-11-13T16:26:30.657Z","systemPrompt":"${"<conventions> agent guidance. ".repeat(Math.ceil(promptBytes / 30))}","agent":"${agent}"}`;
	return prompt;
}

describe("readSubagentAgentName", () => {
	test("reads a name that sits past every prefix window", async () => {
		const file = scratch();
		const record = sessionInit("sonic", 120_000);
		expect(record.length).toBeGreaterThan(100_000);
		fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: "s", cwd: "/repo" })}\n${record}\n`);
		expect(await readSubagentAgentName(file)).toBe("sonic");
	});

	test("ignores the word inside prompt text", async () => {
		const file = scratch();
		fs.writeFileSync(
			file,
			`${JSON.stringify({ type: "message", message: { role: "user", content: '"agent":"impostor"' } })}\n${JSON.stringify({ type: "session_init", agent: "task" })}\n`,
		);
		expect(await readSubagentAgentName(file)).toBe("task");
	});

	test("no session_init means no name", async () => {
		const file = scratch();
		fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: "s" })}\n`);
		expect(await readSubagentAgentName(file)).toBeNull();
	});

	test("a child whose init lands later is picked up once the file grows", async () => {
		const file = scratch();
		fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: "s" })}\n`);
		expect(await readSubagentAgentName(file)).toBeNull();
		fs.appendFileSync(file, `${JSON.stringify({ type: "session_init", agent: "scout" })}\n`);
		expect(await readSubagentAgentName(file)).toBe("scout");
	});
});
