/**
 * Speech-model download events ride the daemon's **global** stream, not the
 * session stream, and arrive as untyped `payload` bags — the guard is the
 * only thing keeping a `t:"event"` frame from being misread as progress.
 */
import { describe, expect, it } from "bun:test";
import { isSttDownloadEvent } from "../src";

describe("isSttDownloadEvent", () => {
	it("accepts all three stt.download variants", () => {
		expect(isSttDownloadEvent({ type: "stt.downloadProgress", modelKey: "base", percent: 42 })).toBe(true);
		expect(isSttDownloadEvent({ type: "stt.downloadDone", modelKey: "base" })).toBe(true);
		expect(isSttDownloadEvent({ type: "stt.downloadError", modelKey: "base", message: "disk full" })).toBe(true);
	});

	it("rejects progress without a numeric percent", () => {
		expect(isSttDownloadEvent({ type: "stt.downloadProgress", modelKey: "base" })).toBe(false);
	});

	it("rejects session events and non-objects", () => {
		expect(isSttDownloadEvent({ type: "message_update" })).toBe(false);
		expect(isSttDownloadEvent({ type: "stt.downloadNope", modelKey: "base" })).toBe(false);
		expect(isSttDownloadEvent(null)).toBe(false);
		expect(isSttDownloadEvent("stt.downloadDone")).toBe(false);
	});
});
