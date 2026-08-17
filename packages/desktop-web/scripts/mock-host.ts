/**
 * Offline mock collab host: starts the local relay, opens a room as host, and
 * serves the canned fixture session to any desktop-web guest that joins.
 *
 *   bun scripts/mock-host.ts [--port 7466]
 *
 * Replays a scripted streaming turn on every guest prompt, ticks subagent
 * progress on the bus every 2s, and answers fetch-transcript with byte slices
 * of the fixture JSONL — exactly the frames a real `omp /collab` host emits.
 */

import {
	COLLAB_PROTO,
	formatCollabLink,
	generateRoomId,
	generateRoomKey,
	importRoomKey,
	open,
	packEnvelope,
	seal,
	unpackEnvelope,
} from "@musepi/collab-proto";
import type { AgentSnapshot, HostFrame, SessionEntry, SessionState, WireFrame, WorkspaceEntry } from "@musepi/pi-wire";
import {
	fixtureAgents,
	fixtureEntries,
	fixtureHeader,
	fixtureModel,
	HOST_DISPLAY_NAME,
	makeProbeProgress,
	makeScriptedTurn,
	type ScriptedStep,
	subagentTranscriptJsonl,
} from "./fixture";
import { startLocalRelay } from "./local-relay";

const DEFAULT_PORT = 7466;
const STEP_INTERVAL_MS = 40;
const TICK_INTERVAL_MS = 2_000;
const AGENTS_SNAPSHOT_EVERY = 5;

function parsePort(argv: string[]): number {
	let raw: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--port") raw = argv[i + 1];
		else if (arg.startsWith("--port=")) raw = arg.slice("--port=".length);
	}
	if (raw === undefined) return DEFAULT_PORT;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		console.error(`mock-host: invalid --port ${raw}`);
		process.exit(1);
	}
	return port;
}

const port = parsePort(Bun.argv.slice(2));
const relay = startLocalRelay(port);
const roomId = generateRoomId();
const rawKey = generateRoomKey();
const key = await importRoomKey(rawKey);
const link = formatCollabLink(relay.url, roomId, rawKey);

// ── mutable session state ────────────────────────────────────────────────────

const entries: SessionEntry[] = [...fixtureEntries];
const agents: AgentSnapshot[] = fixtureAgents.map(agent => ({ ...agent }));
const peers = new Map<number, string>();
const transcriptBytes = new TextEncoder().encode(subagentTranscriptJsonl);
const transcriptDecoder = new TextDecoder();

let lastEntryId: string | null = entries[entries.length - 1]?.id ?? null;
let streaming = false;
let queuedPrompts = 0;
let turnSeq = 0;
let liveEntrySeq = 0;
let replayQueue: ScriptedStep[] = [];
let replayTimer: Timer | null = null;
let tick = 0;
let shuttingDown = false;

// ── sealed transport (order-preserving, mirrors relay-client) ────────────────

const ws = new WebSocket(`${relay.url}/r/${roomId}?role=host`);
ws.binaryType = "arraybuffer";

let sendChain: Promise<void> = Promise.resolve();
let recvChain: Promise<void> = Promise.resolve();

/** Seal and send a frame; peerId 0 broadcasts, N targets that guest. */
function sendFrame(frame: HostFrame, targetPeer = 0): void {
	sendChain = sendChain
		.then(async () => {
			if (ws.readyState !== WebSocket.OPEN) return;
			const sealed = await seal(key, frame);
			ws.send(packEnvelope(targetPeer, sealed));
		})
		.catch((err: unknown) => {
			console.error("mock-host: send failed:", err);
		});
}

