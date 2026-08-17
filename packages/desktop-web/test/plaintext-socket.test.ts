/**
 * Contract: the browser guest socket in plaintext mode (no crypto.subtle on
 * insecure http) sends raw JSON frames and decodes raw JSON replies — same
 * envelope, no AES-GCM sealing — and advertises `?plaintext=1` on join.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { CollabSocket, packEnvelope, unpackEnvelope } from "@musepi/collab-proto";
import { type LocalRelay, startLocalRelay } from "../scripts/local-relay";

const ROOM = "PlaintextRoom_12345";
const REQUEST_TIMEOUT_MS = 1_000;

let relay: LocalRelay | null = null;
const sockets: WebSocket[] = [];

function socket(path: string): WebSocket {
	if (!relay) throw new Error("relay not started");
	const ws = new WebSocket(`${relay.url}${path}`);
	ws.binaryType = "arraybuffer";
	sockets.push(ws);
	return ws;
}

function waitOpen(ws: WebSocket): Promise<Event> {
	if (ws.readyState === WebSocket.OPEN) return Promise.resolve(new Event("open"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("open timeout")), REQUEST_TIMEOUT_MS);
		ws.addEventListener("open", () => {
			clearTimeout(timer);
			resolve(new Event("open"));
		});
		ws.addEventListener("error", () => reject(new Error("socket error")), { once: true });
	});
}

function waitText(ws: WebSocket, label: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), REQUEST_TIMEOUT_MS);
		ws.addEventListener("message", event => {
			if (typeof event.data !== "string") return;
			clearTimeout(timer);
			resolve(event.data);
		});
	});
}

function waitBinary(ws: WebSocket, label: string): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), REQUEST_TIMEOUT_MS);
		ws.addEventListener("message", event => {
			if (typeof event.data === "string") return;
			clearTimeout(timer);
			resolve(new Uint8Array(event.data));
		});
	});
}

function closeSocket(ws: WebSocket): void {
	if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000);
}

afterEach(() => {
	for (const ws of sockets.splice(0)) closeSocket(ws);
	relay?.stop();
	relay = null;
});

describe("plaintext guest socket", () => {
	it("sends raw JSON and decodes raw JSON, tagged ?plaintext=1", async () => {
		relay = startLocalRelay();

		// Raw host on the local relay.
		const host = socket(`/r/${ROOM}?role=host`);
		await waitOpen(host);

		const guest = new CollabSocket<unknown>({
			wsUrl: `${relay.url}/r/${ROOM}`,
			role: "guest",
			plaintext: true,
		});
		const frames: unknown[] = [];
		const opened = new Promise<void>(resolve => {
			guest.onOpen = () => resolve();
		});
		guest.onFrame = frame => frames.push(frame);
		// Attach before connect: the join control can land before onOpen resolves.
		const join = waitText(host, "peer-joined");
		guest.connect();
		await opened;

		// Host sees the join control; the guest advertised ?plaintext=1 on the
		// wire (the relay accepts the query — guest joins fine).
		expect(JSON.parse(await join)).toEqual({ t: "peer-joined", peer: 1 });

		// Guest → host: raw JSON envelope, not sealed.
		guest.send({ t: "hello", name: "phone" });
		const envelope = unpackEnvelope(await waitBinary(host, "plaintext hello"));
		expect(envelope).not.toBeNull();
		expect(envelope!.peerId).toBe(1);
		expect(JSON.parse(new TextDecoder().decode(envelope!.payload))).toEqual({ t: "hello", name: "phone" });

		// Host → guest: raw JSON envelope arrives decoded without a key.
		host.send(packEnvelope(1, new TextEncoder().encode(JSON.stringify({ t: "welcome" }))));
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("welcome timeout")), REQUEST_TIMEOUT_MS);
			const poll = () => {
				if (frames.length > 0) {
					clearTimeout(timer);
					resolve();
				} else {
					setTimeout(poll, 10);
				}
			};
			poll();
		});
		expect(frames[0]).toEqual({ t: "welcome" });

		guest.close();
	});
});
