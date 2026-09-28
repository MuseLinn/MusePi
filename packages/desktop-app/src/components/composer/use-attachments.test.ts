import { describe, expect, test } from "bun:test";
import {
	attachmentFiles,
	attachmentImageParts,
	type ComposerAttachment,
	reorderAttachmentChips,
	uniqueAttachmentName,
} from "./use-attachments";

const chip = (id: number, kind: "image" | "file", name: string, file?: File): ComposerAttachment => ({
	id,
	kind,
	dataUrl: kind === "image" ? `data:image/png;base64,AA${id}` : "",
	mimeType: kind === "image" ? "image/png" : "application/octet-stream",
	name,
	size: 1,
	...(file ? { file } : {}),
});

describe("reorderAttachmentChips", () => {
	test("moving a chip to another position shifts the chips in between", () => {
		const chips = [
			chip(1, "image", "a.png"),
			chip(2, "image", "b.png"),
			chip(3, "image", "c.png"),
			chip(4, "file", "d.pdf"),
		];
		expect(reorderAttachmentChips(chips, 1, 3).map(c => c.id)).toEqual([2, 3, 1, 4]);
	});

	test("unknown ids or a same-chip drop are no-ops (reference-stable)", () => {
		const chips = [chip(1, "image", "a.png"), chip(2, "file", "b.pdf")];
		expect(reorderAttachmentChips(chips, 1, 1)).toBe(chips);
		expect(reorderAttachmentChips(chips, 1, 99)).toBe(chips);
		expect(reorderAttachmentChips(chips, 99, 1)).toBe(chips);
	});
});

describe("attachment send projection follows chip order (drag-reorder contract)", () => {
	test("image parts ride the wire in the reordered chip order", () => {
		const i1 = chip(1, "image", "a.png");
		const f1 = chip(2, "file", "b.pdf");
		const i2 = chip(3, "image", "c.png");
		// Send order before the drag: a.png, c.png.
		expect(attachmentImageParts([i1, f1, i2]).map(p => p.data)).toEqual(["AA1", "AA3"]);
		// The user drags c.png ahead of a.png: the wire order flips too.
		const reordered = reorderAttachmentChips([i1, f1, i2], 3, 1);
		expect(reordered.map(c => c.id)).toEqual([3, 1, 2]);
		expect(attachmentImageParts(reordered).map(p => p.data)).toEqual(["AA3", "AA1"]);
	});

	test("file chips and their upload handles follow the reordered chip order", () => {
		const f1 = chip(1, "file", "one.pdf", new File(["x"], "one.pdf"));
		const i1 = chip(2, "image", "a.png");
		const f2 = chip(3, "file", "two.pdf", new File(["y"], "two.pdf"));
		const reordered = reorderAttachmentChips([f1, i1, f2], 1, 3);
		expect(reordered.map(c => c.id)).toEqual([2, 3, 1]);
		expect(attachmentFiles(reordered).map(f => f.name)).toEqual(["two.pdf", "one.pdf"]);
	});
});

describe("uniqueAttachmentName (duplicate paste names)", () => {
	test("pasted screenshots named image.png no longer collide — each keeps a distinct identity", () => {
		// Regression (2026-09-28): two pasted screenshots both arrive as
		// "image.png" and name-mention tokens resolve to the FIRST match, so
		// every mention pointed at the first image.
		const taken = new Set(["image.png"]);
		expect(uniqueAttachmentName("image.png", taken)).toBe("image-2.png");
		taken.add("image-2.png");
		expect(uniqueAttachmentName("image.png", taken)).toBe("image-3.png");
	});

	test("a fresh name passes through; the suffix goes before the extension", () => {
		expect(uniqueAttachmentName("report.pdf", new Set())).toBe("report.pdf");
		expect(uniqueAttachmentName("archive.tar.gz", new Set(["archive.tar.gz"]))).toBe("archive.tar-2.gz");
	});
});
