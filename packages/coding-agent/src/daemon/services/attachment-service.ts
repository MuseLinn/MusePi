import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { getBlobsDir, isEnoent } from "@musepi/pi-utils";
import type { AttachmentGetResult, AttachmentPutResult, AttachmentStatResult } from "@musepi/pi-wire";
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
 *   不经过传输层）、`attachment.get`（按偏移分页取回）、
 *   `attachment.stat`（只读存在性探测）。
 * - 输出：`put` / `putFile` → `{ ref, url: "blob://<hash>" }`，`get` →
 *   `{ content, size, offset }`（`content` 是该页的 base64），`stat` →
 *   `{ exists, size }`。写与分页失败一律走软错误 `{ error }`，探测失败归一
 *   为 `exists:false`，都不抛进 JSON-RPC。
 * - 生命周期：无自有状态、无 start/stop。字节落在 `BlobStore(getBlobsDir())`，
 *   与 `internal-urls/blob-protocol` 解析的是同一个目录，所以
 *   `blob://<hash>` 即本服务写入的内容地址，不需要第二套 URL 形式。
 *
 * 内容寻址使写入天然幂等：同一份字节来自哪个会话、哪个壳都不改变其结果。
 */
export class AttachmentService implements DaemonService {
	readonly key = "attachments";
	readonly routes = {
		"attachment.get": "get",
		"attachment.put": "put",
		"attachment.putFile": "putFile",
		"attachment.stat": "stat",
	} as const;

	readonly #store: BlobStore;

	constructor(deps: { store?: BlobStore } = {}) {
		this.#store = deps.store ?? new BlobStore(getBlobsDir());
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
		return {
			ref: { scheme: "blob", hash: stored.hash, size: bytes.length, mimeType, name },
			url: `blob://${stored.hash}`,
		};
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
		return {
			ref: { scheme: "blob", hash: stored.hash, size: bytes.length, mimeType, name },
			url: `blob://${stored.hash}`,
		};
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
