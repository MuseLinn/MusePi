/**
 * Memory/CPU benchmark host: parameterized collab host for renderer
 * measurements. Timeline is automatic (no control channel):
 *
 *   guest join      -> welcome + snapshot-chunk(N synthetic entries)
 *   +2500ms         -> streaming storm (agent_start; assistant entry frames +
 *                      tool_execution_update at BENCH_STREAM_RATE_MS)
 *   +STREAM_MS      -> agent_end + idle (stays connected for idle-CPU sampling)
 *
 * env:
 *   BENCH_PORT           relay port (default 7488)
 *   BENCH_ENTRIES        synthetic history entries (default 400)
 *   BENCH_STREAM_MS      storm duration (default 2500)
 *   BENCH_STREAM_RATE_MS frame interval during storm (default 8)
 *
 * Usage: bun scripts/mem-bench-host.ts   (link printed on stdout:
 *        `join link: <link>`)
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
import type { AgentEvent, HostFrame, SessionEntry, SessionState, WireFrame } from "@musepi/pi-wire";
import { fixtureHeader, fixtureModel, HOST_DISPLAY_NAME } from "./fixture";
import { startLocalRelay } from "./local-relay";

const PORT = Number(Bun.env.BENCH_PORT ?? 7488);
const ENTRY_COUNT = Number(Bun.env.BENCH_ENTRIES ?? 400);
const STREAM_MS = Number(Bun.env.BENCH_STREAM_MS ?? 2500);
const STREAM_RATE_MS = Number(Bun.env.BENCH_STREAM_RATE_MS ?? 8);
/** "messages" (default) or "notices" — non-message frame storm. */
const STORM_KIND = Bun.env.BENCH_STORM_KIND ?? "messages";

const relay = startLocalRelay(PORT);
const roomId = generateRoomId();
const rawKey = generateRoomKey();
const key = await importRoomKey(rawKey);
const link = formatCollabLink(relay.url, roomId, rawKey);

function iso(tsMs: number): string {
	return new Date(tsMs).toISOString();
}

// ── synthetic history ────────────────────────────────────────────────────────

function genEntries(n: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	const t0 = Date.now() - n * 60_000;
	let parent: string | null = null;
	for (let i = 0; i < n; i++) {
		const id = `h${i}`;
		const ts = t0 + i * 60_000;
		const base = { id, parentId: parent, timestamp: iso(ts), type: "message" as const };
		switch (i % 5) {
			case 0:
				entries.push({
					...base,
					message: {
						role: "user",
						content: `benchmark user message ${i}: the guest socket sometimes stays dead after a redeploy — audit the reconnect path and report the backoff constants.`,
						timestamp: ts,
					},
				});
				break;
			case 1:
				entries.push({
					...base,
					message: {
						role: "assistant",
						content: [
							{
								type: "thinking",
								thinking: `Benchmark thinking block ${i}: reconnect semantics live in the backoff loop; read both close handlers before claiming anything.`,
							},
							{
								type: "text",
								text: `Benchmark assistant reply ${i}: backoff is 1s base / 30s cap with a 256-frame reconnect buffer.`,
							},
							{
								type: "toolCall",
								id: `call-bash-${i}`,
								name: "bash",
								arguments: { command: `rg -n "BACKOFF" packages/coding-agent/src/collab/relay-client.ts` },
								intent: "Checking backoff constants",
							},
							{
								type: "toolCall",
								id: `call-read-${i}`,
								name: "read",
								arguments: { path: "packages/coding-agent/src/collab/relay-client.ts", offset: 160, limit: 60 },
								intent: "Reading the close handler",
							},
						],
						model: fixtureModel.id,
						usage: {
							input: 2_410,
							output: 386,
							cacheRead: 18_200,
							cacheWrite: 0,
							totalTokens: 20_996,
							cost: { total: 0.0119 },
						},
						stopReason: "toolUse",
						timestamp: ts,
					},
				});
				break;
			case 2:
			case 3:
				entries.push({
					...base,
					message: {
						role: "toolResult",
						toolCallId: `call-${i % 5 === 2 ? "bash" : "read"}-${i - (i % 5 === 2 ? 1 : 2)}`,
						toolName: i % 5 === 2 ? "bash" : "read",
						content: [
							{
								type: "text",
								text:
									i % 5 === 2
										? `20:const BACKOFF_BASE_MS = 1_000;\n21:const BACKOFF_MAX_MS = 30_000;\n23:const MAX_PENDING_SENDS = 256;\n25:export const RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];`
										: `ENOENT: no such file or directory\n  open 'packages/coding-agent/src/collab/relay-clinet.ts'\n    at open (node:internal/fs/promises:642:23)\n    at readRange (src/tools/read.ts:88:9)`,
							},
						],
						isError: i % 5 === 3,
						timestamp: ts,
					},
				});
				break;
			default:
				entries.push({
					...base,
					message: {
						role: "assistant",
						content: [
							{
								type: "text",
								text: `Benchmark assistant reply ${i}: typo on my end — the file is \`relay-client.ts\`. The backoff constants match the spec; reading the close handler next.`,
							},
						],
						model: fixtureModel.id,
						usage: {
							input: 2_410,
							output: 386,
							cacheRead: 18_200,
							cacheWrite: 0,
							totalTokens: 20_996,
							cost: { total: 0.0119 },
						},
						stopReason: "stop",
						timestamp: ts,
					},
				});
		}
		parent = id;
	}
	return entries;
}

