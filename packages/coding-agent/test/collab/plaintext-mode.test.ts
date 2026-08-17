/**
 * Contract: plaintext (no-E2E) guest mode — the fallback for browsers on
 * insecure http, which have no crypto.subtle. The relay records the guest's
 * mode at join (peer-joined carries it), the host encodes directed sends
 * per-recipient and auto-detects plaintext frames on receive, and both guest
 * kinds coexist in one room.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { generateRoomId, generateRoomKey, importRoomKey, CollabSocket as ProtoSocket } from "@musepi/collab-proto";
import type { CollabFrame } from "@musepi/pi-coding-agent/collab/protocol";
import { type CollabSocketOptions, CollabSocket as HostSocket } from "@musepi/pi-coding-agent/collab/relay-client";
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

async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor timeout");
		await new Promise(r => setTimeout(r, 10));
	}
}

interface Peer {
	socket: HostSocket;
	frames: { frame: unknown; fromPeer: number }[];
	controls: { t: string; peer: number; plaintext?: boolean }[];
}

/** The socket is CollabFrame-typed; these are transport-level probes, not real frames. */
function frame(shape: object): CollabFrame {
	return shape as unknown as CollabFrame;
}

async function connectHost(origin: string, roomId: string, key: CryptoKey): Promise<Peer> {
	const socket = new HostSocket({ wsUrl: `${origin}/r/${roomId}`, role: "host", key } satisfies CollabSocketOptions);
	const frames: Peer["frames"] = [];
	const controls: Peer["controls"] = [];
	const opened = new Promise<void>(resolve => {
		socket.onOpen = () => resolve();
	});
	socket.onFrame = (frame, fromPeer) => frames.push({ frame, fromPeer });
	socket.onControl = msg => {
		if (msg.t === "peer-joined") controls.push({ t: msg.t, peer: msg.peer, plaintext: msg.plaintext });
	};
	socket.connect();
	await opened;
	return { socket, frames, controls };
}

interface Guest {
	socket: ProtoSocket<unknown>;
	frames: { frame: unknown; fromPeer: number }[];
	fatal: string | null;
}

async function connectGuest(
	origin: string,
	roomId: string,
	opts: { key?: CryptoKey; plaintext?: boolean },
): Promise<Guest> {
	const socket = new ProtoSocket<unknown>({
		wsUrl: `${origin}/r/${roomId}`,
		role: "guest",
		key: opts.key,
		plaintext: opts.plaintext,
	});
	const frames: Guest["frames"] = [];
	let fatal: string | null = null;
	const opened = new Promise<void>(resolve => {
		socket.onOpen = () => resolve();
	});
	socket.onFrame = (frame, fromPeer) => frames.push({ frame, fromPeer });
	socket.onClose = reason => {
		if (!reason.startsWith("closed")) fatal = reason;
	};
	socket.connect();
	await opened;
	return { socket, frames, fatal };
}

describe("plaintext guest mode", () => {
	it("records guest mode, routes per-recipient, and auto-detects plaintext frames", async () => {
		const server = await startServer();
		const roomId = generateRoomId();
		const key = await importRoomKey(generateRoomKey());
		const host = await connectHost(server.origin, roomId, key);
		const plainGuest = await connectGuest(server.origin, roomId, { plaintext: true });
		const sealedGuest = await connectGuest(server.origin, roomId, { key });

		// The relay advertises each guest's mode on peer-joined.
		await waitFor(() => host.controls.filter(c => c.t === "peer-joined").length === 2);
		const joined = host.controls.filter(c => c.t === "peer-joined");
		const plainPeer = joined.find(c => c.plaintext)!.peer;
		const sealedPeer = joined.find(c => !c.plaintext)!.peer;
		expect(plainPeer).toBe(1);
		expect(sealedPeer).toBe(2);

		// Host encodes directed sends per-recipient (host.ts fan-out pattern).
		host.socket.setPeerMode(plainPeer, true);
		host.socket.send(frame({ t: "welcome", plain: true }), plainPeer);
		host.socket.send(frame({ t: "welcome", sealed: true }), sealedPeer);
		await waitFor(() => plainGuest.frames.length === 1 && sealedGuest.frames.length === 1);
		expect(plainGuest.frames[0]!.frame).toEqual({ t: "welcome", plain: true });
		expect(sealedGuest.frames[0]!.frame).toEqual({ t: "welcome", sealed: true });
		expect(plainGuest.fatal).toBeNull();
		expect(sealedGuest.fatal).toBeNull();

		// Both guest kinds reach the host; plaintext frames auto-decode.
		plainGuest.socket.send({ t: "hello", from: "plain" });
		sealedGuest.socket.send({ t: "hello", from: "sealed" });
		await waitFor(() => host.frames.length === 2);
		const byFrom = new Map(host.frames.map(f => [f.fromPeer, f.frame]));
		expect(byFrom.get(plainPeer)).toEqual({ t: "hello", from: "plain" });
		expect(byFrom.get(sealedPeer)).toEqual({ t: "hello", from: "sealed" });

		host.socket.close();
		plainGuest.socket.close();
		sealedGuest.socket.close();
	});

	it("rejects plaintext joins only for guests; host always seals", async () => {
		const server = await startServer();
		const roomId = generateRoomId();
		const key = await importRoomKey(generateRoomKey());
		const host = await connectHost(server.origin, roomId, key);
		// A plaintext param on a host join is ignored: the host still seals.
		const host2 = new HostSocket({
			wsUrl: `${server.origin}/r/${roomId}?plaintext=1`,
			role: "host",
			key,
		});
		const fatal: string[] = [];
		host2.onClose = (reason, willReconnect) => {
			if (!willReconnect) fatal.push(reason);
		};
		host2.connect();
		await waitFor(() => fatal.length > 0);
		expect(fatal[0]).toBe("a host is already connected for this room");

		host.socket.close();
	});
});
