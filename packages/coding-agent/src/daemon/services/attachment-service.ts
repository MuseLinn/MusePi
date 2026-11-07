import { randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { getBlobsDir, isEnoent } from "@musepi/pi-utils";
import type {
	AttachmentFileRef,
	AttachmentGetResult,
	AttachmentPutResult,
	AttachmentStatResult,
} from "@musepi/pi-wire";
import { formatFileRef } from "@musepi/pi-wire";
import { BLOB_HASH_RE, BlobStore } from "../../session/blob-store";
import type { DaemonService } from "./types";

/** Hard ceiling on one attachment body. The check runs before the buffer is
 *  allocated, so an oversized body costs only the request line that carried it.
 *  Only `attachment.putFile` reaches this: the base64 `attachment.put` is
 *  bounded earlier by the 16 MiB RPC frame limit (`MAX_REQUEST_BYTES`). */
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

/** One `attachment.get` page ceiling: callers page through the blob instead
 *  of asking for a base64 string that outgrows the transport. */
const MAX_GET_BYTES = 8 * 1024 * 1024;

/** Body shape accepted by `Buffer.from(content, "base64")`, without the
 *  tolerant whitespace/URL-safe variants — a payload that is not plain padded
 *  base64 decodes to silent garbage, which is worse than a soft error. */
const BASE64_BODY_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Chunk payload ceiling for `attachment.chunk`, in decoded bytes. Base64
 *  inflates 4/3, so 3 MiB arrives as a 4 MiB JSON body — comfortably under the
 *  16 MiB frame fence even with the envelope. */
const MAX_CHUNK_BYTES = 3 * 1024 * 1024;

/** Open chunked uploads kept at once. Each holds an open-on-demand temp file,
 *  so the bound is about disk and bookkeeping, not memory. */
const MAX_OPEN_UPLOADS = 4;

/** An upload that never commits is dropped after this long. */
const UPLOAD_TTL_MS = 10 * 60 * 1000;

interface UploadSession {
	readonly id: string;
	readonly path: string;
	readonly name: string;
	readonly mimeType: string;
	/** Declared total when the client sent one; commit cross-checks it. */
	readonly declaredSize: number | null;
	/** Bytes accepted per chunk index — overlapping retries must not inflate
	 *  the running total, so the sum, not a counter, is the truth. */
	readonly chunks: Map<number, number>;
	readonly createdAt: number;
}

export interface AttachmentBeginParams {
	name?: string;
	mimeType?: string;
	size?: number;
}

export interface AttachmentBeginResult {
	uploadId: string;
	/** Decoded bytes per `attachment.chunk` call. */
	chunkSize: number;
}

export interface AttachmentChunkParams {
	uploadId?: string;
	index?: number;
	/** Padded base64 of this chunk's bytes. */
	content?: string;
}

export interface AttachmentChunkResult {
	received: number;
	chunks: number;
}

export interface AttachmentCommitParams {
	uploadId?: string;
}

export interface AttachmentAbortParams {
	uploadId?: string;
}

export interface AttachmentPutParams {
	name?: string;
	mimeType?: string;
	/** Padded base64 of the raw bytes. */
	content?: string;
	/** Provenance only. Addressing is content-defined, so this never selects
	 *  a storage location or a visibility scope. */
	sessionId?: string;
}

export interface AttachmentPutFileParams {
	/** Absolute path on the daemon host. */
	path?: string;
	/** Display name; defaults to the path's basename. */
	name?: string;
	mimeType?: string;
}

export interface AttachmentGetParams {
	hash?: string;
	offset?: number;
	limit?: number;
}

/**
 * AttachmentService — 附件字节面（L2 宿主服务）。
 *
 * 能力缝声明（M2-2.4）：
 * - 输入：RPC `attachment.put`（GUI composer 的非图片附件：base64 正文 +
 *   原始文件名 + MIME）、`attachment.putFile`（同机客户端按路径入库，字节
 *   不经过传输层）、`attachment.begin` / `chunk` / `commit` / `abort`
 *   （远程客户端的分片上传，单片刻意留在 16 MiB 帧上限之下）、
 *   `attachment.get`（按偏移分页取回）、`attachment.stat`（只读存在性探测）。
 * - 输出：`put` / `putFile` / `commit` → `{ ref, url: "blob://<hash>" }`，
 *   `get` → `{ content, size, offset }`（`content` 是该页的 base64），
 *   `stat` → `{ exists, size }`。写与分页失败一律走软错误 `{ error }`，探测
 *   失败归一为 `exists:false`，都不抛进 JSON-RPC。
 * - 生命周期：分片上传持有临时文件，`stop()` 全部丢弃；未提交的上传在
 *   `begin` 时按 TTL 惰性清扫，同时最多 4 个（第 5 个挤掉最旧的）。字节最终
 *   落在 `BlobStore(getBlobsDir())`，与 `internal-urls/blob-protocol` 解析的
 *   是同一个目录，所以 `blob://<hash>` 即本服务写入的内容地址。
 *
 * 内容寻址使写入天然幂等：同一份字节来自哪个会话、哪个壳都不改变其结果。
 */
export class AttachmentService implements DaemonService {
	readonly key = "attachments";
	readonly routes = {
		"attachment.abort": "abort",
		"attachment.begin": "begin",
		"attachment.chunk": "chunk",
		"attachment.commit": "commit",
		"attachment.get": "get",
		"attachment.put": "put",
		"attachment.putFile": "putFile",
		"attachment.stat": "stat",
	} as const;

	readonly #store: BlobStore;
	readonly #uploads = new Map<string, UploadSession>();

	constructor(deps: { store?: BlobStore } = {}) {
		this.#store = deps.store ?? new BlobStore(getBlobsDir());
	}

	/** Temp area for partial uploads, next to (not inside) the blob store so a
	 *  half-written file can never be mistaken for a content-addressed blob. */
	get #uploadDir(): string {
		return path.join(path.dirname(this.#store.dir), "attachment-uploads");
	}

	/** Drop every open upload and its temp file. */
	async stop(): Promise<void> {
		const ids = [...this.#uploads.keys()];
		await Promise.all(ids.map(id => this.abort({ uploadId: id })));
	}

	/** RPC attachment.put：把一份 base64 附件写入 blob 存储。 */
	async put(params: AttachmentPutParams): Promise<AttachmentPutResult | { error: string }> {
		const p = params ?? {};
		const name = typeof p.name === "string" ? p.name.trim() : "";
		if (!name) return { error: "missing name" };
		if (typeof p.content !== "string") return { error: "missing content" };
		const content = p.content;
		if (content.length % 4 !== 0 || !BASE64_BODY_RE.test(content)) return { error: "invalid base64 content" };
		const size = base64ByteLength(content);
		if (size > MAX_ATTACHMENT_BYTES) return { error: `attachment too large (${size} bytes)` };
		const mimeType = typeof p.mimeType === "string" && p.mimeType ? p.mimeType : "application/octet-stream";
		const bytes = Buffer.from(content, "base64");
		const stored = await this.#store.put(bytes);
		const ref: AttachmentFileRef = { scheme: "blob", hash: stored.hash, size: bytes.length, mimeType, name };
		return { ref, url: formatFileRef(ref) };
	}

	/** RPC attachment.putFile：同一台机器上的文件按路径入库，字节不经过
	 *  传输层。`attachment.put` 的 base64 正文受单条 RPC 帧上限约束（16 MiB
	 *  帧 → 约 12 MiB 原文），这条路没有那个上限，因为宿主自己读盘。
	 *
	 *  与 `put` 一样按内容寻址：同一份字节无论来自哪个路径都落到同一个 blob。
	 *  入参路径不做沙箱限制——调用方与 `fs.readBytes` 是同一信任域，这里只
	 *  增加「一次读完整份再入库」的成本控制。 */
	async putFile(params: AttachmentPutFileParams): Promise<AttachmentPutResult | { error: string }> {
		const p = params ?? {};
		const source = typeof p.path === "string" ? p.path.trim() : "";
		if (!source) return { error: "missing path" };
		let stat: Awaited<ReturnType<typeof fsPromises.stat>>;
		try {
			stat = await fsPromises.stat(source);
		} catch {
			return { error: "file not found" };
		}
		if (!stat.isFile()) return { error: "not a regular file" };
		if (stat.size > MAX_ATTACHMENT_BYTES) return { error: `attachment too large (${stat.size} bytes)` };
		const bytes = Buffer.from(await Bun.file(source).arrayBuffer());
		// Re-check after the read: a file may grow between stat and read.
		if (bytes.length > MAX_ATTACHMENT_BYTES) return { error: `attachment too large (${bytes.length} bytes)` };
		const name = (typeof p.name === "string" && p.name.trim()) || path.basename(source);
		const mimeType = typeof p.mimeType === "string" && p.mimeType ? p.mimeType : "application/octet-stream";
		const stored = await this.#store.put(bytes);
		const ref: AttachmentFileRef = { scheme: "blob", hash: stored.hash, size: bytes.length, mimeType, name };
		return { ref, url: formatFileRef(ref) };
	}

	/** RPC attachment.begin：开一个分片上传。远程/移动端用这条路传超过单条
	 *  RPC 帧上限（16 MiB，base64 后约 12 MiB 原文）的附件。同机客户端应优先
	 *  用 `putFile`，它连分片都不需要。 */
	async begin(params: AttachmentBeginParams): Promise<AttachmentBeginResult | { error: string }> {
		const p = params ?? {};
		const name = typeof p.name === "string" ? p.name.trim() : "";
		if (!name) return { error: "missing name" };
		const declared = typeof p.size === "number" && Number.isFinite(p.size) ? Math.floor(p.size) : null;
		if (declared !== null && (declared < 0 || declared > MAX_ATTACHMENT_BYTES)) {
			return { error: `attachment too large (${declared} bytes)` };
		}
		await this.#sweepUploads();
		if (this.#uploads.size >= MAX_OPEN_UPLOADS) {
			const oldest = [...this.#uploads.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
			if (oldest) await this.abort({ uploadId: oldest.id });
		}
		const id = randomUUID();
		const filePath = path.join(this.#uploadDir, `${id}.part`);
		try {
			await fsPromises.mkdir(this.#uploadDir, { recursive: true });
			const handle = await fsPromises.open(filePath, "w");
			await handle.close();
		} catch {
			return { error: "cannot create upload" };
		}
		this.#uploads.set(id, {
			id,
			path: filePath,
			name,
			mimeType: typeof p.mimeType === "string" && p.mimeType ? p.mimeType : "application/octet-stream",
			declaredSize: declared,
			chunks: new Map(),
			createdAt: Date.now(),
		});
		return { uploadId: id, chunkSize: MAX_CHUNK_BYTES };
	}

	/** RPC attachment.chunk：写入一片。分片可以乱序重试——按 index 定位偏移，
	 *  同一片重复提交只更新该片的长度记录。 */
	async chunk(params: AttachmentChunkParams): Promise<AttachmentChunkResult | { error: string }> {
		const p = params ?? {};
		const session = typeof p.uploadId === "string" ? this.#uploads.get(p.uploadId) : undefined;
		if (!session) return { error: "unknown upload" };
		const index = typeof p.index === "number" && Number.isInteger(p.index) && p.index >= 0 ? p.index : -1;
		if (index < 0) return { error: "invalid chunk index" };
		if (typeof p.content !== "string") return { error: "missing content" };
		if (p.content.length % 4 !== 0 || !BASE64_BODY_RE.test(p.content)) {
			return { error: "invalid base64 content" };
		}
		const bytes = Buffer.from(p.content, "base64");
		if (bytes.length > MAX_CHUNK_BYTES) return { error: `chunk too large (${bytes.length} bytes)` };
		const offset = index * MAX_CHUNK_BYTES;
		if (offset + bytes.length > MAX_ATTACHMENT_BYTES) {
			return { error: `attachment too large (${offset + bytes.length} bytes)` };
		}
		try {
			const handle = await fsPromises.open(session.path, "r+");
			try {
				await handle.write(bytes, 0, bytes.length, offset);
			} finally {
				await handle.close();
			}
		} catch {
			return { error: "cannot write chunk" };
		}
		session.chunks.set(index, bytes.length);
		return { received: this.#receivedBytes(session), chunks: session.chunks.size };
	}

	/** RPC attachment.commit：把分片文件入库并返回与 `put` 相同的引用。 */
	async commit(params: AttachmentCommitParams): Promise<AttachmentPutResult | { error: string }> {
		const p = params ?? {};
		const session = typeof p.uploadId === "string" ? this.#uploads.get(p.uploadId) : undefined;
		if (!session) return { error: "unknown upload" };
		const received = this.#receivedBytes(session);
		if (session.declaredSize !== null && received !== session.declaredSize) {
			return { error: `size mismatch (${received} of ${session.declaredSize} bytes)` };
		}
		// Contiguity: a hole would silently store a truncated file under the hash
		// of its prefix, which no later commit could repair.
		for (let index = 0; index < session.chunks.size; index++) {
			if (!session.chunks.has(index)) return { error: `missing chunk ${index}` };
		}
		// Every chunk but the last must fill the fixed slot: index*chunkSize is
		// the write offset, so a short middle chunk would leave a hole that the
		// byte total cannot reveal.
		const lastIndex = session.chunks.size - 1;
		for (const [index, size] of session.chunks) {
			if (index < lastIndex && size !== MAX_CHUNK_BYTES) {
				return { error: `chunk ${index} is ${size} bytes; expected ${MAX_CHUNK_BYTES}` };
			}
		}
		if (received === 0) return { error: "empty upload" };
		let bytes: Buffer;
		try {
			bytes = Buffer.from(await Bun.file(session.path).arrayBuffer());
		} catch {
			return { error: "cannot read upload" };
		}
		await this.#discard(session);
		const stored = await this.#store.put(bytes);
		const ref: AttachmentFileRef = {
			scheme: "blob",
			hash: stored.hash,
			size: bytes.length,
			mimeType: session.mimeType,
			name: session.name,
		};
		return { ref, url: formatFileRef(ref) };
	}

	/** RPC attachment.abort：丢弃未提交的分片。 */
	async abort(params: AttachmentAbortParams): Promise<{ ok: true }> {
		const session = typeof params?.uploadId === "string" ? this.#uploads.get(params.uploadId) : undefined;
		if (session) await this.#discard(session);
		return { ok: true };
	}

	#receivedBytes(session: UploadSession): number {
		let total = 0;
		for (const size of session.chunks.values()) total += size;
		return total;
	}

	async #discard(session: UploadSession): Promise<void> {
		this.#uploads.delete(session.id);
		await fsPromises.rm(session.path, { force: true });
	}

	async #sweepUploads(): Promise<void> {
		const now = Date.now();
		for (const session of [...this.#uploads.values()]) {
			if (now - session.createdAt >= UPLOAD_TTL_MS) await this.#discard(session);
		}
	}

	/** RPC attachment.stat：只读探测，任何异常（哈希非法 / 不存在 / 无权限）
	 *  一律归一为 `exists:false`，绝不抛错。 */
	async stat(params: { hash?: string }): Promise<AttachmentStatResult> {
		const hash = typeof params?.hash === "string" ? params.hash : "";
		if (!BLOB_HASH_RE.test(hash)) return { exists: false, size: 0 };
		try {
			const size = await this.#blobSize(hash);
			return size === null ? { exists: false, size: 0 } : { exists: true, size };
		} catch {
			return { exists: false, size: 0 };
		}
	}

	/** RPC attachment.get：取回 blob 的一页（base64）。`size` 始终是完整
	 *  blob 大小，调用方据 offset + 本页长度继续分页。 */
	async get(params: AttachmentGetParams): Promise<AttachmentGetResult | { error: string }> {
		const p = params ?? {};
		const hash = typeof p.hash === "string" ? p.hash : "";
		if (!BLOB_HASH_RE.test(hash)) return { error: "invalid hash" };
		const blobPath = path.join(this.#store.dir, hash);
		const size = await this.#blobSize(hash);
		if (size === null) return { error: "blob not found" };
		const offset = p.offset ?? 0;
		if (!Number.isFinite(offset) || offset < 0 || offset > size) return { error: "offset out of range" };
		const requested = p.limit ?? MAX_GET_BYTES;
		if (!Number.isFinite(requested) || requested < 1) return { error: "invalid limit" };
		const limit = Math.min(Math.floor(requested), MAX_GET_BYTES);
		const end = Math.min(size, offset + limit);
		// Ranged read rather than BlobStore.get: a 64 MiB attachment paged in
		// 8 MiB reads would otherwise be loaded in full eight times.
		const bytes =
			end > offset ? Buffer.from(await Bun.file(blobPath).slice(offset, end).arrayBuffer()) : Buffer.alloc(0);
		return { content: bytes.toString("base64"), size, offset };
	}

	async #blobSize(hash: string): Promise<number | null> {
		try {
			return (await Bun.file(path.join(this.#store.dir, hash)).stat()).size;
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}
}

/** Decoded byte length of padded base64, computed before allocating the
 *  buffer so an oversized body is rejected without decoding it. */
function base64ByteLength(content: string): number {
	const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
	return (content.length / 4) * 3 - padding;
}
