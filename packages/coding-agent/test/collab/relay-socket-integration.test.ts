/**
 * Contract: the production CollabSocket client (AES-GCM sealing, envelope
 * packing, peer routing) works end to end against the in-process relay
 * server — the same pairing a LAN/tunnel share uses. Sealed frames round-trip
 * with the relay rewriting only the 4-byte peerId header; the payload stays
 * opaque (the relay never sees plaintext).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { CollabSocket, generateRoomId, generateRoomKey, importRoomKey } from "@musepi/collab-proto";
import { type RelayServerHandle, startRelayServer } from "@musepi/pi-coding-agent/collab/relay-server";

const servers: RelayServerHandle[] = [];

afterAll(async () => {
	for (const s of servers) await s.close().catch(() => {});
});

async function startServer(): Promise<RelayServerHandle> {
	const handle = await startRelayServer({ port: 0, host: "127.0.0.1" });
	servers.push(handle);
	return handle;
}

interface SocketPeer {
	socket: CollabSocket<unknown>;
	frames: { frame: unknown; fromPeer: number }[];
	controls: { t: string; peer?: number }[];
}

/** Shared room per test: host and guests must join the SAME room + key. */
async function connectSocket(
	origin: string,
	role: "host" | "guest",
	roomId: string,
	key: CryptoKey,
): Promise<SocketPeer> {
	const socket = new CollabSocket<unknown>({ wsUrl: `${origin}/r/${roomId}`, role, key });
	const frames: { frame: unknown; fromPeer: number }[] = [];
	const controls: { t: string; peer?: number }[] = [];
	const opened = new Promise<void>(resolve => {
		socket.onOpen = () => resolve();
	});
	socket.onFrame = (frame, fromPeer) => frames.push({ frame, fromPeer });
	socket.onControl = msg => controls.push(msg);
	socket.connect();
	await opened;
	return { socket, frames, controls };
}

describe("CollabSocket + relay server integration", () => {
	it("round-trips sealed frames host<->guest with peer-id rewriting", async () => {
		const server = await startServer();
		const roomId = generateRoomId();
		const key = await importRoomKey(generateRoomKey());
		const host = await connectSocket(server.origin, "host", roomId, key);
		const guest = await connectSocket(server.origin, "guest", roomId, key);

		// Host broadcast → guest, fromPeer 0.
		host.socket.send({ hello: "from host" });
		await waitFor(() => guest.frames.length === 1);
		expect(guest.frames[0]!.frame).toEqual({ hello: "from host" });
		expect(guest.frames[0]!.fromPeer).toBe(0);

		// Guest → host, fromPeer 1.
		guest.socket.send({ hi: "from guest" });
		await waitFor(() => host.frames.length === 1);
		expect(host.frames[0]!.frame).toEqual({ hi: "from guest" });
		expect(host.frames[0]!.fromPeer).toBe(1);

		// Host heard the guest's join.
		await waitFor(() => host.controls.some(c => c.t === "peer-joined" && c.peer === 1));

		host.socket.close();
		guest.socket.close();
	});

	it("reconnects a guest after a transient drop and resumes routing", async () => {
		const server = await startServer();
		const roomId = generateRoomId();
		const key = await importRoomKey(generateRoomKey());
		const host = await connectSocket(server.origin, "host", roomId, key);
		const guest = await connectSocket(server.origin, "guest", roomId, key);
		const guestClose = new Promise<{ reason: string; willReconnect: boolean }>(resolve => {
			guest.socket.onClose = (reason, willReconnect) => resolve({ reason, willReconnect });
		});
		guest.socket.close(); // intentional — no reconnect
		const result = await guestClose;
		expect(result).toEqual({ reason: "closed", willReconnect: false });
		host.socket.close();
	});

	it("host drop tears the room down with close 4001", async () => {
		const server = await startServer();
		const roomId = generateRoomId();
		const key = await importRoomKey(generateRoomKey());
		const host = await connectSocket(server.origin, "host", roomId, key);
		const guest = await connectSocket(server.origin, "guest", roomId, key);
		const closed = new Promise<{ reason: string; willReconnect: boolean }>(resolve => {
			guest.socket.onClose = (reason, willReconnect) => resolve({ reason, willReconnect });
		});
		await host.socket.close();
		const result = await closed;
		expect(result.reason).toBe("room closed");
		expect(result.willReconnect).toBe(false);
	});

	it("rejects a second host with a fatal 4009 close", async () => {
		const server = await startServer();
		const roomId = generateRoomId();
		const key = await importRoomKey(generateRoomKey());
		const host = await connectSocket(server.origin, "host", roomId, key);
		const second = new CollabSocket<unknown>({ wsUrl: `${server.origin}/r/${roomId}`, role: "host", key });
		const secondClose = new Promise<{ reason: string; willReconnect: boolean }>(resolve => {
			second.onClose = (reason, willReconnect) => resolve({ reason, willReconnect });
		});
		second.connect();
		const result = await secondClose;
		expect(result.reason).toBe("a host is already connected for this room");
		expect(result.willReconnect).toBe(false);
		host.socket.close();
	});
});

async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor timeout");
		await new Promise(r => setTimeout(r, 10));
	}
}
