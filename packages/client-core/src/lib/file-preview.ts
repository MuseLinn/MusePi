/**
 * One file-preview read for the guest shell, shared by the phone app and the
 * browser host view.
 *
 * `fs.readBytes` is the only binary read this module calls. `fs.read` is not
 * interchangeable: the daemon answers it with UTF-8 text (`{ content }`) while
 * the collab host answers it with bytes, so a preview written against `fs.read`
 * works on one transport and fails on the other. The bytes contract is
 * `{ base64, size, mime }` up to 8 MiB.
 *
 * Preview by mime, not by extension alone: text becomes a string, images and
 * media become object URLs the browser can paint or play, and everything else
 * keeps its bytes behind a download link. Object URLs are owned by the caller —
 * `releaseFilePreview` revokes them when the selection changes.
 */
import type { WorkspaceEntry } from "@musepi/pi-wire";

/** Text shown inline; the rest of the file is reported as truncated. */
export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;

/** Default read cap. The daemon/host clamps to their own hard cap (32 MiB). */
export const MAX_FILE_PREVIEW_BYTES = 8 * 1024 * 1024;

/** The only client surface the preview needs — both client kinds satisfy it. */
export interface FilePreviewRpc {
	rpc<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
}

export type FilePreviewKind = "text" | "image" | "audio" | "video" | "binary";

export interface FilePreviewText {
	kind: "text";
	name: string;
	mime: string;
	size: number;
	text: string;
	truncated: boolean;
}

/** Image, audio and video: bytes an element can render from a URL. */
export interface FilePreviewMedia {
	kind: "image" | "audio" | "video";
	name: string;
	mime: string;
	size: number;
	url: string;
}

/** Anything else (PDF, office documents, archives): download only. */
export interface FilePreviewBinary {
	kind: "binary";
	name: string;
	mime: string;
	size: number;
	url: string;
}

export interface FilePreviewError {
	kind: "error";
	message: string;
}

export type FilePreview = FilePreviewText | FilePreviewMedia | FilePreviewBinary;
export type FilePreviewResult = FilePreview | FilePreviewError;

/** Application mimes that are still text, even though they do not start `text/`. */
const TEXT_APPLICATION_MIMES = new Set([
	"application/json",
	"application/xml",
	"application/javascript",
	"application/x-javascript",
	"application/x-sh",
	"application/x-yaml",
	"application/toml",
]);

/** Extensions treated as text when the transport reports octet-stream. */
const TEXT_EXTENSIONS = new Set([
	"txt",
	"md",
	"markdown",
	"json",
	"jsonl",
	"json5",
	"yaml",
	"yml",
	"toml",
	"ini",
	"conf",
	"cfg",
	"csv",
	"tsv",
	"log",
	"xml",
	"html",
	"htm",
	"css",
	"scss",
	"less",
	"js",
	"mjs",
	"cjs",
	"jsx",
	"ts",
	"tsx",
	"py",
	"rs",
	"go",
	"java",
	"c",
	"cc",
	"cpp",
	"h",
	"hpp",
	"sh",
	"bash",
	"zsh",
	"fish",
	"ps1",
	"bat",
	"sql",
	"graphql",
	"gql",
	"diff",
	"patch",
	"env",
]);

function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function baseMime(mime: string): string {
	const semi = mime.indexOf(";");
	return (semi === -1 ? mime : mime.slice(0, semi)).trim().toLowerCase();
}

/**
 * Which renderer a file gets. The mime is authoritative; the extension only
 * breaks the `application/octet-stream` tie that unknown extensions and some
 * transports produce.
 */
export function previewKind(mime: string, name: string): FilePreviewKind {
	const base = baseMime(mime);
	if (base.startsWith("image/")) return "image";
	if (base.startsWith("audio/")) return "audio";
	if (base.startsWith("video/")) return "video";
	if (base.startsWith("text/") || TEXT_APPLICATION_MIMES.has(base)) return "text";
	if ((base === "application/octet-stream" || base === "") && TEXT_EXTENSIONS.has(extensionOf(name))) {
		return "text";
	}
	return "binary";
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

/**
 * A URL an element can load. Object URLs keep an 8 MiB file out of a data-URL
 * string; environments without `createObjectURL` (SSR, tests) fall back to the
 * data URL rather than dropping the preview.
 */
function urlForBytes(bytes: Uint8Array<ArrayBuffer>, mime: string, base64: string): string {
	if (typeof URL.createObjectURL === "function") {
		return URL.createObjectURL(new Blob([bytes], { type: mime }));
	}
	return `data:${mime};base64,${base64}`;
}

/**
 * Revoke the object URL a preview owns. Safe on text previews, on data URLs and
 * in environments without `revokeObjectURL`.
 */
export function releaseFilePreview(preview: FilePreview | FilePreviewResult | null): void {
	if (!preview || preview.kind === "text" || preview.kind === "error") return;
	if (!preview.url.startsWith("blob:")) return;
	if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(preview.url);
}

interface ReadBytesResult {
	base64?: string;
	size?: number;
	mime?: string;
	error?: string;
}

/**
 * Read one workspace file into its preview form.
 *
 * `cwd` lets the daemon resolve workspace.tree's session-relative `path`; the
 * collab host resolves it against the live session itself and ignores the
 * extra field.
 */
export async function readFilePreview(
	client: FilePreviewRpc,
	file: Pick<WorkspaceEntry, "path" | "name">,
	options?: { cwd?: string | null; maxBytes?: number },
): Promise<FilePreviewResult> {
	const name = file.name;
	const maxBytes = options?.maxBytes ?? MAX_FILE_PREVIEW_BYTES;
	let res: ReadBytesResult;
	try {
		res = await client.rpc<ReadBytesResult>("fs.readBytes", {
			path: file.path,
			cwd: options?.cwd ?? undefined,
			maxBytes,
		});
	} catch (err) {
		return { kind: "error", message: err instanceof Error ? err.message : String(err) };
	}
	if (res.error) return { kind: "error", message: res.error };
	if (typeof res.base64 !== "string" || res.base64.length === 0) {
		return { kind: "error", message: "empty file" };
	}
	const mime = res.mime ?? "";
	const size = typeof res.size === "number" ? res.size : 0;
	const kind = previewKind(mime, name);
	if (kind === "text") {
		const bytes = decodeBase64(res.base64);
		const truncated = bytes.length > TEXT_PREVIEW_MAX_BYTES;
		const text = new TextDecoder("utf-8", { fatal: false }).decode(
			truncated ? bytes.subarray(0, TEXT_PREVIEW_MAX_BYTES) : bytes,
		);
		return { kind: "text", name, mime, size, text, truncated };
	}
	const bytes = decodeBase64(res.base64);
	const url = urlForBytes(bytes, mime || "application/octet-stream", res.base64);
	if (kind === "binary") return { kind: "binary", name, mime, size, url };
	return { kind, name, mime, size, url };
}
