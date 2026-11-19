/**
 * Contract: the terminal client's close policy matches the browser client's.
 * Close 4001 means the host dropped; it is retryable while the relay retains
 * the room, so a host blip does not end every guest session. A relay that
 * stops sharing (1001) and a room that is really gone (4004) end the session —
 * which is what makes a deliberate host stop terminal without a protocol
 * change: the host sends a sealed `bye` first, and if it is lost the relay
 * drops the room at once, so the retry lands on 4004.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { generateRoomId, generateRoomKey, importRoomKey } from "@musepi/collab-proto";
import { CollabSocket } from "@musepi/pi-coding-agent/collab/relay-client";
import { type RelayServerHandle, startRelayServer } from "@musepi/pi-coding-agent/collab/relay-server";

const servers: RelayServerHandle[] = [];

afterAll(async () => {
	for (const server of servers) await server.close().catch(() => {});
});

async function startServer(options: { hostGraceMs?: number } = {}): Promise<RelayServerHandle> {
	const handle = await startRelayServer({ port: 0, host: "127.0.0.1", ...options });
	servers.push(handle);
	return handle;
}

interface CloseEvent {
	reason: string;
	willReconnect: boolean;
}

async function connect(
	origin: string,
	role: "host" | "guest",
	roomId: string,
	key: CryptoKey,
): Promise<{ socket: CollabSocket; events: CloseEvent[] }> {
	const socket = new CollabSocket({ wsUrl: `${origin}/r/${roomId}`, role, key });
	const events: CloseEvent[] = [];
	socket.onClose = (reason, willReconnect) => events.push({ reason, willReconnect });
	const opened = new Promise<void>(resolve => {
		socket.onOpen = () => resolve();
	});
	socket.connect();
	await opened;
	return { socket, events };
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor timeout");
		await new Promise(r => setTimeout(r, 20));
	}
}

describe("relay client close policy", () => {
	it("retries 4001 and rejoins once the host reclaims the room", async () => {
		const server = await startServer({ hostGraceMs: 5_000 });
		const roomId = generateRoomId();
		const key = await importRoomKey(generateRoomKey());
		const host = await connect(server.origin, "host", roomId, key);
		const guest = await connect(server.origin, "guest", roomId, key);
		let reopens = 0;
		guest.socket.onOpen = () => reopens++;

		await host.socket.close();
		await waitFor(() => guest.events.length > 0);
		expect(guest.events[0]!.willReconnect).toBe(true);

		// The host comes back on the same roomId; the pending retry rejoins.
		const hostAgain = await connect(server.origin, "host", roomId, key);
		await waitFor(() => reopens > 0);
		expect(guest.socket.isOpen).toBe(true);

		guest.socket.close();
		hostAgain.socket.close();
	});

	it("makes 4001 fatal once the room is gone, so a retry lands on 4004", async () => {
		const server = await startServer({ hostGraceMs: 0 });
		const roomId = generateRoomId();
		const key = await importRoomKey(generateRoomKey());
		const host = await connect(server.origin, "host", roomId, key);
		const guest = await connect(server.origin, "guest", roomId, key);

		await host.socket.close();
		await waitFor(() => guest.events.some(e => !e.willReconnect));
		expect(guest.events[0]!.willReconnect).toBe(true);
		expect(guest.events.at(-1)).toEqual({ reason: "no such room", willReconnect: false });
	});

	it("makes a relay stop fatal instead of retrying", async () => {
		const server = await startServer();
		const roomId = generateRoomId();
		const key = await importRoomKey(generateRoomKey());
		const host = await connect(server.origin, "host", roomId, key);
		const guest = await connect(server.origin, "guest", roomId, key);

		await server.close();
		await waitFor(() => guest.events.some(e => !e.willReconnect));
		expect(guest.events.at(-1)).toEqual({ reason: "sharing stopped", willReconnect: false });
		host.socket.close();
	});

	it("keeps a room-full rejection fatal", async () => {
		const server = await startRelayServer({ port: 0, host: "127.0.0.1", maxGuests: 1 });
		servers.push(server);
		const roomId = generateRoomId();
		const key = await importRoomKey(generateRoomKey());
		const host = await connect(server.origin, "host", roomId, key);
		const guest = await connect(server.origin, "guest", roomId, key);

		const overflow = new CollabSocket({ wsUrl: `${server.origin}/r/${roomId}`, role: "guest", key });
		const closed = new Promise<CloseEvent>(resolve => {
			overflow.onClose = (reason, willReconnect) => resolve({ reason, willReconnect });
		});
		overflow.connect();
		expect(await closed).toEqual({ reason: "room is full", willReconnect: false });

		guest.socket.close();
		host.socket.close();
	});
});
