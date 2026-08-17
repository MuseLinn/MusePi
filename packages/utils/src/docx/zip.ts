import * as zlib from "node:zlib";

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const MAX_END_SEARCH = 65_557;
const UTF8 = new TextDecoder();

/** The decompressed members of a DOCX ZIP package. */
export type ZipEntries = ReadonlyMap<string, Uint8Array>;

function view(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function findEndRecord(bytes: Uint8Array): number {
	const data = view(bytes);
	for (
		let offset = bytes.byteLength - 22, limit = Math.max(0, bytes.byteLength - MAX_END_SEARCH);
		offset >= limit;
		offset--
	) {
		if (data.getUint32(offset, true) === END_SIGNATURE) return offset;
	}
	throw new Error("Invalid DOCX: missing ZIP end record");
}

/** Decode a ZIP package by walking its central directory. */
export function readZip(bytes: Uint8Array): ZipEntries {
	if (bytes.byteLength < 22) throw new Error("Invalid DOCX: truncated ZIP package");
	const data = view(bytes);
	const endOffset = findEndRecord(bytes);
	const entryCount = data.getUint16(endOffset + 10, true);
	const centralSize = data.getUint32(endOffset + 12, true);
	const centralOffset = data.getUint32(endOffset + 16, true);
	if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
		throw new Error("Invalid DOCX: ZIP64 packages are not supported");
	}
	if (centralOffset + centralSize > bytes.byteLength) throw new Error("Invalid DOCX: truncated ZIP central directory");
	const entries = new Map<string, Uint8Array>();
	let offset = centralOffset;
	for (let index = 0; index < entryCount; index++) {
		if (offset + 46 > bytes.byteLength || data.getUint32(offset, true) !== CENTRAL_FILE_SIGNATURE) {
			throw new Error("Invalid DOCX: malformed ZIP central directory");
		}
		const flags = data.getUint16(offset + 8, true);
		const method = data.getUint16(offset + 10, true);
		const compressedSize = data.getUint32(offset + 20, true);
		const uncompressedSize = data.getUint32(offset + 24, true);
		const nameLength = data.getUint16(offset + 28, true);
		const extraLength = data.getUint16(offset + 30, true);
		const commentLength = data.getUint16(offset + 32, true);
		const localOffset = data.getUint32(offset + 42, true);
		const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
		if (entryEnd > bytes.byteLength) throw new Error("Invalid DOCX: truncated ZIP entry");
		const name = UTF8.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)).replaceAll("\\", "/");
		if ((flags & 1) !== 0) throw new Error(`Invalid DOCX: encrypted ZIP member ${name}`);
		if (localOffset + 30 > bytes.byteLength || data.getUint32(localOffset, true) !== LOCAL_FILE_SIGNATURE) {
			throw new Error(`Invalid DOCX: missing local header for ${name}`);
		}
		const localNameLength = data.getUint16(localOffset + 26, true);
		const localExtraLength = data.getUint16(localOffset + 28, true);
		const payloadOffset = localOffset + 30 + localNameLength + localExtraLength;
		const payloadEnd = payloadOffset + compressedSize;
		if (payloadEnd > bytes.byteLength) throw new Error(`Invalid DOCX: truncated ZIP member ${name}`);
		const compressed = bytes.subarray(payloadOffset, payloadEnd);
		let decoded: Uint8Array;
		if (method === 0) {
			decoded = compressed;
		} else if (method === 8) {
			decoded = zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(uncompressedSize, 1) });
		} else {
			throw new Error(`Invalid DOCX: unsupported ZIP compression method ${method}`);
		}
		if (decoded.byteLength !== uncompressedSize)
			throw new Error(`Invalid DOCX: size mismatch for ZIP member ${name}`);
		if (name && !name.endsWith("/")) entries.set(name, decoded);
		offset = entryEnd;
	}
	return entries;
}

/** Decode a ZIP member as UTF-8 text. */
export function readZipText(entries: ZipEntries, name: string): string | undefined {
	const bytes = entries.get(name);
	return bytes ? UTF8.decode(bytes) : undefined;
}
