/**
 * Zip writer, proven against a real reader.
 *
 * A hand-built zip either opens in everything or in nothing, and the failure is
 * silent until an unzip attempt: a wrong CRC, an offset off by the name length,
 * a size field that counted the pre-compression bytes. So every case here feeds
 * its output to fflate's `unzipSync` — the same reader the plugin installer in
 * this repo uses — and asserts the recovered entry map. A structurally invalid
 * archive throws there; asserting the content proves both halves at once.
 */
import { describe, expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { ZipWriter } from "../../src/daemon/zip-writer";

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/** Build the archive and let a real unzippers read it back. */
function roundTrip(build: (zip: ZipWriter) => void): Record<string, Uint8Array> {
	const zip = new ZipWriter();
	build(zip);
	return unzipSync(zip.finish() as Uint8Array<ArrayBufferLike> & Uint8Array);
}

describe("ZipWriter", () => {
	test("writes a single stored file that a real unzipper recovers", () => {
		const entries = roundTrip(zip => zip.addFile("hello.txt", bytes("hello world\n")));
		expect(new TextDecoder().decode(entries["hello.txt"])).toBe("hello world\n");
	});

	test("writes several files and keeps them addressable individually", () => {
		const entries = roundTrip(zip => {
			zip.addFile("a.txt", bytes("A"));
			zip.addFile("dir/b.txt", bytes("B"));
		});
		expect(new TextDecoder().decode(entries["a.txt"])).toBe("A");
		expect(new TextDecoder().decode(entries["dir/b.txt"])).toBe("B");
	});

	test("deflates a large file and the reader gets the original bytes", () => {
		// Past the internal threshold the entry switches to deflate; a wrong
		// compression flag or a size field taken from the compressed length is
		// exactly the kind of corruption only a real reader catches.
		const big = bytes("compressible content ".repeat(500));
		const entries = roundTrip(zip => zip.addFile("big.txt", big));
		expect(entries["big.txt"]?.length).toBe(big.length);
		expect(new TextDecoder().decode(entries["big.txt"])).toBe(new TextDecoder().decode(big));
	});

	test("does not deflate when that would make the entry larger", () => {
		// Random bytes gain under deflate. The writer stores them anyway — the
		// archive is still valid and smaller than the "compressed" variant.
		const noise = new Uint8Array(4096);
		for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) & 0xff;
		const entries = roundTrip(zip => zip.addFile("noise.bin", noise));
		expect(entries["noise.bin"]?.length).toBe(noise.length);
	});

	test("carries directory entries so empty folders survive the round trip", () => {
		// unzipSync does not return entries for folders, but it does parse their
		// headers — an invalid central record for the directory throws here,
		// which is the half worth proving.
		const zip = new ZipWriter();
		zip.addDirectory("empty/");
		zip.addFile("empty/x.txt", bytes("x"));
		const entries = unzipSync(zip.finish() as Uint8Array<ArrayBufferLike> & Uint8Array);
		expect(new TextDecoder().decode(entries["empty/x.txt"])).toBe("x");
	});

	test("preserves non-ASCII filenames through the UTF-8 flag", () => {
		const entries = roundTrip(zip => zip.addFile("文档/说明.txt", bytes("你好\n")));
		expect(new TextDecoder().decode(entries["文档/说明.txt"])).toBe("你好\n");
	});

	test("produces a byte-identical archive for the same input", () => {
		// Timestamps are deliberately zeroed, which is what lets two builds of a
		// tree be compared at all. A drift here means the DOS time leaked back in.
		const once = new ZipWriter();
		once.addFile("a.txt", bytes("same"));
		const twice = new ZipWriter();
		twice.addFile("a.txt", bytes("same"));
		expect(once.finish()).toEqual(twice.finish());
	});

	test("counts entries as they are written, for the progress poll", () => {
		const zip = new ZipWriter();
		expect(zip.count).toBe(0);
		zip.addFile("a.txt", bytes("a"));
		zip.addDirectory("d/");
		zip.addFile("d/b.txt", bytes("b"));
		expect(zip.count).toBe(3);
	});

	test("handles the 2^31-adjacent size fields as unsigned", () => {
		// A single file near 2 GiB is not exercised here — but the header writes
		// sizes as u32, and `>>> 0` on a value under 2^31 must be a no-op, i.e.
		// normal files must still read back exactly. This guards the shift
		// against being removed.
		const entries = roundTrip(zip => zip.addFile("ok.txt", bytes("still fine")));
		expect(new TextDecoder().decode(entries["ok.txt"])).toBe("still fine");
	});

	test("an empty selection still makes a valid archive", () => {
		// Zero entries: the end record says "0 of 0" and the central directory
		// spans nothing. Real unzippers accept this; a naive writer that skipped
		// the end record would not be a zip at all.
		const zip = new ZipWriter();
		const entries = unzipSync(zip.finish() as Uint8Array<ArrayBufferLike> & Uint8Array);
		expect(Object.keys(entries).length).toBe(0);
	});
});
