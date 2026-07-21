// ============================================================
// MusePi LSP — JSON-RPC over stdio framing (Content-Length headers).
//
// Pure byte/string machinery, no process handles: the client drives this
// from child_process streams, tests drive it with raw buffers.
// ============================================================

/** Serialize a JSON-RPC message with the LSP Content-Length framing. */
export function encodeLspMessage(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf-8");
	const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf-8");
	return Buffer.concat([header, body]);
}

/**
 * Incremental parser for LSP's header-framed stream. Tolerates junk bytes
 * between messages (wrapper scripts that print to stdout): a header block
 * without a parseable Content-Length is dropped up to the next \r\n and
 * reported via the onBadHeader callback instead of stalling the stream.
 */
export class LspMessageFramer {
	#buffer: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): void {
		this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
	}

	/** Drain every complete message body currently buffered (JSON text). */
	drain(onBadHeader?: (headerText: string) => void): string[] {
		const messages: string[] = [];
		for (;;) {
			const headerEnd = this.#buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) break;
			const headerText = this.#buffer.subarray(0, headerEnd).toString("utf-8");
			const match = /Content-Length:\s*(\d+)/i.exec(headerText);
			if (!match) {
				// Resync: drop up to the first line break inside the bogus block.
				const lineEnd = this.#buffer.indexOf("\r\n");
				this.#buffer = this.#buffer.subarray(lineEnd === -1 ? headerEnd + 4 : lineEnd + 2);
				onBadHeader?.(headerText.slice(0, 200));
				continue;
			}
			const length = Number(match[1]);
			const bodyStart = headerEnd + 4;
			if (this.#buffer.length < bodyStart + length) break;
			messages.push(this.#buffer.subarray(bodyStart, bodyStart + length).toString("utf-8"));
			this.#buffer = this.#buffer.subarray(bodyStart + length);
		}
		return messages;
	}

	/** Unparsed remainder (for diagnostics / reader restart). */
	remainder(): Buffer {
		return this.#buffer;
	}
}
