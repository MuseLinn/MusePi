/**
 * End-to-end subagent session reads on the real host: disk transcripts in the
 * isolated agent dir → `DaemonSessionHost.knownSessions` → `session.agents` /
 * `agents.transcript` through `DaemonServer.handle`.
 *
 * This is the join the GUI depends on and unit tests cannot cover: the child
 * is not in the registry (finished one-shot), its `session_init` is bigger than
 * any list prefix, and the roster must still name the agent and open its
 * transcript from the parent session id.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { type DaemonConnection, DaemonServer } from "../../src/daemon/server";
import { DaemonSessionHost } from "../../src/daemon/session-host";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

const PARENT_ID = "01a1d5ba-a8f1-71f3-a247-6688e81c9d9b";
const PARENT_BASE = `2026-11-13T16-25-42-385Z_${PARENT_ID}`;
const CHILD_A = { id: "01a1d5bb-6329-776e-950f-e6ab1609964b", file: "ListExtensionDirs", agent: "sonic" };
const CHILD_B = { id: "01a1d5bb-f3d8-727c-ab1d-cec2b1954d1c", file: "SynthesizeReport", agent: "task" };

let agentDir: string;
let server: DaemonServer;

/** Production shape: the title slot, then `session_init` with a prompt-sized
 *  body and `agent` last. */
function transcript(id: string, agent?: string, prompt?: string): string {
	const init = agent
		? JSON.stringify({
				type: "session_init",
				id: "f249d78e",
				parentId: "680f50e2",
				timestamp: "2026-11-13T16:26:30.657Z",
				systemPrompt: `<conventions>${" agent guidance.".repeat(8_000)}</conventions>`,
				agent,
			})
		: null;
	return `${[
		JSON.stringify({ type: "title", v: 1, title: id.slice(0, 8), source: "auto", pad: "  " }),
		JSON.stringify({ type: "session", version: 3, id, cwd: "/repo", timestamp: "2026-11-13T16:26:30.057Z" }),
		...(init ? [init] : []),
		JSON.stringify({ type: "message", message: { role: "user", content: prompt ?? `${id} assignment` } }),
	].join("\n")}\n`;
}

function conn(): DaemonConnection {
	return { id: "test" } as unknown as DaemonConnection;
}

beforeAll(async () => {
	agentDir = await isolateAgentDirForTest("subagent-session-rpc-");
	const root = path.join(agentDir, "sessions", "proj");
	const productDir = path.join(root, PARENT_BASE);
	await fsp.mkdir(productDir, { recursive: true });
	await fsp.writeFile(path.join(root, `${PARENT_BASE}.jsonl`), transcript(PARENT_ID));
	await fsp.writeFile(
		path.join(productDir, `${CHILD_A.file}.jsonl`),
		transcript(CHILD_A.id, CHILD_A.agent, "collect the extension list"),
	);
	await fsp.writeFile(
		path.join(productDir, `${CHILD_B.file}.jsonl`),
		transcript(CHILD_B.id, CHILD_B.agent, "synthesize the report"),
	);
	server = new DaemonServer(new DaemonSessionHost());
}, 30_000);

afterAll(async () => {
	await restoreAgentDirForTest(agentDir);
}, 30_000);

interface RosterRow {
	id: string;
	sessionId: string;
	displayName: string;
	agentName?: string | null;
	kind: string;
	status: string;
	activity?: string | null;
	hasSessionFile: boolean;
}

async function roster(): Promise<RosterRow[]> {
	const result = (await server.handle("session.agents", { sessionId: PARENT_ID }, conn())) as { agents: RosterRow[] };
	return result.agents;
}

describe("subagent sessions on real transcripts", () => {
	it("names each finished child by its agent and child session id", async () => {
		const agents = await roster();
		expect(agents).toHaveLength(2);
		const byId = new Map(agents.map(agent => [agent.id, agent]));
		expect(byId.get(CHILD_A.file)).toMatchObject({
			sessionId: CHILD_A.id,
			displayName: "sonic",
			agentName: "sonic",
			kind: "sub",
			status: "idle",
			hasSessionFile: true,
		});
		expect(byId.get(CHILD_B.file)).toMatchObject({
			sessionId: CHILD_B.id,
			displayName: "task",
			agentName: "task",
		});
	});

	it("reads a child transcript from the parent session id", async () => {
		const result = (await server.handle(
			"agents.transcript",
			{ agentId: CHILD_A.file, parentSessionId: PARENT_ID, fromByte: 0 },
			conn(),
		)) as { text: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.text).toContain("collect the extension list");
	});
});
