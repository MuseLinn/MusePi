/**
 * Fake daemon transport for the marketing demo.
 *
 * The desktop renderer talks JSON-RPC 2.0 over a WebSocket to the real daemon.
 * The site has no daemon, so this module swaps `window.WebSocket` for an
 * in-page implementation backed by fixture handlers. Everything above the
 * socket — the React shell, its RPC client, its event subscriptions — is the
 * real renderer; only the peer is fake.
 *
 * Contract for fixture modules: export a `methods` object whose keys are RPC
 * method names and whose values are `(params) => result | Promise<result>`.
 * `registerAll()` wires them in. `push()` emits a subscription envelope
 * (`{ kind, seq, payload }`) to every open socket, which is how a scripted
 * agent turn streams its transcript.
 */

const handlers = new Map();
const sockets = new Set();
let seq = 0;

/** Register one RPC method. */
export function register(method, handler) {
	handlers.set(method, handler);
}

/** Register every method of a fixture module's `methods` export. */
export function registerAll(methods) {
	for (const [method, handler] of Object.entries(methods)) register(method, handler);
}

/** Emit a subscription event to every connected socket. */
export function push(kind, payload) {
	const envelope = { kind, seq: ++seq, payload };
	for (const socket of sockets) socket.deliver(envelope);
}

/** Reset the event sequence (used by tests that replay a scenario). */
export function resetSeq() {
	seq = 0;
}

function answer(method, params) {
	const handler = handlers.get(method);
	if (handler) return Promise.resolve().then(() => handler(params ?? {}));
	// Unanswered list-shaped methods must be arrays: a `{}` here reaches
	// components that map over the result and takes the whole surface down.
	if (typeof method === "string" && method.includes("list")) return Promise.resolve([]);
	return Promise.resolve({});
}

const OPEN = 1;
const CLOSED = 3;

class MockSocket extends EventTarget {
	constructor(url) {
		super();
		this.url = String(url);
		this.readyState = 0;
		this.binaryType = "arraybuffer";
		this.bufferedAmount = 0;
		this.protocol = "";
		this.extensions = "";
		this.onopen = null;
		this.onmessage = null;
		this.onerror = null;
		this.onclose = null;
		sockets.add(this);
		setTimeout(() => {
			if (this.readyState !== 0) return;
			this.readyState = OPEN;
			const event = new Event("open");
			this.dispatchEvent(event);
			if (typeof this.onopen === "function") this.onopen.call(this, event);
		}, 16);
	}

	deliver(message) {
		if (this.readyState !== OPEN) return;
		const event = new MessageEvent("message", { data: JSON.stringify(message) });
		this.dispatchEvent(event);
		if (typeof this.onmessage === "function") this.onmessage.call(this, event);
	}

	send(raw) {
		let message;
		try {
			message = JSON.parse(String(raw));
		} catch {
			return;
		}
		if (location.search.includes("debug")) {
			const node = document.documentElement;
			node.dataset.demoRpc = `${node.dataset.demoRpc ?? ""} ${message.method}`.trim().slice(-400);
		}
		if (message.id === undefined) return;
		answer(message.method, message.params).then(
			result => this.deliver({ jsonrpc: "2.0", id: message.id, result }),
			error =>
				this.deliver({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32000, message: String(error?.message ?? error) },
				}),
		);
	}

	close() {
		if (this.readyState === CLOSED) return;
		this.readyState = CLOSED;
		sockets.delete(this);
		const event = new CloseEvent("close", { code: 1000, reason: "demo" });
		this.dispatchEvent(event);
		if (typeof this.onclose === "function") this.onclose.call(this, event);
	}
}
MockSocket.CONNECTING = 0;
MockSocket.OPEN = OPEN;
MockSocket.CLOSING = 2;
MockSocket.CLOSED = CLOSED;

/**
 * Install the fake socket and point the renderer at it.
 *
 * The URL is deliberately a dead port: if this module ever fails to install,
 * the renderer shows its connect screen instead of reaching a daemon that may
 * be running on the visitor's machine (a developer's production daemon).
 */
export function install({ url = "ws://127.0.0.1:9/demo" } = {}) {
	try {
		localStorage.setItem("musepi-gui-url", url);
	} catch {
		/* storage unavailable — the socket swap still applies */
	}
	window.WebSocket = MockSocket;
}
