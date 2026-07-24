// ============================================================
// MusePi MCP — streamable HTTP transport (minimal).
//
// Every JSON-RPC message is a POST to the server endpoint with
// `Accept: application/json, text/event-stream`. The reply is either
// a JSON body (single message or batch) or an SSE stream whose
// `data:` payloads are delivered as they arrive. The `mcp-session-id`
// response header is captured and echoed on subsequent requests;
// close() sends a best-effort DELETE to end the session.
//
// Deliberately out of scope (documented limitation): the GET
// server-push stream and OAuth — servers that REQUIRE the push
// stream for a response will still answer on the POST stream.
// ============================================================

import type { McpTransport } from "./json-rpc.ts";
import type { McpJsonRpcMessage } from "./types.ts";

export interface HttpTransportOptions {
	url: string;
	headers?: Record<string, string>;
	/** Injectable for tests; defaults to global fetch. */
	fetchFn?: typeof fetch;
}

export class HttpMcpTransport implements McpTransport {
	#url: string;
	#headers: Record<string, string>;
	#fetch: typeof fetch;
	#sessionId: string | null = null;
	#messageListener: ((message: McpJsonRpcMessage) => void) | null = null;
	#closeListener: (() => void) | null = null;
	#closed = false;

	constructor(options: HttpTransportOptions) {
		this.#url = options.url;
		this.#headers = options.headers ?? {};
		this.#fetch = options.fetchFn ?? fetch;
	}

	#deliver(payload: unknown): void {
		const messages = Array.isArray(payload) ? payload : [payload];
		for (const message of messages) {
			try {
				this.#messageListener?.(message as McpJsonRpcMessage);
			} catch {
				// listener errors must not kill the delivery loop
			}
		}
	}

	/** Parse an SSE body, delivering each `data:` JSON payload. */
	async #consumeSse(body: ReadableStream<Uint8Array>): Promise<void> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				// SSE events are separated by blank lines.
				let sep = buffer.indexOf("\n\n");
				while (sep !== -1) {
					const event = buffer.slice(0, sep);
					buffer = buffer.slice(sep + 2);
					sep = buffer.indexOf("\n\n");
					const data = event
						.split("\n")
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trimStart())
						.join("\n");
					if (data.length === 0) continue;
					try {
						this.#deliver(JSON.parse(data));
					} catch {
						// malformed event payload — keep consuming
					}
				}
			}
		} catch {
			// aborted/truncated stream — pending requests time out on their own
		}
	}

	send(message: McpJsonRpcMessage): void {
		if (this.#closed) return;
		// Errors take the transport down (pending requests reject via
		// onClose); nothing to do with the rejection itself here.
		void this.#post(message).catch(() => {});
	}

	async #post(message: McpJsonRpcMessage): Promise<void> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...this.#headers,
		};
		if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
		let response: Response;
		try {
			response = await this.#fetch(this.#url, { method: "POST", headers, body: JSON.stringify(message) });
		} catch (error) {
			// Network failure takes the transport down: pending requests must
			// not hang until their individual timeouts.
			this.#handleClose();
			throw error;
		}
		const sessionId = response.headers.get("mcp-session-id");
		if (sessionId) this.#sessionId = sessionId;
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			this.#handleClose();
			throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 200)}`);
		}
		const contentType = response.headers.get("content-type") ?? "";
		if (response.status === 202 || !response.body) return; // notification accepted
		if (contentType.includes("text/event-stream")) {
			await this.#consumeSse(response.body);
			return;
		}
		const text = await response.text();
		if (text.trim().length === 0) return;
		try {
			this.#deliver(JSON.parse(text));
		} catch {
			// malformed body — pending requests time out on their own
		}
	}

	#handleClose(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#closeListener?.();
	}

	onMessage(listener: (message: McpJsonRpcMessage) => void): void {
		this.#messageListener = listener;
	}

	onClose(listener: () => void): void {
		this.#closeListener = listener;
	}

	close(): void {
		if (this.#closed) return;
		// Best-effort session termination per the streamable HTTP spec.
		if (this.#sessionId) {
			const headers = { ...this.#headers, "mcp-session-id": this.#sessionId };
			void this.#fetch(this.#url, { method: "DELETE", headers }).catch(() => {});
		}
		this.#handleClose();
	}
}
