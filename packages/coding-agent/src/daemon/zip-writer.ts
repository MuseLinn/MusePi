/**
 * Zip-archive writer for the "download a selection" feature.
 *
 * Stores files uncompressed (method 0) when small and deflates the ones over
 * {@link DEFLATE_MIN} — a tree full of source files shrinks enough to matter
 * and the CPU for it does not. A directory is an entry whose name ends in a
 * slash, carrying no bytes; unzippers use those to create empty folders, and
 * leaving them out is how a restored tree loses its structure.
 *
 * Written by hand rather than pulled in as a dependency because the format is
 * ~40 bytes of header per entry, `node:zlib` already provides both deflate and
 * a hardware-accelerated CRC-32, and the alternative — an in-memory `zipSync` —
 * would hold every selected file's bytes at once.
 *
 * @module daemon/zip-writer
 */
import { crc32, deflateRawSync } from "node:zlib";

/** Above this many bytes, an entry is deflated rather than stored. */
const DEFLATE_MIN = 1024;

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_OF_CENTRAL_SIZE = 22;

interface PendingEntry {
	name: string;
	/** The bytes as they will appear (compressed, when compressed). */
	data: Uint8Array;
	/** The bytes before compression, for the header's size field. */
	originalSize: number;
	crc: number;
	compressed: boolean;
	/** Byte offset of this entry's local header in the output. */
	offset: number;
}

/** A little-endian cursor over a growable buffer. */
class Writer {
	#buf = new Uint8Array(64 * 1024);
	#view = new DataView(this.#buf.buffer);
	#pos = 0;

	#get(n: number): void {
		if (this.#pos + n <= this.#buf.length) return;
		let size = this.#buf.length * 2;
		while (size < this.#pos + n) size *= 2;
		const next = new Uint8Array(size);
		next.set(this.#buf.subarray(0, this.#pos));
		this.#buf = next;
		this.#view = new DataView(next.buffer);
	}

	u16(value: number): void {
		this.#get(2);
		this.#view.setUint16(this.#pos, value, true);
		this.#pos += 2;
	}

	u32(value: number): void {
		this.#get(4);
		// Unsigned write against a value that may exceed 2^31 (file sizes do).
		this.#view.setUint32(this.#pos, value >>> 0, true);
		this.#pos += 4;
	}

	bytes(data: Uint8Array): void {
		this.#get(data.length);
		this.#buf.set(data, this.#pos);
		this.#pos += data.length;
	}

	get position(): number {
		return this.#pos;
	}

	/** The written bytes, without the backing capacity. */
	take(): Uint8Array {
		return this.#buf.slice(0, this.#pos);
	}
}

/** Encode a zip filename. Zip's default is CP437; UTF-8 is flagged instead. */
function encodeName(name: string): Uint8Array {
	return new TextEncoder().encode(name);
}

/**
 * Build one entry's local header + payload.
 *
 * Timestamp fields are zeroed rather than smuggled from the file's mtime:
 * DOS time cannot represent anything outside 1980–2107, and every unzipped
 * consumer here shows the file in a viewer that gets its date from the source
 * tree anyway. A fixed zero also keeps two builds of the same tree byte-
 * identical, which is what makes the output comparable in tests.
 */
function writeLocal(w: Writer, entry: PendingEntry): void {
	w.u32(0x04034b50); // local file header signature
	w.u16(20); // version needed
	w.u16(0x0800); // flags: UTF-8 filename
	w.u16(entry.compressed ? 8 : 0); // 8 = deflate, 0 = stored
	w.u16(0); // mod time
	w.u16(0); // mod date
	w.u32(entry.crc);
	w.u32(entry.data.length); // compressed size
	w.u32(entry.originalSize);
	const name = encodeName(entry.name);
	w.u16(name.length);
	w.u16(0); // extra field length
	w.bytes(name);
	w.bytes(entry.data);
}

/**
 * Finish the archive: central directory + end-of-central record.
 *
 * Each central record restates what the local header said plus where it lives,
 * which is why an unzipper can read a zip back to front without touching any
 * local header first.
 */
function writeCentral(w: Writer, entries: readonly PendingEntry[]): void {
	const centralStart = w.position;
	for (const entry of entries) {
		w.u32(0x02014b50);
		w.u16(20); // version made by
		w.u16(20); // version needed
		w.u16(0x0800); // UTF-8 filename
		w.u16(entry.compressed ? 8 : 0);
		w.u16(0); // mod time
		w.u16(0); // mod date
		w.u32(entry.crc);
		w.u32(entry.data.length);
		w.u32(entry.originalSize);
		const name = encodeName(entry.name);
		w.u16(name.length);
		w.u16(0); // extra
		w.u16(0); // comment
		w.u16(0); // disk number
		w.u16(0); // internal attributes
		w.u32(0); // external attributes
		w.u32(entry.offset);
		w.bytes(name);
	}
	w.u32(0x06054b50);
	w.u16(0);
	w.u16(0);
	w.u16(entries.length);
	w.u16(entries.length);
	w.u32(w.position - centralStart);
	w.u32(centralStart);
	w.u16(0); // comment length
}

/**
 * One file at a time, into a growing archive.
 *
 * The incremental shape is the point: a selection walked through `zipSync`
 * would need every file's bytes in memory before writing anything, and a tree
 * selected for download is exactly the case that gets large. Callers add each
 * file as it is read and {@link finish} at the end.
 */
export class ZipWriter {
	readonly #writer = new Writer();
	readonly #entries: PendingEntry[] = [];

	/** Add one file. `name` uses `/` separators, as zip requires. */
	addFile(name: string, content: Uint8Array): void {
		const crc = crc32(content);
		let data = content;
		let compressed = false;
		if (content.length > DEFLATE_MIN) {
			// Raw deflate, not `deflateSync`: zip method 8 is a raw DEFLATE stream,
			// and zlib's `deflateSync` wraps one in a zlib header the reader would
			// try to inflate as part of the payload.
			const deflated = new Uint8Array(deflateRawSync(content, { level: 6 }));
			// Deflate sometimes loses — already-compressed payloads grow. Storing
			// the smaller result is the standard escape and keeps the size field
			// honest, since it is derived from the bytes we actually write.
			if (deflated.length < content.length) {
				data = deflated;
				compressed = true;
			}
		}
		const entry: PendingEntry = {
			name,
			data,
			originalSize: content.length,
			crc,
			compressed,
			offset: this.#writer.position,
		};
		writeLocal(this.#writer, entry);
		this.#entries.push(entry);
	}

	/** Add an empty directory so unzippers recreate it. */
	addDirectory(name: string): void {
		const dirName = name.endsWith("/") ? name : `${name}/`;
		const entry: PendingEntry = {
			name: dirName,
			data: new Uint8Array(0),
			originalSize: 0,
			crc: 0,
			compressed: false,
			offset: this.#writer.position,
		};
		writeLocal(this.#writer, entry);
		this.#entries.push(entry);
	}

	/** Entries written so far — the progress the poller reports. */
	get count(): number {
		return this.#entries.length;
	}

	/** Complete the archive and return its bytes. */
	finish(): Uint8Array {
		writeCentral(this.#writer, this.#entries);
		return this.#writer.take();
	}
}
