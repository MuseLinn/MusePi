/**
 * Align every __LINKEDIT region of a Mach-O addon to an 8-byte boundary.
 *
 * macOS 26+ dyld validates that all LINKEDIT regions (symbol string pool,
 * code signature, ...) start 8-byte aligned. ld64 27036.1 (Xcode ≥26 CLT)
 * lays out the ~10MB string table of the 140MB pi_natives addon on a
 * 4-byte boundary and dyld rejects the addon at dlopen ("mis-aligned
 * LINKEDIT string pool" / "mis-aligned LINKEDIT content"). This shifts the
 * content so every region starts aligned, updates the affected load-command
 * fields, then re-signs ad-hoc (codesign rewrites the blob in place and
 * adjusts __LINKEDIT filesize). Idempotent.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";

const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x2;
const LC_DYLD_INFO_ONLY = 0x22;
const LC_FUNCTION_STARTS = 0x26;
const LC_DATA_IN_CODE = 0x29;
const LC_CODE_SIGNATURE = 0x1d;

interface LinkEditRegion {
	start: number;
	size: number;
	lcOff: number;
	fieldOff: number;
	name: string;
}

/**
 * Returns true when the file was modified (alignment bytes inserted). On
 * non-Mach-O or already-aligned input it returns false.
 */
export async function alignLinkEdit(filePath: string): Promise<boolean> {
	const buf = await fs.readFile(filePath);
	if (buf.length < 32) return false;
	const magic = buf.readUInt32LE(0);
	if (magic !== 0xfeedfacf) return false;
	const ncmds = buf.readUInt32LE(16);

	let linkedit: { fileoff: number; filesize: number; lcOff: number } | null = null;
	const regions: LinkEditRegion[] = [];
	let off = 32;
	for (let i = 0; i < ncmds; i++) {
		const cmd = buf.readUInt32LE(off);
		const cmdsize = buf.readUInt32LE(off + 4);
		if (cmd === LC_SEGMENT_64) {
			const segname = buf
				.subarray(off + 8, off + 24)
				.toString("utf8")
				.replace(/\0.*$/, "");
			if (segname === "__LINKEDIT") {
				linkedit = { fileoff: buf.readBigUInt64LE(off + 40), filesize: buf.readBigUInt64LE(off + 48), lcOff: off };
			}
		} else if (cmd === LC_SYMTAB) {
			regions.push({
				start: buf.readUInt32LE(off + 16),
				size: buf.readUInt32LE(off + 20),
				lcOff: off,
				fieldOff: 16,
				name: "string pool",
			});
		} else if (cmd === LC_DYLD_INFO_ONLY) {
			const fields = [8, 16, 24, 32, 40];
			for (const f of fields) {
				const start = buf.readUInt32LE(off + f);
				const size = buf.readUInt32LE(off + f + 4);
				if (size > 0) regions.push({ start, size, lcOff: off, fieldOff: f, name: "dyld-info" });
			}
		} else if (cmd === LC_FUNCTION_STARTS || cmd === LC_DATA_IN_CODE || cmd === LC_CODE_SIGNATURE) {
			regions.push({
				start: buf.readUInt32LE(off + 8),
				size: buf.readUInt32LE(off + 12),
				lcOff: off,
				fieldOff: 8,
				name: "linkedit region",
			});
		}
		off += cmdsize;
	}
	if (!linkedit) return false;

	// Walk regions in file order, accumulating shifts so every start lands on
	// an 8-byte boundary (inserted padding shifts later regions forward).
	const inserts: { at: number; n: number }[] = [];
	let delta = 0;
	const patches: { lcOff: number; fieldOff: number; value: number }[] = [];
	for (const r of [...regions].sort((a, b) => a.start - b.start)) {
		let newStart = r.start + delta;
		const pad = (8 - (newStart % 8)) % 8;
		if (pad > 0) {
			// Insert at the region's ORIGINAL file offset (r.start), not at
			// newStart: inserts apply back-to-front, so earlier regions'
			// padding is not yet in the buffer when this one is applied.
			// newStart is only used to compute pad and the patched field value.
			inserts.push({ at: r.start, n: pad });
			delta += pad;
			newStart += pad;
		}
		patches.push({ lcOff: r.lcOff, fieldOff: r.fieldOff, value: newStart });
	}
	if (delta === 0) return false;

	// Apply inserts back-to-front so earlier offsets stay valid.
	let out = buf;
	for (const { at, n } of [...inserts].sort((a, b) => b.at - a.at)) {
		out = Buffer.concat([out.subarray(0, at), Buffer.alloc(n), out.subarray(at)]);
	}
	for (const p of patches) {
		out.writeUInt32LE(p.value, p.lcOff + p.fieldOff);
	}
	out.writeBigUInt64LE(BigInt(linkedit.filesize) + BigInt(delta), linkedit.lcOff + 48);
	await fs.writeFile(filePath, out);
	// The shifted code signature blob is stale; re-sign ad-hoc.
	execFileSync("codesign", ["--force", "--sign", "-", filePath], { stdio: "pipe" });
	return true;
}
