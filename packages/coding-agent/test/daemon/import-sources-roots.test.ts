import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";

/**
 * `import.sources` carries the reference roots a copy will seed, so the picker
 * can warn "adds N more directory(s)" before the user commits.
 *
 * Only Codex records more than one root, so the fixture builds a Codex state
 * database with two threads: one inside a project whose roots name a second
 * directory, one with no project at all. The HOMEdirectory decides which
 * `~/.codex` the store reads, and it is redirected to a temp folder so the real
 * one is never scanned.
 */

let home: string;
let previousHome: string | undefined;
let previousProfile: string | undefined;

const PROJECT_MAIN = "D:\\Work\\Main";
const PROJECT_SHARED = "D:\\Work\\Shared";
const SOLO = "D:\\Solo";

beforeAll(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-import-roots-home-"));
	previousHome = process.env.HOME;
	previousProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;

	const codex = path.join(home, ".codex");
	const sessions = path.join(codex, "sessions");
	fs.mkdirSync(sessions, { recursive: true });
	const multi = path.join(sessions, "rollout-multi.jsonl");
	const solo = path.join(sessions, "rollout-solo.jsonl");
	fs.writeFileSync(
		multi,
		`${JSON.stringify({ type: "session_meta", payload: { id: "multi", cwd: PROJECT_MAIN } })}\n`,
	);
	fs.writeFileSync(solo, `${JSON.stringify({ type: "session_meta", payload: { id: "solo", cwd: SOLO } })}\n`);

	const database = new Database(path.join(codex, "state_5.sqlite"));
	try {
		database.run(
			"CREATE TABLE threads (id TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, cwd TEXT, title TEXT, first_user_message TEXT, project_id TEXT)",
		);
		database.run("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
			"multi",
			multi,
			1_767_225_600,
			1_767_225_660,
			PROJECT_MAIN,
			"Multi-root session",
			"hi",
			"p1",
		]);
		database.run("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
			"solo",
			solo,
			1_767_225_600,
			1_767_225_600,
			SOLO,
			"Single-root session",
			"hi",
			null,
		]);
		database.run(
			"CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, metadata TEXT, position INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)",
		);
		database.run(
			"CREATE TABLE project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY (project_id, position))",
		);
		database.run("INSERT INTO projects VALUES ('p1', 'proj', '{}', 0, 0, 0)");
		database.run("INSERT INTO project_roots VALUES ('p1', 0, ?)", [PROJECT_MAIN]);
		database.run("INSERT INTO project_roots VALUES ('p1', 1, ?)", [PROJECT_SHARED]);
	} finally {
		database.close();
	}
});

afterAll(() => {
	fs.rmSync(home, { recursive: true, force: true });
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	if (previousProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = previousProfile;
});

interface ScannedSource {
	source: string;
	sessions: Array<{ id: string; cwd: string; additionalDirectories?: string[] }>;
}

async function scan(): Promise<ScannedSource[]> {
	const host = {
		cwd: () => home,
		get: () => undefined,
		ensureRegistry: async () => null,
		settings: () => ({ get: () => undefined, getRaw: () => undefined }),
		snapshot: async () => ({ entries: [], state: {} }),
		// DaemonServer wires these on construction; the stub host ignores them.
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	const server = new DaemonServer(host);
	const conn = { id: "test", send: () => {} } as DaemonConnection;
	return (await server.handle("import.sources", { sources: ["codex"] }, conn)) as ScannedSource[];
}

describe("import.sources reference roots", () => {
	it("lists the roots a multi-directory copy will add beside its cwd", async () => {
		const [codex] = await scan();
		const multi = codex?.sessions.find(session => session.id === "multi");

		expect(multi?.cwd).toBe(PROJECT_MAIN);
		expect(multi?.additionalDirectories).toEqual([PROJECT_SHARED]);
	});

	it("omits the field for a session that ran in a single directory", async () => {
		const [codex] = await scan();
		const solo = codex?.sessions.find(session => session.id === "solo");

		expect(solo?.additionalDirectories).toBeUndefined();
	});
});
