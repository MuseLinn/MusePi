import { describe, expect, test } from "bun:test";
import type { AttachmentGetResult } from "@musepi/pi-wire";
import { blobImageHash, resolveBlobImageSrc } from "../src/lib/blob-image";

const hash = "a".repeat(64);
const ref = `blob:sha256:${hash}`;

function page(bytes: Uint8Array, size: number, offset: number): AttachmentGetResult {
	return { content: Buffer.from(bytes).toString("base64"), size, offset };
}

describe("blob image refs", () => {
	test("recognizes only content-addressed refs", () => {
		expect(blobImageHash(ref)).toBe(hash);
		expect(blobImageHash("data:image/png;base64,AAAA")).toBeNull();
		expect(blobImageHash(`blob:sha256:${"z".repeat(64)}`)).toBeNull();
	});

	test("resolves a ref into a data URL through the host", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		const read = async () => page(bytes, bytes.length, 0);

		const src = await resolveBlobImageSrc(ref, "image/webp", read);

		expect(src).toBe(`data:image/webp;base64,${Buffer.from(bytes).toString("base64")}`);
	});

	test("keeps the src when the host cannot read or the blob is gone", async () => {
		const unresolved = `blob:sha256:${"d".repeat(64)}`;
		const missing = `blob:sha256:${"e".repeat(64)}`;
		expect(await resolveBlobImageSrc(unresolved, "image/png", undefined)).toBe(unresolved);
		expect(await resolveBlobImageSrc(missing, "image/png", async () => ({ error: "blob not found" }))).toBe(missing);
	});

	test("a later read serves from the resolved cache", async () => {
		const otherHash = "b".repeat(64);
		let calls = 0;
		const read = async () => {
			calls += 1;
			return page(new Uint8Array([9, 9, 9]), 3, 0);
		};

		await resolveBlobImageSrc(`blob:sha256:${otherHash}`, "image/png", read);
		await resolveBlobImageSrc(`blob:sha256:${otherHash}`, "image/png", read);

		expect(calls).toBe(1);
	});

	test("paged reads concatenate by decoded bytes, not base64 text", async () => {
		// 7 bytes split 4 + 3: the first page's base64 does not end on a
		// 3-byte group boundary, so joining strings would corrupt the tail.
		const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
		const read = async (hashArg: string, offset = 0, limit?: number) => {
			expect(hashArg).toBe("c".repeat(64));
			expect(limit).toBeGreaterThan(0);
			const pageBytes = offset === 0 ? bytes.subarray(0, 4) : bytes.subarray(4);
			return page(pageBytes, bytes.length, offset);
		};

		const src = await resolveBlobImageSrc(`blob:sha256:${"c".repeat(64)}`, "image/png", read);

		expect(src).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
	});
});
