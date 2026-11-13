/**
 * `session_init.agent` is the only thing that answers "which subagent is this
 * child session?" — the child's title slot and file name are instance ids.
 * It has to survive the disk scan into `knownSessions`, because both the
 * sidebar badge and the agents roster read it from there.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { DaemonSessionHost, JOURNAL_DIR } from "../../src/daemon/session-host";
import { ViewStore, viewStorePath } from "../../src/daemon/view-store";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

const PARENT_ID = "01a1d5ba-a8f1-71f3-a247-6688e81c9d9b";
const CHILD_ID = "01a1d5bb-6329-776e-950f-e6ab1609964b";
const CHILD_BASE = "ListExtensionDirs";
const PARENT_BASE = `2026-11-13T16-25-42-385Z_${PARENT_ID}`;

let agentDir: string;
let host: DaemonSessionHost;
let store: ViewStore;

function transcript(id: string, agent?: string): string {
	return `${[
		JSON.stringify({
			type: "session",
			version: 3,
			id,
			cwd: "/repo",
			timestamp: "2026-11-13T16:26:30.057Z",
			title: CHILD_BASE,
			titleSource: "auto",
		}),
		...(agent ? [JSON.stringify({ type: "session_init", agent })] : []),
		JSON.stringify({ type: "message", message: { role: "user", content: "collect the list" } }),
	].join("\n")}\n`;
}

beforeAll(async () => {
	agentDir = await isolateAgentDirForTest("subagent-agent-name-");
	const root = path.join(agentDir, "sessions", "proj");
	await fsp.mkdir(path.join(root, PARENT_BASE), { recursive: true });
	await fsp.writeFile(path.join(root, `${PARENT_BASE}.jsonl`), transcript(PARENT_ID));
	await fsp.writeFile(path.join(root, PARENT_BASE, `${CHILD_BASE}.jsonl`), transcript(CHILD_ID, "sonic"));
	host = new DaemonSessionHost();
	store = new ViewStore(viewStorePath(JOURNAL_DIR));
}, 30_000);

afterAll(async () => {
	try {
		store.remove(CHILD_ID);
	} catch {
		// No row written by this suite.
	}
	await restoreAgentDirForTest(agentDir);
}, 30_000);

describe("knownSessions exposes the subagent definition name", () => {
	it("child transcript row carries agentName + subagent + parentId", async () => {
		const rows = await host.knownSessions();
		const child = rows.find(r => r.sessionId === CHILD_ID);
		expect(child).toBeDefined();
		expect(child?.subagent).toBe(true);
		expect(child?.parentId).toBe(PARENT_ID);
		expect(child?.agentName).toBe("sonic");
		// The instance title is what the row shows; the agent name is separate.
		expect(child?.title).toBe(CHILD_BASE);
	});

	it("the parent row itself is not a subagent and carries no agentName", async () => {
		const rows = await host.knownSessions();
		const parent = rows.find(r => r.sessionId === PARENT_ID);
		expect(parent).toBeDefined();
		expect(parent?.subagent ?? false).toBe(false);
		expect(parent?.agentName).toBeUndefined();
	});
});
