// Standalone collab host stub for emulator verification of the mobile guest.
// Serves one live session over the local relay: on guest hello it sends
// welcome + snapshot-chunk, then echoes any prompt with an assistant reply.
// 8s after hello it pushes a background notification-triggering message.
// Uses E2E sealing (the Capacitor shell is https://localhost).
//
// Run: bun run scripts/collab-host-stub.ts
// The collab link is printed; paste it into the mobile app's "paste a join link".

import {
	COLLAB_PROTO,
	encodeBase64Url,
	importRoomKey,
	open,
	packEnvelope,
	seal,
	unpackEnvelope,
} from "@musepi/collab-proto";
import { startLocalRelay } from "./local-relay.js";

const PORT = 8800;
const ROOM = "HostRoomTest999";

// Fixed key/token so the collab link stays valid across stub restarts
// (a regenerated key orphans any already-connected guest). 32B key + 16B
// write token, matching ROOM_KEY_BYTES / WRITE_TOKEN_BYTES.
const keyBytes = Uint8Array.from(
	Buffer.from("90a0b8a6b6d201e427ca29a85ece7409daea8b9ec291bd20cb1354434f831716", "hex"),
);
const writeToken = Uint8Array.from(Buffer.from("841cd4c24b3d809e81ad7692649fadd6", "hex"));
const secret = new Uint8Array(keyBytes.byteLength + writeToken.byteLength);
secret.set(keyBytes, 0);
secret.set(writeToken, keyBytes.byteLength);
const link = `ws://10.0.2.2:${PORT}/r/${ROOM}.${encodeBase64Url(secret)}`;

const cryptoKey = await importRoomKey(keyBytes);

const HEADER = { type: "session", id: "s1", timestamp: new Date().toISOString(), cwd: "/work/musepi" } as const;
const STATE = {
	isStreaming: false,
	queuedMessageCount: 0,
	cwd: "/work/musepi",
	participants: [{ name: "host", role: "host" }],
} as const;
const AGENTS = [
	{
		id: "main",
		displayName: "Main",
		kind: "main",
		status: "running",
		hasSessionFile: true,
		createdAt: 1,
		lastActivity: 2,
	},
] as const;

const now = () => new Date().toISOString();
const entries = [
	{
		type: "message",
		id: "e1",
		parentId: null,
		timestamp: now(),
		message: { role: "user", content: "hello, please show me the board", timestamp: 1 },
	},
	{
		type: "message",
		id: "e2",
		parentId: null,
		timestamp: now(),
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Here is the project board. The migration task is **in progress** — 3 of 5 items done, the last one blocked on CI. Want me to dig into the failing job?",
				},
			],
			model: "test/model",
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
			stopReason: "stop",
			timestamp: 1,
		},
	},
];

function sendFrame(frame: unknown): void {
	void (async () => {
		const payload = await seal(cryptoKey, frame);
		host.send(packEnvelope(0, payload));
	})();
}

const relay = startLocalRelay(PORT);
console.log("RELAY", relay.url);
console.log("COLLAB LINK:", link);

const host = new WebSocket(`${relay.url}/r/${ROOM}?role=host`);
host.binaryType = "arraybuffer";
host.onopen = () => console.log("HOST OPEN — waiting for a guest hello");
host.onmessage = e => {
	if (typeof e.data === "string") {
		console.log("control:", e.data);
		return;
	}
	void (async () => {
		const env = unpackEnvelope(new Uint8Array(e.data));
		if (!env) return;
		let frame: { t: string };
		try {
			frame = (await open(cryptoKey, env.payload)) as { t: string };
		} catch {
			// A guest still holding a previous room key (stub restarted) sends
			// frames we cannot decrypt — ignore, never crash the process.
			console.log("ignored undecryptable frame (stale key?)");
			return;
		}
		console.log("guest frame:", frame.t);
		if (frame.t === "hello") {
			// Present a multi-session workspace so the mobile header title
			// becomes the SessionsSheet trigger (sessions.length > 1), then
			// focus the first session so we land in session (not directory) mode.
			sendFrame({
				t: "workspace",
				sessions: [
					{
						id: "s1",
						title: "Migration",
						cwd: "/work/musepi",
						working: true,
						paused: false,
						live: true,
						messageCount: 3,
						updatedAt: now(),
					},
					{
						id: "s2",
						title: "Board cleanup",
						cwd: "/work/musepi/docs",
						working: false,
						paused: true,
						live: false,
						messageCount: 12,
						updatedAt: Date.now() - 3600_000,
					},
				],
			});
			sendFrame({
				t: "workspace-session",
				session: {
					id: "s1",
					title: "Migration",
					cwd: "/work/musepi",
					working: true,
					paused: false,
					live: true,
					messageCount: 3,
					updatedAt: now(),
				},
			});
			sendFrame({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: HEADER,
				state: STATE,
				agents: AGENTS,
				entryCount: entries.length,
				readOnly: false,
			});
			sendFrame({ t: "snapshot-chunk", entries, final: true });
			// Push a notification-triggering message 8s after join.
			// Background the app before this fires to test native notifications.
			setTimeout(() => {
				sendFrame({
					t: "entry",
					entry: {
						type: "message",
						id: `notify-${Date.now()}`,
						parentId: null,
						timestamp: now(),
						message: {
							role: "assistant",
							content: [
								{
									type: "text",
									text: "Background check-in: the CI job just turned green. Everything is ready to merge.",
								},
							],
							model: "test/model",
							usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
							stopReason: "stop",
							timestamp: 3,
						},
					},
				});
				console.log("PUSHED notification-trigger entry");
			}, 8000);
		} else if (frame.t === "workspace-select") {
			// Guest picked a card in the workspace directory: refocus that
			// session and replay welcome + snapshot so the transcript hydrates.
			const sel = (frame as { sessionId?: string }).sessionId ?? "s1";
			console.log("workspace-select:", sel);
			sendFrame({
				t: "workspace-session",
				session: {
					id: sel,
					title: sel === "s2" ? "Board cleanup" : "Migration",
					cwd: sel === "s2" ? "/work/musepi/docs" : "/work/musepi",
					working: sel === "s1",
					paused: sel === "s2",
					live: true,
					messageCount: sel === "s2" ? 12 : 3,
					updatedAt: now(),
				},
			});
			sendFrame({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: sel === "s1" ? HEADER : { ...HEADER, id: sel },
				state: STATE,
				agents: AGENTS,
				entryCount: sel === "s1" ? entries.length : 0,
				readOnly: false,
			});
			if (sel === "s1") sendFrame({ t: "snapshot-chunk", entries, final: true });
			else sendFrame({ t: "snapshot-chunk", entries: [], final: true });
		} else if (frame.t === "prompt") {
			sendFrame({
				t: "entry",
				entry: {
					type: "message",
					id: `e${Date.now()}`,
					parentId: null,
					timestamp: now(),
					message: {
						role: "assistant",
						content: [
							{
								type: "text",
								text: "Got it — I'll look into the failing CI job and report back with the fix in a moment.",
							},
						],
						model: "test/model",
						usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
						stopReason: "stop",
						timestamp: 2,
					},
				},
			});
		}
	})();
};

// Keep the process alive until Ctrl+C.
setInterval(() => {}, 60_000);
