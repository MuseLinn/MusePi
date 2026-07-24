import { describe, expect, it } from "vitest";
import { detectSupportedVideoMimeType } from "../src/utils/mime.ts";

function bytes(...values: number[]): Uint8Array {
	return new Uint8Array(values);
}

function ascii(text: string): number[] {
	return [...text].map((ch) => ch.charCodeAt(0));
}

/** Build a minimal ISO-BMFF-style header: 4 size bytes + "ftyp" + major brand. */
function ftypHeader(brand: string): Uint8Array {
	return bytes(0x00, 0x00, 0x00, 0x18, ...ascii("ftyp"), ...ascii(brand), 0x00, 0x00, 0x02, 0x00);
}

describe("detectSupportedVideoMimeType", () => {
	it("detects mp4 from ftyp isom brand", () => {
		expect(detectSupportedVideoMimeType(ftypHeader("isom"))).toBe("video/mp4");
	});

	it("detects quicktime from ftyp qt brand", () => {
		expect(detectSupportedVideoMimeType(ftypHeader("qt  "))).toBe("video/quicktime");
	});

	it("detects 3gpp from ftyp 3gp brand", () => {
		expect(detectSupportedVideoMimeType(ftypHeader("3gp4"))).toBe("video/3gpp");
	});

	it("rejects audio-only m4a ftyp brand", () => {
		expect(detectSupportedVideoMimeType(ftypHeader("M4A "))).toBeNull();
	});

	it("rejects still-image avif ftyp brand", () => {
		expect(detectSupportedVideoMimeType(ftypHeader("avif"))).toBeNull();
	});

	it("detects webm from EBML magic", () => {
		const header = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, ...ascii("webm"));
		expect(detectSupportedVideoMimeType(header)).toBe("video/webm");
	});

	it("detects matroska from EBML magic with matroska DocType", () => {
		const header = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, ...ascii("matroska"));
		expect(detectSupportedVideoMimeType(header)).toBe("video/x-matroska");
	});

	it("detects avi from RIFF AVI header", () => {
		const header = bytes(...ascii("RIFF"), 0x10, 0x00, 0x00, 0x00, ...ascii("AVI "));
		expect(detectSupportedVideoMimeType(header)).toBe("video/x-msvideo");
	});

	it("detects flv from FLV magic", () => {
		expect(detectSupportedVideoMimeType(bytes(...ascii("FLV"), 0x01))).toBe("video/x-flv");
	});

	it("detects mpeg from pack/sequence start codes", () => {
		expect(detectSupportedVideoMimeType(bytes(0x00, 0x00, 0x01, 0xba))).toBe("video/mpeg");
		expect(detectSupportedVideoMimeType(bytes(0x00, 0x00, 0x01, 0xb3))).toBe("video/mpeg");
	});

	it("returns null for text and images", () => {
		expect(detectSupportedVideoMimeType(bytes(...ascii("just some text")))).toBeNull();
		expect(detectSupportedVideoMimeType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBeNull(); // jpeg
		expect(detectSupportedVideoMimeType(bytes(0x89, ...ascii("PNG")))).toBeNull();
	});
});
