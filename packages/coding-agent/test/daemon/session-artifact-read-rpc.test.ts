import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";

const conn = { id: "test" } as unknown as DaemonConnection;
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function artifactFile(contents: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-artifact-rpc-"));
	tempDirs.push(dir);
	const filePath = path.join(dir, "1.bash-original.txt");
	await fs.writeFile(filePath, contents);
	return filePath;
}

function createServer(artifacts: Record<string, Record<string, string | null>>): DaemonServer {
	const host = {
		cwd: () => "/tmp",
		get: (sessionId: string) => {
			const sessionArtifacts = artifacts[sessionId];
			if (!sessionArtifacts) return undefined;
			return {
				sessionId,
				agentSession: {
					sessionManager: {
						getArtifactPath: async (id: string) => sessionArtifacts[id] ?? null,
					},
				},
			};
		},
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	return new DaemonServer(host);
}

describe("session.artifactRead RPC", () => {
	test("returns the original text without exposing its backing path", async () => {
		const filePath = await artifactFile("raw output\nline two\n");
		const server = createServer({ s1: { "1": filePath } });
		const result = await server.handle("session.artifactRead", { sessionId: "s1", id: "1" }, conn);
		expect(result).toEqual({ text: "raw output\nline two\n", truncated: false, totalBytes: 20 });
		expect(result).not.toHaveProperty("path");
	});

	test("caps previews at 8 MiB and reports the original byte size", async () => {
		const max = 8 * 1024 * 1024;
		const filePath = await artifactFile("x".repeat(max + 10));
		const server = createServer({ s1: { "1": filePath } });
		const result = (await server.handle("session.artifactRead", { sessionId: "s1", id: "1" }, conn)) as {
			text: string;
			truncated: boolean;
			totalBytes: number;
		};
		expect(result.text).toHaveLength(max);
		expect(result.truncated).toBe(true);
		expect(result.totalBytes).toBe(max + 10);
	});

	test("resolves a reused numeric id only within the requested session", async () => {
		const first = await artifactFile("first session");
		const second = await artifactFile("second session");
		const server = createServer({ s1: { "1": first }, s2: { "1": second } });
		expect(await server.handle("session.artifactRead", { sessionId: "s2", id: "1" }, conn)).toMatchObject({
			text: "second session",
		});
	});

	test("rejects malformed ids and missing artifacts explicitly", async () => {
		const filePath = await artifactFile("raw");
		const server = createServer({ s1: { "1": filePath } });
		await expect(server.handle("session.artifactRead", { sessionId: "s1", id: "1:raw" }, conn)).rejects.toThrow(
			"numeric",
		);
		await expect(server.handle("session.artifactRead", { sessionId: "s1", id: "9" }, conn)).rejects.toThrow(
			"Artifact 9 not found",
		);
	});

	test("rejects an unknown session", async () => {
		const server = createServer({});
		await expect(server.handle("session.artifactRead", { sessionId: "missing", id: "1" }, conn)).rejects.toThrow(
			"Unknown session: missing",
		);
	});
});