function buildState(): SessionState {
	const participants: SessionState["participants"] = [{ name: HOST_DISPLAY_NAME, role: "host" }];
	for (const name of peers.values()) participants.push({ name, role: "guest" });
	const tokens = 51_000 + entries.length * 120;
	return {
		isStreaming: streaming,
		queuedMessageCount: queuedPrompts,
		sessionName: fixtureHeader.title,
		cwd: fixtureHeader.cwd,
		model: fixtureModel,
		thinkingLevel: "medium",
		contextUsage: {
			tokens,
			contextWindow: fixtureModel.contextWindow,
			percent:
				fixtureModel.contextWindow !== null && fixtureModel.contextWindow > 0
					? (tokens / fixtureModel.contextWindow) * 100
					: null,
		},
		participants,
	};
}

function broadcastState(): void {
	sendFrame({ t: "state", state: buildState() });
}

function appendEntry(entry: SessionEntry): void {
	entries.push(entry);
	lastEntryId = entry.id;
	sendFrame({ t: "entry", entry });
}

function notice(level: "info" | "warning" | "error", message: string): void {
	sendFrame({ t: "event", event: { type: "notice", level, message, source: "collab" } });
}

// ── scripted turn replay ─────────────────────────────────────────────────────

function startReplay(): void {
	turnSeq++;
	replayQueue = makeScriptedTurn(turnSeq, lastEntryId);
	scheduleStep();
}

function scheduleStep(): void {
	replayTimer = setTimeout(() => {
		replayTimer = null;
		const step = replayQueue.shift();
		if (step) applyStep(step);
		if (replayQueue.length > 0) {
			scheduleStep();
			return;
		}
		if (queuedPrompts > 0) {
			queuedPrompts--;
			startReplay();
		}
	}, STEP_INTERVAL_MS);
}

function applyStep(step: ScriptedStep): void {
	switch (step.kind) {
		case "event":
			sendFrame({ t: "event", event: step.event });
			break;
		case "entry":
			appendEntry(step.entry);
			break;
		case "state":
			streaming = step.streaming;
			broadcastState();
			break;
	}
}

function cancelReplay(): void {
	if (replayTimer !== null) {
		clearTimeout(replayTimer);
		replayTimer = null;
	}
	replayQueue = [];
}

// ── guest frame handling ─────────────────────────────────────────────────────

function peerName(fromPeer: number): string {
	return peers.get(fromPeer) ?? `guest-${fromPeer}`;
}

