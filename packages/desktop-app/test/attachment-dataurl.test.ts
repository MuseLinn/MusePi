import { describe, expect, test } from "bun:test";
import { dataUrlToFile, parseAttachmentDraft } from "../src/components/composer/use-attachments";

/** 1×1 transparent PNG, the smallest real data URL. */
const PNG_1PX =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

describe("dataUrlToFile — CSP-independent decode", () => {
	test("decodes a base64 data URL into a File with the right type", () => {
		// Regression: this used `await (await fetch(dataUrl)).blob()`, and
		// fetch on a data: URL is governed by the renderer CSP's connect-src,
		// which does not list data:. The call was blocked, the await threw,
		// and finishing a sketch silently produced no chip.
		const file = dataUrlToFile(PNG_1PX, "sketch-1.png");
		expect(file.name).toBe("sketch-1.png");
		expect(file.type).toBe("image/png");
		expect(file.size).toBeGreaterThan(0);
	});

	test("decoded bytes match the base64 payload", () => {
		const file = dataUrlToFile(PNG_1PX, "x.png");
		expect(file.size).toBeGreaterThan(50);
	});

	test("is synchronous — no promise to await", () => {
		// The call sites were rewritten from `await` to a direct call; keeping
		// this non-async is what removes the CSP dependency entirely.
		const file = dataUrlToFile(PNG_1PX, "y.png");
		expect(file).toBeInstanceOf(File);
		expect(typeof (file as unknown as { then?: unknown }).then).toBe("undefined");
	});

	test("falls back to a text decode for a non-base64 payload", () => {
		const file = dataUrlToFile("data:image/svg+xml,%3Csvg%3E", "a.svg");
		expect(file.type).toBe("image/svg+xml");
		expect(file.size).toBeGreaterThan(0);
	});

	test("uses a generic mime when the header omits one", () => {
		const file = dataUrlToFile("garbage", "a.bin");
		expect(file.type).toBe("application/octet-stream");
	});
});

describe("parseAttachmentDraft — the sketch flag round-trips", () => {
	test("keeps sketch:true so a restored chip reopens the board", () => {
		const raw = JSON.stringify([{ dataUrl: PNG_1PX, mimeType: "image/png", name: "sketch-1.png", sketch: true }]);
		const [chip] = parseAttachmentDraft(raw);
		expect(chip?.sketch).toBe(true);
	});

	test("leaves an ordinary image unflagged", () => {
		const raw = JSON.stringify([{ dataUrl: PNG_1PX, mimeType: "image/png", name: "photo.png" }]);
		const [chip] = parseAttachmentDraft(raw);
		expect(chip?.sketch).toBeUndefined();
	});

	test("drops malformed entries instead of rendering them", () => {
		const raw = JSON.stringify([{ nope: 1 }, { dataUrl: PNG_1PX, mimeType: "image/png", name: "ok.png" }]);
		expect(parseAttachmentDraft(raw)).toHaveLength(1);
	});

	test("survives junk input", () => {
		expect(parseAttachmentDraft(null)).toEqual([]);
		expect(parseAttachmentDraft("not json")).toEqual([]);
		expect(parseAttachmentDraft('{"not":"an array"}')).toEqual([]);
	});
});
