/**
 * Contracts for `artifact://<id>` (caller-scoped) and
 * `artifact://<sessionId>/<id>` (session-pinned):
 *
 * - The bare form keeps resolving through the registered artifacts dirs.
 * - The session form resolves inside the named session's artifacts dir, which
 *   may sit one workspace-slug below the sessions root or be registered live.
 * - Subagent outputs one level inside the session dir are reachable.
 * - Unknown sessions and traversal-shaped session ids fail closed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ArtifactProtocolHandler } from "@musepi/pi-coding-agent/internal-urls/artifact-protocol";
import { parseInternalUrl } from "@musepi/pi-coding-agent/internal-urls/parse";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@musepi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@musepi/pi-coding-agent/registry/agent-registry";
import { getSessionsDir } from "@musepi/pi-utils";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

describe("artifact:// protocol", () => {
	let isolatedDir: string;
	const handler = new ArtifactProtocolHandler();

	beforeAll(async () => {
		isolatedDir = await isolateAgentDirForTest("artifact-protocol-");
	}, 30000);

	afterAll(async () => {
		await restoreAgentDirForTest(isolatedDir);
	}, 30000);

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
	});

	function sessionDir(...segments: string[]): string {
		return path.join(getSessionsDir(), ...segments);
	}

	async function writeArtifact(dir: string, name: string, content: string): Promise<string> {
		await fs.mkdir(dir, { recursive: true });
		const filePath = path.join(dir, name);
		await Bun.write(filePath, content);
		return filePath;
	}

	async function resolveError(rawUrl: string): Promise<Error> {
		const error = await handler.resolve(parseInternalUrl(rawUrl)).then(
			() => null,
			err => err as Error,
		);
		if (!error) throw new Error(`Expected ${rawUrl} to fail`);
		return error;
	}

	it("keeps the bare numeric form on the registered artifacts dirs", async () => {
		const dir = path.join(isolatedDir, "caller-artifacts-legacy");
		await writeArtifact(dir, "0.bash.log", "legacy output\n");
		const unregister = registerArtifactsDir(dir);
		try {
			const resource = await handler.resolve(parseInternalUrl("artifact://0"));
			expect(resource.content).toBe("legacy output\n");
			expect(resource.sourcePath).toBe(path.join(dir, "0.bash.log"));
		} finally {
			unregister();
		}
	});

	it("keeps the bare form's availability error when the id is missing", async () => {
		const dir = path.join(isolatedDir, "caller-artifacts-available");
		await writeArtifact(dir, "2.bash.log", "x");
		const unregister = registerArtifactsDir(dir);
		try {
			const error = await resolveError("artifact://7");
			expect(error.message).toBe("Artifact 7 not found. Available: 2");
		} finally {
			unregister();
		}
	});

	it("resolves a session-pinned URL from the session's own dir", async () => {
		const dir = sessionDir("session-a");
		await writeArtifact(dir, "1.bash.log", "named output\n");

		const resource = await handler.resolve(parseInternalUrl("artifact://session-a/1"));

		expect(resource.content).toBe("named output\n");
		expect(resource.sourcePath).toBe(path.join(dir, "1.bash.log"));
	});

	it("finds a parked session one workspace slug below the sessions root", async () => {
		const dir = sessionDir("--tmp-project--", "2026-01-01T00-00-00-000Z_abc");
		await writeArtifact(dir, "4.mcp.log", "parked output\n");

		const resource = await handler.resolve(parseInternalUrl("artifact://2026-01-01T00-00-00-000Z_abc/4"));

		expect(resource.content).toBe("parked output\n");
		expect(resource.sourcePath).toBe(path.join(dir, "4.mcp.log"));
	});

	it("finds subagent artifacts one level inside the session dir", async () => {
		const dir = sessionDir("session-a", "Sub1");
		await writeArtifact(dir, "3.bash.log", "subagent output\n");

		const resource = await handler.resolve(parseInternalUrl("artifact://session-a/3"));

		expect(resource.content).toBe("subagent output\n");
		expect(resource.sourcePath).toBe(path.join(dir, "3.bash.log"));
	});

	it("resolves the same id to each session's own file", async () => {
		const workspace = sessionDir("workspace");
		await writeArtifact(path.join(workspace, "alpha"), "1.bash.log", "from alpha\n");
		await writeArtifact(path.join(workspace, "beta"), "1.bash.log", "from beta\n");

		const fromAlpha = await handler.resolve(parseInternalUrl("artifact://alpha/1"));
		const fromBeta = await handler.resolve(parseInternalUrl("artifact://beta/1"));

		expect(fromAlpha.content).toBe("from alpha\n");
		expect(fromBeta.content).toBe("from beta\n");
		expect(fromAlpha.sourcePath).not.toBe(fromBeta.sourcePath);
	});

	it("reports an unknown session without leaking another session's ids", async () => {
		await writeArtifact(sessionDir("session-a"), "1.bash.log", "x");

		const error = await resolveError("artifact://missing-session/1");

		expect(error.message).toBe("Artifact session missing-session not found");
	});

	it("lists only the named session's ids when its artifact is missing", async () => {
		await writeArtifact(sessionDir("ids-session-a"), "1.bash.log", "a");
		await writeArtifact(sessionDir("ids-session-b"), "9.bash.log", "b");

		const error = await resolveError("artifact://ids-session-a/7");

		expect(error.message).toContain("Artifact 7 not found in session ids-session-a");
		expect(error.message).toContain("Available: 1");
		expect(error.message).not.toContain("9");
	});

	it("rejects traversal-shaped session ids before joining a path", async () => {
		for (const raw of ["artifact://../etc/1", "artifact://./1", "artifact://.hidden/1", "artifact://a%2Fb/1"]) {
			const error = await resolveError(raw);
			expect(error.message).toContain("Invalid artifact session ID");
		}
	});

	it("rejects a non-numeric artifact segment in the session form", async () => {
		const error = await resolveError("artifact://session-a/1:raw");
		expect(error.message).toContain("numeric artifact ID");
	});
});