function handleHello(name: string, proto: number, fromPeer: number): void {
	if (proto !== COLLAB_PROTO) {
		sendFrame(
			{ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}` },
			fromPeer,
		);
		return;
	}
	const cleanName = name.trim().slice(0, 64) || `guest-${fromPeer}`;
	peers.set(fromPeer, cleanName);
	sendFrame(
		{
			t: "welcome",
			proto: COLLAB_PROTO,
			header: fixtureHeader,
			state: buildState(),
			agents: agents.map(agent => ({ ...agent })),
			entryCount: entries.length,
		},
		fromPeer,
	);
	sendFrame({ t: "snapshot-chunk", entries: [...entries], final: true }, fromPeer);
	console.log(`mock-host: ${cleanName} joined (peer ${fromPeer})`);
	broadcastState();
}

function handlePrompt(text: string, fromPeer: number): void {
	liveEntrySeq++;
	appendEntry({
		id: `live-${liveEntrySeq}`,
		parentId: lastEntryId,
		timestamp: new Date().toISOString(),
		type: "custom_message",
		customType: "collab-prompt",
		content: text,
		details: { from: peerName(fromPeer) },
		display: true,
	});
	if (replayTimer !== null || replayQueue.length > 0) {
		queuedPrompts++;
		broadcastState();
		return;
	}
	startReplay();
}

function handleAbort(fromPeer: number): void {
	const wasReplaying = replayTimer !== null || replayQueue.length > 0;
	cancelReplay();
	queuedPrompts = 0;
	notice("info", `${peerName(fromPeer)} interrupted`);
	if (wasReplaying) sendFrame({ t: "event", event: { type: "agent_end" } });
	streaming = false;
	broadcastState();
}

function handleAgentCmd(cmd: string, agentId: string, fromPeer: number): void {
	notice("info", `${peerName(fromPeer)} sent agent-cmd ${cmd} → ${agentId}`);
}

function handleFetchTranscript(reqId: number, fromByte: number, fromPeer: number): void {
	const total = transcriptBytes.byteLength;
	const start = Math.max(0, Math.min(fromByte, total));
	const text = start >= total ? "" : transcriptDecoder.decode(transcriptBytes.subarray(start));
	// We always serve to EOF, so the next offset base is the full size.
	sendFrame({ t: "transcript", reqId, text, newSize: total }, fromPeer);
}

// ── guest RPC (board / cron / workspace / fs) ───────────────────────────────

const mockBoards = [
	{
		id: "board-1",
		title: "仪表盘",
		widgets: [
			{ id: "w1", type: "clock", title: "Clock", data: { market: "cn" }, pos: { x: 0, y: 0, w: 2, h: 1 } },
			{
				id: "w2",
				type: "metric",
				title: "Metric",
				data: { label: "metric", value: 4200, delta: 0.12 },
				pos: { x: 2, y: 0, w: 2, h: 1 },
			},
		],
	},
	{
		id: "board-2",
		title: "项目",
		builtin: true,
		widgets: [
			{ id: "w3", type: "todo", title: "Todo", data: { items: [{ done: false, text: "设计评审" }] }, pos: { x: 0, y: 0, w: 2, h: 2 } },
		],
	},
];
const mockCronTasks = [
	{
		id: "cron-1",
		name: "每日晨报",
		enabled: true,
		schedule: { kind: "daily", time: "09:00", timezone: "Asia/Shanghai" },
		prompt: "生成今日晨报",
		cwd: "/mock",
		state: { createdAt: Date.now() - 86400_000, lastRunAt: Date.now() - 3600_000, lastStatus: "success" },
	},
	{
		id: "cron-2",
		name: "每周回顾",
		enabled: false,
		schedule: { kind: "weekly", weekdays: [5], time: "18:00" },
		prompt: "写本周工作回顾",
		cwd: "/mock",
		state: { createdAt: Date.now() - 7 * 86400_000 },
	},
];
const mockCronRuns = [
	{ id: "run-1", taskId: "cron-1", startedAt: Date.now() - 3600_000, finishedAt: Date.now() - 3599_000, status: "success" },
	{ id: "run-2", taskId: "cron-1", startedAt: Date.now() - 2 * 3600_000, finishedAt: Date.now() - 2 * 3600_000 + 40_000, status: "success" },
];
const mockTreeEntries: WorkspaceEntry[] = [
	{ name: "src", path: "/mock/src", isDir: true, size: 0, mtime: Date.now(), depth: 0 },
	{ name: "hello.ts", path: "/mock/src/hello.ts", isDir: false, size: 96, mtime: Date.now(), depth: 1 },
	{ name: "index.ts", path: "/mock/src/index.ts", isDir: false, size: 210, mtime: Date.now(), depth: 1 },
	{ name: "README.md", path: "/mock/README.md", isDir: false, size: 480, mtime: Date.now(), depth: 0 },
];

function rpcOk(reqId: number, data: unknown, fromPeer: number): void {
	sendFrame({ t: "rpc-result", reqId, ok: true, data }, fromPeer);
}

function rpcErr(reqId: number, error: string, fromPeer: number): void {
	sendFrame({ t: "rpc-result", reqId, ok: false, error }, fromPeer);
}

function handleRpcRequest(reqId: number, method: string, params: unknown, fromPeer: number): void {
	const p = (params ?? {}) as Record<string, unknown>;
	try {
		switch (method) {
			case "board.list":
				rpcOk(reqId, { boards: mockBoards }, fromPeer);
				break;
			case "board.save": {
				const boards = (p.boards as typeof mockBoards) ?? [];
				mockBoards.splice(0, mockBoards.length, ...boards);
				rpcOk(reqId, { ok: true }, fromPeer);
				break;
			}
			case "cron.list":
				rpcOk(reqId, { tasks: mockCronTasks, runs: mockCronRuns }, fromPeer);
				break;
			case "cron.upsert": {
				const task = p.task as (typeof mockCronTasks)[number];
				const idx = mockCronTasks.findIndex(t => t.id === task.id);
				if (idx >= 0) mockCronTasks[idx] = task;
				else mockCronTasks.push(task);
				rpcOk(reqId, { tasks: mockCronTasks, task }, fromPeer);
				break;
			}
			case "cron.delete": {
				const id = String(p.id);
				const idx = mockCronTasks.findIndex(t => t.id === id);
				if (idx >= 0) mockCronTasks.splice(idx, 1);
				rpcOk(reqId, { tasks: mockCronTasks }, fromPeer);
				break;
			}
			case "cron.toggle": {
				const id = String(p.id);
				const task = mockCronTasks.find(t => t.id === id);
				if (task) task.enabled = !task.enabled;
				rpcOk(reqId, { tasks: mockCronTasks }, fromPeer);
				break;
			}
			case "workspace.tree":
				rpcOk(reqId, { rootPath: "/mock", truncated: false, entries: mockTreeEntries }, fromPeer);
				break;
			case "fs.read": {
				const path = String(p.path ?? "");
				const size = mockFileSizes.get(path);
				if (size === undefined) {
					rpcErr(reqId, `ENOENT: no such file ${path}`, fromPeer);
					break;
				}
				const text = mockFileTexts.get(path) ?? "";
				rpcOk(
					reqId,
					{ base64: Buffer.from(text).toString("base64"), size: size, mime: "text/plain", error: undefined },
					fromPeer,
				);
				break;
			}
			case "fs.write": {
				const path = String(p.path ?? "");
				const content = String(p.content ?? "");
				mockFileTexts.set(path, content);
				mockFileSizes.set(path, content.length);
				const parts = path.split("/").filter(Boolean);
				const name = parts.at(-1) ?? path;
				if (!mockTreeEntries.some(e => e.path === path)) {
					mockTreeEntries.push({ name, path, isDir: false, size: content.length, mtime: Date.now(), depth: parts.length - 1 });
				}
				rpcOk(reqId, { ok: true }, fromPeer);
				break;
			}
			case "fs.mkdir":
				rpcOk(reqId, { ok: true }, fromPeer);
				break;
			case "fs.rename": {
				const from = String(p.from ?? "");
				const to = String(p.to ?? "");
				const text = mockFileTexts.get(from);
				const size = mockFileSizes.get(from);
				if (text !== undefined) mockFileTexts.set(to, text);
				if (size !== undefined) mockFileSizes.set(to, size);
				mockFileTexts.delete(from);
				mockFileSizes.delete(from);
				for (const entry of mockTreeEntries) {
					if (entry.path === from || entry.path.startsWith(`${from}/`)) {
						entry.path = `${to}${entry.path.slice(from.length)}`;
						entry.name = entry.path.split("/").filter(Boolean).at(-1) ?? entry.name;
					}
				}
				rpcOk(reqId, { ok: true }, fromPeer);
				break;
			}
			case "fs.delete": {
				const path = String(p.path ?? "");
				mockFileTexts.delete(path);
				mockFileSizes.delete(path);
				for (let i = mockTreeEntries.length - 1; i >= 0; i--) {
					if (mockTreeEntries[i]!.path === path || mockTreeEntries[i]!.path.startsWith(`${path}/`)) {
						mockTreeEntries.splice(i, 1);
					}
				}
				rpcOk(reqId, { ok: true }, fromPeer);
				break;
			}
			default:
				rpcErr(reqId, `unknown rpc method: ${method}`, fromPeer);
		}
	} catch (err) {
		rpcErr(reqId, err instanceof Error ? err.message : String(err), fromPeer);
	}
}

const mockFileTexts = new Map<string, string>([
	["/mock/src/hello.ts", "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n"],
	["/mock/src/index.ts", 'import { greet } from "./hello";\nconsole.log(greet("world"));\n'],
	["/mock/README.md", "# Mock Workspace\n\nDemo files served by the collab mock host.\n"],
]);
const mockFileSizes = new Map<string, number>(
	[...mockFileTexts.entries()].map(([k, v]) => [k, v.length]),
);

function handleFrame(frame: WireFrame, fromPeer: number): void {
	switch (frame.t) {
		case "hello":
			handleHello(frame.name, frame.proto, fromPeer);
			break;
		case "prompt":
			handlePrompt(frame.text, fromPeer);
			break;
		case "abort":
			handleAbort(fromPeer);
			break;
		case "agent-cmd":
			handleAgentCmd(frame.cmd, frame.agentId, fromPeer);
			break;
		case "fetch-transcript":
			handleFetchTranscript(frame.reqId, frame.fromByte, fromPeer);
			break;
		case "rpc-request":
			handleRpcRequest(frame.reqId, frame.method, frame.params, fromPeer);
			break;
		default:
			// Host-frame echoes or unknown types: ignore.
			break;
	}
}

function handleControl(text: string): void {
	let msg: unknown;
	try {
		msg = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof msg !== "object" || msg === null) return;
	const control = msg as { t?: unknown; peer?: unknown };
	if (control.t === "peer-left" && typeof control.peer === "number") {
		const name = peers.get(control.peer);
		peers.delete(control.peer);
		if (name) console.log(`mock-host: ${name} left (peer ${control.peer})`);
		broadcastState();
	}
}

ws.onopen = () => {
	console.log("mock collab host ready");
	console.log(`join link: ${link}`);
	console.log("paste the link into the desktop-web connect screen (bun ./index.html), Ctrl+C stops the host");
};

ws.onmessage = event => {
	const data: unknown = event.data;
	if (typeof data === "string") {
		handleControl(data);
		return;
	}
	if (!(data instanceof ArrayBuffer)) return;
	const envelope = unpackEnvelope(new Uint8Array(data));
	if (!envelope) return;
	recvChain = recvChain
		.then(async () => {
			const frame = await open<WireFrame>(key, envelope.payload);
			handleFrame(frame, envelope.peerId);
		})
		.catch((err: unknown) => {
			console.error("mock-host: dropping undecryptable frame:", err);
		});
};

ws.onclose = event => {
	if (shuttingDown) return;
	console.error(`mock-host: relay socket closed (${event.code} ${event.reason || "no reason"})`);
	shutdown(1);
};

// ── progress ticker ──────────────────────────────────────────────────────────

const tickInterval: Timer = setInterval(() => {
	tick++;
	sendFrame({ t: "bus", channel: "task:subagent:progress", data: makeProbeProgress(tick) });
	const now = Date.now();
	for (const agent of agents) {
		if (agent.status === "running") agent.lastActivity = now;
	}
	if (tick % AGENTS_SNAPSHOT_EVERY === 0) {
		sendFrame({ t: "agents", agents: agents.map(agent => ({ ...agent })) });
	}
}, TICK_INTERVAL_MS);

// ── shutdown ─────────────────────────────────────────────────────────────────

function shutdown(code: number): void {
	if (shuttingDown) return;
	shuttingDown = true;
	cancelReplay();
	clearInterval(tickInterval);
	sendFrame({ t: "bye", reason: "mock host shutting down" });
	// Let the bye flush through the send chain before tearing the room down.
	void sendChain.finally(() => {
		try {
			ws.close(1000);
		} catch {
			// already closing
		}
		relay.stop();
		process.exit(code);
	});
}

process.on("SIGINT", () => {
	console.log("\nmock-host: shutting down");
	shutdown(0);
});
