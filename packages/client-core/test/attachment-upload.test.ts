import { describe, expect, it } from "bun:test";
import {
	ATTACHMENT_INLINE_MAX_BYTES,
	attachmentReferenceLine,
	bytesToBase64,
	composePromptWithAttachments,
	uploadAttachment,
} from "../src/lib/attachment-upload";

interface RpcCall {
	method: string;
	params: unknown;
}

function recordingRpc(handler: (method: string, params: unknown) => unknown): {
	calls: RpcCall[];
	rpc: <T>(method: string, params?: unknown) => Promise<T>;
} {
	const calls: RpcCall[] = [];
	return {
		calls,
		rpc: async <T>(method: string, params?: unknown): Promise<T> => {
			calls.push({ method, params });
			return handler(method, params) as T;
		},
	};
}

function bytesFile(bytes: Uint8Array<ArrayBuffer>, name: string, mimeType = "application/octet-stream"): File {
	return new File([bytes], name, { type: mimeType });
}

function decode(content: unknown): Buffer {
	if (typeof content !== "string") throw new Error("chunk content is not a string");
	return Buffer.from(content, "base64");
}

describe("attachment base64 encoding", () => {
	it("emits padded standard base64 for every remainder length", () => {
		expect(bytesToBase64(new Uint8Array([0]))).toBe("AA==");
		expect(bytesToBase64(new Uint8Array([0, 1]))).toBe("AAE=");
		expect(bytesToBase64(new Uint8Array([0, 1, 2]))).toBe("AAEC");
		expect(bytesToBase64(new Uint8Array())).toBe("");
	});
});

describe("small files use attachment.put", () => {
	it("sends one padded-base64 frame with the original name and MIME type", async () => {
		const rpc = recordingRpc(() => ({ url: "blob://abc", ref: { scheme: "blob", hash: "abc" } }));
		const file = bytesFile(new Uint8Array([0, 1, 2]), "notes.pdf", "application/pdf");

		const result = await uploadAttachment(rpc, file);

		expect(result.url).toBe("blob://abc");
		expect(rpc.calls).toEqual([
			{
				method: "attachment.put",
				params: { name: "notes.pdf", mimeType: "application/pdf", content: "AAEC" },
			},
		]);
	});

	it("defaults the MIME type when the picker reports none", async () => {
		const rpc = recordingRpc(() => ({ url: "blob://abc" }));
		await uploadAttachment(rpc, bytesFile(new Uint8Array([1]), "raw.bin", ""));

		expect(rpc.calls[0]?.params).toMatchObject({ mimeType: "application/octet-stream" });
	});

	it("rejects with the daemon's soft error instead of sending a reference", async () => {
		const rpc = recordingRpc(() => ({ error: "invalid base64 content" }));

		await expect(uploadAttachment(rpc, bytesFile(new Uint8Array([1]), "a.bin"))).rejects.toThrow(
			"invalid base64 content",
		);
	});
});

describe("large files use begin/chunk/commit", () => {
	it("slices by the server's chunk size and commits the same blob", async () => {
		const chunkSize = 3 * 1024 * 1024;
		const size = ATTACHMENT_INLINE_MAX_BYTES + 17;
		const bytes = new Uint8Array(size);
		for (let i = 0; i < size; i++) bytes[i] = i % 251;

		const chunks: { index: number; content: string }[] = [];
		const rpc = recordingRpc((method, params) => {
			if (method === "attachment.begin") {
				expect(params).toEqual({ name: "video.bin", mimeType: "application/octet-stream", size });
				return { uploadId: "upload-1", chunkSize };
			}
			if (method === "attachment.chunk") {
				chunks.push(params as { index: number; content: string });
				return { received: 0, chunks: chunks.length };
			}
			if (method === "attachment.commit") return { url: "blob://big" };
			throw new Error(`unexpected method ${method}`);
		});

		const result = await uploadAttachment(rpc, bytesFile(bytes, "video.bin"));

		expect(result.url).toBe("blob://big");
		expect(rpc.calls.map(call => call.method)).toEqual([
			"attachment.begin",
			"attachment.chunk",
			"attachment.chunk",
			"attachment.chunk",
			"attachment.commit",
		]);
		expect(chunks.map(chunk => chunk.index)).toEqual([0, 1, 2]);
		expect(chunks.map(chunk => decode(chunk.content).length)).toEqual([chunkSize, chunkSize, size - 2 * chunkSize]);
		expect(Buffer.concat(chunks.map(chunk => decode(chunk.content))).equals(Buffer.from(bytes))).toBe(true);
		expect(rpc.calls.at(-1)?.params).toEqual({ uploadId: "upload-1" });
	});

	it("aborts the upload and reports the failing chunk", async () => {
		const rpc = recordingRpc(method => {
			if (method === "attachment.begin") return { uploadId: "upload-2", chunkSize: 1024 * 1024 };
			if (method === "attachment.chunk") return { error: "cannot write chunk" };
			return { ok: true };
		});
		const file = bytesFile(new Uint8Array(ATTACHMENT_INLINE_MAX_BYTES + 1), "big.bin");

		await expect(uploadAttachment(rpc, file)).rejects.toThrow("cannot write chunk");

		expect(rpc.calls.map(call => call.method)).toEqual(["attachment.begin", "attachment.chunk", "attachment.abort"]);
		expect(rpc.calls.at(-1)?.params).toEqual({ uploadId: "upload-2" });
	});

	it("reports a commit rejection and does not invent a reference", async () => {
		const rpc = recordingRpc(method => {
			if (method === "attachment.begin") return { uploadId: "upload-3", chunkSize: 1024 * 1024 };
			if (method === "attachment.chunk") return { received: 0, chunks: 1 };
			if (method === "attachment.commit") return { error: "size mismatch (1 of 2 bytes)" };
			return { ok: true };
		});

		await expect(
			uploadAttachment(rpc, bytesFile(new Uint8Array(ATTACHMENT_INLINE_MAX_BYTES + 1), "b.bin")),
		).rejects.toThrow("size mismatch");
		expect(rpc.calls.some(call => call.method === "attachment.abort")).toBe(true);
	});

	it("does not abort when the server refuses to open an upload", async () => {
		const rpc = recordingRpc(() => ({ error: "attachment too large (999999999 bytes)" }));

		await expect(
			uploadAttachment(rpc, bytesFile(new Uint8Array(ATTACHMENT_INLINE_MAX_BYTES + 1), "c.bin")),
		).rejects.toThrow("attachment too large");
		expect(rpc.calls.map(call => call.method)).toEqual(["attachment.begin"]);
	});
});

describe("prompt reference lines", () => {
	it("formats the reference the agent resolves", () => {
		expect(attachmentReferenceLine("blob://abc123", "report.pdf")).toBe("[Attachment] blob://abc123 (report.pdf)");
	});

	it("prepends references in chip order and keeps the body intact", () => {
		expect(
			composePromptWithAttachments("review this", [
				"[Attachment] blob://a (a.txt)",
				"[Attachment] blob://b (b.png)",
			]),
		).toBe("[Attachment] blob://a (a.txt)\n[Attachment] blob://b (b.png)\n\nreview this");
		expect(composePromptWithAttachments("review this", [])).toBe("review this");
		expect(composePromptWithAttachments("", ["[Attachment] blob://a (a.txt)"])).toBe("[Attachment] blob://a (a.txt)");
	});
});