// ── mutable session state ────────────────────────────────────────────────────

const entries: SessionEntry[] = genEntries(ENTRY_COUNT);
const peers = new Map<number, string>();
let lastEntryId: string | null = entries[entries.length - 1]?.id ?? null;
let streaming = false;
let stormTimer: Timer | null = null;
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
			console.error("mem-bench-host: send failed:", err);
		});
}

function buildState(): SessionState {
	const participants: SessionState["participants"] = [{ name: HOST_DISPLAY_NAME, role: "host" }];
	for (const name of peers.values()) participants.push({ name, role: "guest" });
	const tokens = 51_000 + entries.length * 120;
	return {
		isStreaming: streaming,
		queuedMessageCount: 0,
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

// ── streaming storm ──────────────────────────────────────────────────────────

function startStorm(): void {
	console.log(`mem-bench-host: storm start (${STREAM_MS}ms @ ${STREAM_RATE_MS}ms, kind=${STORM_KIND})`);
	streaming = true;
	broadcastState();
	sendFrame({ t: "event", event: { type: "agent_start" } });
	let seq = 0;
	const total = Math.ceil(STREAM_MS / STREAM_RATE_MS);
	stormTimer = setInterval(() => {
		if (seq >= total) {
			clearInterval(stormTimer ?? undefined);
			stormTimer = null;
			streaming = false;
			sendFrame({ t: "event", event: { type: "agent_end" } });
			broadcastState();
			console.log("mem-bench-host: storm end, idle");
			return;
		}
		const now = Date.now();
		if (STORM_KIND === "notices") {
			// Non-message frames only: exercises the shell re-render the
			// field-level split eliminates (notices only touch Toasts).
			sendFrame({
				t: "event",
				event: { type: "notice", level: "info", message: `notice frame ${seq}`, source: "bench" },
			});
			seq++;
			return;
		}
		if (seq % 8 === 0) {
			// tool_execution_update: partial result grows, activeTools map churns.
			sendFrame({
				t: "event",
				event: {
					type: "tool_execution_update",
					toolCallId: `live-call-${seq}`,
					toolName: "bash",
					args: { command: `bench ${seq}` },
					partialResult:
						`line ${seq}: simulating a streaming tool result that grows as the tool runs and fills the card… `.repeat(
							3,
						),
					startedAt: now,
				} as AgentEvent,
			});
		}
		appendEntry({
			id: `live-${seq}`,
			parentId: lastEntryId,
			timestamp: iso(now),
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: `streaming chunk ${seq} — benchmark token flow for render churn measurement.` },
				],
				model: fixtureModel.id,
				usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0 } },
				stopReason: "toolUse",
				timestamp: now,
			},
		});
		seq++;
	}, STREAM_RATE_MS);
}

// ── guest frame handling ─────────────────────────────────────────────────────

function handleFrame(frame: WireFrame, fromPeer: number): void {
	switch (frame.t) {
		case "hello":
			peers.set(fromPeer, frame.name);
			sendFrame(
				{
					t: "welcome",
					proto: COLLAB_PROTO,
					header: fixtureHeader,
					state: buildState(),
					agents: [],
					entryCount: entries.length,
				},
				fromPeer,
			);
			sendFrame({ t: "snapshot-chunk", entries: [...entries], final: true }, fromPeer);
			console.log(`mem-bench-host: ${frame.name} joined (peer ${fromPeer}, ${entries.length} entries)`);
			broadcastState();
			// Automatic timeline: storm starts 2.5s after the guest joins.
			setTimeout(() => {
				if (peers.size > 0) startStorm();
			}, 2500);
			break;
		default:
			break;
	}
}

ws.onopen = () => {
	console.log("mem-bench-host ready");
	console.log(`join link: ${link}`);
};

ws.onmessage = event => {
	const data: unknown = event.data;
	if (typeof data === "string") {
		let msg: unknown;
		try {
			msg = JSON.parse(data);
		} catch {
			return;
		}
		if (typeof msg === "object" && msg !== null) {
			const control = msg as { t?: unknown; peer?: unknown };
			if (control.t === "peer-left" && typeof control.peer === "number") {
				peers.delete(control.peer);
				broadcastState();
			}
		}
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
			console.error("mem-bench-host: dropping undecryptable frame:", err);
		});
};

ws.onclose = event => {
	if (shuttingDown) return;
	console.error(`mem-bench-host: relay socket closed (${event.code} ${event.reason || "no reason"})`);
	process.exit(1);
};

function shutdown(code: number): void {
	shuttingDown = true;
	relay.stop();
	process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
