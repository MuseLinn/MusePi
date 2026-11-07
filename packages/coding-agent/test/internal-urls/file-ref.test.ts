/**
 * Contracts for the cross-boundary `FileRef` union:
 *
 * - All three schemes round-trip through `parseFileRef` / `formatFileRef`.
 * - Blob hashes, artifact session ids, and workspace paths fail closed on the
 *   shapes each resolver joins into a filesystem path.
 * - An unrecognized scheme is not silently read as a workspace path.
 */
import { describe, expect, it } from "bun:test";
import { type FileRef, formatFileRef, parseFileRef } from "@musepi/pi-wire";

const HASH = "0123456789abcdef".repeat(4);

describe("FileRef parse/format", () => {
	it("round-trips every scheme through its canonical text form", () => {
		const refs: FileRef[] = [
			{ scheme: "blob", hash: HASH },
			{ scheme: "artifact", seq: "7" },
			{ scheme: "artifact", sessionId: "2026-01-02T03-04-05_abc", seq: "12" },
			{ scheme: "workspace", path: "docs/readme.md" },
		];

		for (const ref of refs) {
			const text = formatFileRef(ref);
			expect(parseFileRef(text)).toEqual(ref);
			expect(formatFileRef(parseFileRef(text) as FileRef)).toBe(text);
		}
	});

	it("formats the persisted blob spelling as the readable URL", () => {
		const readable = `blob://${HASH}`;

		expect(parseFileRef(`blob:sha256:${HASH}`)).toEqual({ scheme: "blob", hash: HASH });
		expect(parseFileRef(readable)).toEqual({ scheme: "blob", hash: HASH });
		expect(formatFileRef({ scheme: "blob", hash: HASH })).toBe(readable);
	});

	it("rejects blob text that is not a bare canonical SHA-256 hash", () => {
		for (const input of [
			`blob://${HASH.toUpperCase()}`,
			"blob://short",
			`blob://${HASH}/extra`,
			`blob://${HASH}:1-3000`,
			"blob:sha256:../../secret.txt",
			"blob://",
		]) {
			expect(parseFileRef(input)).toBeNull();
		}
	});

	it("rejects artifact forms whose session id or seq could escape the session dir", () => {
		for (const input of [
			"artifact://../3",
			"artifact://./3",
			"artifact://.hidden/3",
			"artifact://session/3/extra",
			"artifact://session/",
			"artifact://not-numeric",
			"artifact://",
		]) {
			expect(parseFileRef(input)).toBeNull();
		}
		expect(parseFileRef("artifact://0")).toEqual({ scheme: "artifact", seq: "0" });
	});

	it("rejects workspace paths that are absolute or climb out of the workspace", () => {
		for (const input of [
			"../etc/passwd",
			"a/../../b",
			"/abs/path",
			"\\server\\share\\file",
			"C:/Windows/win.ini",
			"C:\\Windows\\win.ini",
			"",
		]) {
			expect(parseFileRef(input)).toBeNull();
		}
		expect(parseFileRef("src/tools/read.ts")).toEqual({ scheme: "workspace", path: "src/tools/read.ts" });
	});

	it("returns null for an unknown scheme instead of treating it as a path", () => {
		expect(parseFileRef("ftp://example.com/file.txt")).toBeNull();
		expect(parseFileRef("http://example.com")).toBeNull();
	});
});
