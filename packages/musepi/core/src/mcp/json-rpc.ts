// ============================================================
// MusePi MCP — transport-agnostic JSON-RPC 2.0 peer.
//
// A transport moves whole message objects (serialization is the
// transport's job: JSONL for stdio, POST bodies for HTTP). The peer
// owns request/response correlation, timeouts, abort wiring, server-
// initiated request acknowledgement, and notification fan-out.
// ============================================================

import type { McpJsonRpcMessage, McpJsonRpcNotification, McpJsonRpcRequest, McpJsonRpcResponse } from "./types.ts";

export interface McpTransport {
	/** Send one message. Fire-and-forget; transport errors surface via onClose. */
	send(message: McpJsonRpcMessage): void;
	/** Incoming messages (responses, server requests, notifications). */
	onMessage(listener: (message: McpJsonRpcMessage) => void): void;
	/** Fired once when the transport is gone (process exit, socket close). */
	onClose(listener: () => void): void;
	/** Tear down. Idempotent; must eventually fire onClose. */
	close(): void;
}

interface PendingRequest {
	method: string;
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
}

export interface JsonRpcPeerOptions {
	/** Default per-request timeout when no abort signal is supplied. */
	requestTimeoutMs?: number;
	/** Handle a server-initiated request; default answers ping and roots via options. */
	onServerRequest?: (request: McpJsonRpcRequest) => unknown | Promise<unknown>;
	/** Server-initiated notification listener (tools/list_changed, logging, …). */
	onNotification?: (notification: McpJsonRpcNotification) => void;
	/** Transport close listener. */
	onClose?: () => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class JsonRpcPeer {
	#transport: McpTransport;
	#requestId = 0;
	#pending = new Map<string | number, PendingRequest>();
	#closed = false;
	readonly #options: JsonRpcPeerOptions;

	constructor(transport: McpTransport, options: JsonRpcPeerOptions = {}) {
		this.#transport = transport;
		this.#options = options;
		transport.onMessage((message) => this.#route(message));
		transport.onClose(() => this.#handleClose());
	}

	get closed(): boolean {
		return this.#closed;
	}

	#route(message: McpJsonRpcMessage): void {
		try {
			// Disambiguate on `method` FIRST: server request ids live in their
			// own id space and can collide with our in-flight request ids.
			if ("method" in message) {
				if ("id" in message && message.id !== undefined) {
					void this.#handleServerRequest(message as McpJsonRpcRequest);
					return;
				}
				this.#options.onNotification?.(message as McpJsonRpcNotification);
				return;
			}
			if ("id" in message && message.id !== undefined) {
				const response = message as McpJsonRpcResponse;
				const pending = this.#pending.get(response.id);
				if (!pending) return;
				this.#pending.delete(response.id);
				if (response.error) pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
				else pending.resolve(response.result);
			}
		} catch {
			// A throwing handler must not kill the reader loop.
		}
	}

	async #handleServerRequest(request: McpJsonRpcRequest): Promise<void> {
		let response: McpJsonRpcResponse;
		try {
			const result = this.#options.onServerRequest
				? await this.#options.onServerRequest(request)
				: this.#defaultServerRequestResult(request);
			response = { jsonrpc: "2.0", id: request.id, result: result ?? null };
		} catch (error) {
			const code = error instanceof McpMethodNotFound ? -32601 : -32603;
			response = {
				jsonrpc: "2.0",
				id: request.id,
				error: { code, message: error instanceof Error ? error.message : String(error) },
			};
		}
		if (!this.#closed) this.#transport.send(response);
	}

	#defaultServerRequestResult(request: McpJsonRpcRequest): unknown {
		// Servers that block on a reply must never wedge the session.
		if (request.method === "ping") return {};
		throw new McpMethodNotFound(request.method);
	}

	#handleClose(): void {
		if (this.#closed) return;
		this.#closed = true;
		const error = new Error("MCP transport closed");
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		this.#options.onClose?.();
	}

	async request(
		method: string,
		params?: unknown,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<unknown> {
		if (this.#closed) throw new Error("MCP transport is closed");
		const { timeoutMs, signal } = options;
		if (signal?.aborted) throw new Error("aborted");
		const id = ++this.#requestId;

		return await new Promise((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			let settled = false;
			const cleanup = (): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			const onAbort = (): void => {
				this.#pending.delete(id);
				cleanup();
				this.notify("notifications/cancelled", { requestId: id, reason: "aborted" }).catch(() => {});
				reject(new Error("aborted"));
			};
			const effectiveTimeout = timeoutMs ?? (signal ? undefined : DEFAULT_REQUEST_TIMEOUT_MS);
			if (effectiveTimeout !== undefined) {
				timer = setTimeout(() => {
					this.#pending.delete(id);
					cleanup();
					reject(new Error(`MCP request ${method} timed out after ${effectiveTimeout}ms`));
				}, effectiveTimeout);
				timer.unref?.();
			}
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
			this.#pending.set(id, {
				method,
				resolve: (result) => {
					cleanup();
					resolve(result);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});
			try {
				const message: McpJsonRpcRequest = { jsonrpc: "2.0", id, method };
				if (params !== undefined) message.params = params;
				this.#transport.send(message);
			} catch (error) {
				this.#pending.delete(id);
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async notify(method: string, params?: unknown): Promise<void> {
		if (this.#closed) return;
		const message: McpJsonRpcNotification = { jsonrpc: "2.0", method };
		if (params !== undefined) message.params = params;
		this.#transport.send(message);
	}

	close(): void {
		this.#transport.close();
		this.#handleClose();
	}
}

class McpMethodNotFound extends Error {
	constructor(method: string) {
		super(`Method not found: ${method}`);
	}
}
