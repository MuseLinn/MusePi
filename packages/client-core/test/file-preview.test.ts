import { describe, expect, it } from "bun:test";
import {
	MAX_FILE_PREVIEW_BYTES,
	previewKind,
	readFilePreview,
	releaseFilePreview,
	TEXT_PREVIEW_MAX_BYTES,
} from "../src/lib/file-preview";

interface Call {
	method: string;
	params?: unknown;
}

function fakeClient(answer: unknown): {
	calls: Call[];
	rpc: <T>(method: string, params?: unknown) => Promise<T>;
} {
	const calls: Call[] = [];
	return {
		calls,
		rpc: async <T>(method: string, params?: unknown): Promise<T> => {
			calls.push({ method, params });
			return answer as T;
		},
	};
}

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

describe("previewKind (mime first, extension only for octet-stream)", () => {
	it("routes media and text by mime", () => {
		expect(previewKind("image/png", "a")).toBe("image");
		expect(previewKind("image/svg+xml; charset=utf-8", "a")).toBe("image");
		expect(previewKind("audio/mpeg", "a")).toBe("audio");
		expect(previewKind("video/mp4", "a")).toBe("video");
		expect(previewKind("text/plain", "a")).toBe("text");
		expect(previewKind("application/json", "a")).toBe("text");
		expect(previewKind("application/pdf", "a")).toBe("binary");
	});

	it("falls back to the extension only when the mime says nothing", () => {
		expect(previewKind("application/octet-stream", "README.md")).toBe("text");
		expect(previewKind("", "main.rs")).toBe("text");
		expect(previewKind("application/octet-stream", "photo.bin")).toBe("binary");
		expect(previewKind("application/octet-stream", "archive")).toBe("binary");
	});
});

describe("readFilePreview", () => {
	it("reads through fs.readBytes with the session cwd and the preview cap", async () => {
		const client = fakeClient({ base64: b64("hello"), size: 5, mime: "text/plain" });
		const result = await readFilePreview(client, { path: "notes/a.txt", name: "a.txt" }, { cwd: "/work" });
		expect(client.calls).toEqual([
			{
				method: "fs.readBytes",
				params: { path: "notes/a.txt", cwd: "/work", maxBytes: MAX_FILE_PREVIEW_BYTES },
			},
		]);
		expect(result).toEqual({
			kind: "text",
			name: "a.txt",
			mime: "text/plain",
			size: 5,
			text: "hello",
			truncated: false,
		});
	});

	it("truncates text at the preview cap instead of decoding megabytes into the DOM", async () => {
		const long = "a".repeat(TEXT_PREVIEW_MAX_BYTES + 32);
		const client = fakeClient({ base64: b64(long), size: long.length, mime: "text/plain" });
		const result = await readFilePreview(client, { path: "big.log", name: "big.log" });
		expect(result.kind).toBe("text");
		if (result.kind !== "text") return;
		expect(result.truncated).toBe(true);
		expect(result.text.length).toBe(TEXT_PREVIEW_MAX_BYTES);
	});

	it("builds a renderable URL for an image", async () => {
		const client = fakeClient({ base64: b64("png-bytes"), size: 9, mime: "image/png" });
		const result = await readFilePreview(client, { path: "p.png", name: "p.png" });
		expect(result.kind).toBe("image");
		if (result.kind !== "image") return;
		expect(result.url.startsWith("blob:") || result.url.startsWith("data:")).toBe(true);
		releaseFilePreview(result);
	});

	it("keeps an unrenderable file downloadable as binary", async () => {
		const client = fakeClient({ base64: b64("%PDF-1.7"), size: 8, mime: "application/pdf" });
		const result = await readFilePreview(client, { path: "spec.pdf", name: "spec.pdf" });
		expect(result.kind).toBe("binary");
		if (result.kind !== "binary") return;
		expect(result.mime).toBe("application/pdf");
		releaseFilePreview(result);
	});

	it("reports a transport error result instead of rendering empty bytes", async () => {
		const client = fakeClient({ error: "file too large (9000000 bytes)" });
		const result = await readFilePreview(client, { path: "huge.bin", name: "huge.bin" });
		expect(result).toEqual({ kind: "error", message: "file too large (9000000 bytes)" });
	});

	it("reports a thrown RPC (collab host rejects) as an error preview", async () => {
		const client = {
			rpc: async () => {
				throw new Error("fs.readBytes: path escapes workspace");
			},
		};
		const result = await readFilePreview(client, { path: "../secret", name: "secret" });
		expect(result).toEqual({ kind: "error", message: "fs.readBytes: path escapes workspace" });
	});

	it("rejects an empty payload so the panel does not show a blank preview", async () => {
		const client = fakeClient({ base64: "", size: 0, mime: "text/plain" });
		const result = await readFilePreview(client, { path: "empty.txt", name: "empty.txt" });
		expect(result.kind).toBe("error");
	});
});
