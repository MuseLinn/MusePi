/**
 * Subagent transcript resolution: the registry only holds a ref while the
 * child is live, so a finished one-shot subagent is resolvable only through
 * its parent's product directory. These cases pin the three ids a caller can
 * hold — file name / agent id, child session header id, and the parent's
 * session file — plus the traversal guard.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	isSubagentTranscriptOf,
	readTranscriptSessionId,
	resolveSubagentTranscript,
	sessionProductDir,
	transcriptAgentId,
} from "../../src/daemon/subagent-transcripts";

const PARENT_FILE_BASE = "2026-11-13T16-25-42-385Z_01a1d5ba-a8f1-71f3-a247-6688e81c9d9b";
const CHILD_SESSION_ID = "01a1d5bb-6329-776e-950f-e6ab1609964b";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-subagent-transcripts-"));
	dirs.push(dir);
	return dir;
}

function transcript(id: string, agent?: string): string {
	return `${[
		JSON.stringify({ type: "session", version: 3, id, cwd: "/repo", timestamp: "2026-11-13T16:26:30.057Z" }),
		...(agent ? [JSON.stringify({ type: "session_init", agent })] : []),
		JSON.stringify({ type: "message", message: { role: "user", content: "collect the list" } }),
	].join("\n")}\n`;
}

/** Parent transcript + its product directory, as the task executor writes it. */
function parentWithChildren(): { parentFile: string; productDir: string } {
	const root = scratch();
	const parentFile = path.join(root, `${PARENT_FILE_BASE}.jsonl`);
	fs.writeFileSync(parentFile, transcript("01a1d5ba-a8f1-71f3-a247-6688e81c9d9b"));
	const productDir = sessionProductDir(parentFile) as string;
	fs.mkdirSync(productDir, { recursive: true });
	fs.writeFileSync(path.join(productDir, "ListExtensionDirs.jsonl"), transcript(CHILD_SESSION_ID, "sonic"));
	fs.writeFileSync(path.join(productDir, "__advisor.jsonl"), transcript("01a1d5be-advisor"));
	return { parentFile, productDir };
}

describe("transcript identity", () => {
	test("product directory is the session file without its extension", () => {
		expect(sessionProductDir(path.join("a", "b", "session.jsonl"))).toBe(path.join("a", "b", "session"));
		expect(sessionProductDir(path.join("a", "b", "session"))).toBeNull();
		expect(sessionProductDir(null)).toBeNull();
	});

	test("agent id is the transcript file name", () => {
		expect(transcriptAgentId(path.join("/a", "ListExtensionDirs.jsonl"))).toBe("ListExtensionDirs");
	});

	test("only descendants count as subagent transcripts", () => {
		const { parentFile, productDir } = parentWithChildren();
		expect(isSubagentTranscriptOf(parentFile, path.join(productDir, "ListExtensionDirs.jsonl"))).toBe(true);
		expect(isSubagentTranscriptOf(parentFile, parentFile)).toBe(false);
		expect(isSubagentTranscriptOf(parentFile, path.join(path.dirname(parentFile), "other.jsonl"))).toBe(false);
	});
});

describe("resolveSubagentTranscript", () => {
	test("finds a finished child by agent id after the registry forgot it", async () => {
		const { parentFile, productDir } = parentWithChildren();
		expect(await resolveSubagentTranscript(parentFile, "ListExtensionDirs")).toBe(
			path.join(productDir, "ListExtensionDirs.jsonl"),
		);
	});

	test("finds the same file by its child session id", async () => {
		const { parentFile, productDir } = parentWithChildren();
		expect(await resolveSubagentTranscript(parentFile, CHILD_SESSION_ID)).toBe(
			path.join(productDir, "ListExtensionDirs.jsonl"),
		);
	});

	test("walks one generation down for a nested grandchild", async () => {
		const { parentFile, productDir } = parentWithChildren();
		const nested = path.join(productDir, "ListExtensionDirs");
		fs.mkdirSync(nested, { recursive: true });
		const grandchild = path.join(nested, "SynthesizeReport.jsonl");
		fs.writeFileSync(grandchild, transcript("01a1d5cc-0000-7000-8000-000000000000"));
		expect(await resolveSubagentTranscript(parentFile, "SynthesizeReport")).toBe(grandchild);
	});

	test("refuses ids that would escape the product directory", async () => {
		const { parentFile } = parentWithChildren();
		expect(await resolveSubagentTranscript(parentFile, "../ListExtensionDirs")).toBeNull();
		expect(await resolveSubagentTranscript(parentFile, "..")).toBeNull();
		expect(await resolveSubagentTranscript(parentFile, "sub/ListExtensionDirs")).toBeNull();
	});

	test("missing child resolves to null instead of guessing", async () => {
		const { parentFile } = parentWithChildren();
		expect(await resolveSubagentTranscript(parentFile, "NoSuchAgent")).toBeNull();
		expect(await resolveSubagentTranscript(null, "ListExtensionDirs")).toBeNull();
	});

	test("reads the child session id from the transcript header", async () => {
		const { productDir } = parentWithChildren();
		expect(await readTranscriptSessionId(path.join(productDir, "ListExtensionDirs.jsonl"))).toBe(CHILD_SESSION_ID);
		expect(await readTranscriptSessionId(path.join(productDir, "missing.jsonl"))).toBeNull();
	});
});
