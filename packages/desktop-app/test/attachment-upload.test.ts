import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	attachmentWorkspacePath,
	markSketchChip,
	nextSketchFileName,
	uploadAttachmentFiles,
} from "../src/components/composer/use-attachments";

/**
 * `readFileAsBase64` goes through FileReader, which bun's test runtime does
 * not provide (it is a browser/Electron global). Shimming it here keeps the
 * production code on the native path instead of adding a test-only branch —
 * install-and-restore at the top level, the same discipline the other
 * DOM-touching suites in this package use.
 */
class TestFileReader {
	result: string | ArrayBuffer | null = null;
	error: unknown = null;
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	readAsDataURL(file: File): void {
		void file
			.arrayBuffer()
			.then(buf => {
				const b64 = Buffer.from(buf).toString("base64");
				this.result = `data:${file.type || "application/octet-stream"};base64,${b64}`;
				this.onload?.();
			})
			.catch(err => {
				this.error = err;
				this.onerror?.();
			});
	}
}

const g = globalThis as unknown as { FileReader?: unknown };
let savedFileReader: unknown;
beforeAll(() => {
	savedFileReader = g.FileReader;
	g.FileReader = TestFileReader;
});
afterAll(() => {
	g.FileReader = savedFileReader;
});

/** Minimal RpcClient stand-in: records fs.write calls and can fail on cue. */
function fakeRpc(opts: { failOn?: string; ok?: boolean; error?: string } = {}) {
	const writes: { cwd: string; path: string; content: string; encoding: string }[] = [];
	const files = new Map<string, string>();
	return {
		writes,
		files,
		client: {
			request: async (method: string, params: Record<string, unknown>) => {
				if (method !== "fs.write") throw new Error(`unexpected method ${method}`);
				const p = params as { cwd: string; path: string; content: string; encoding: string };
				writes.push(p);
				if (opts.failOn === p.path || opts.ok === false)
					return { ok: false, error: opts.error ?? "fs.write failed" };
				files.set(p.path, p.content);
				return { ok: true };
			},
		} as never,
	};
}

const file = (name: string, body = "hello") => new File([body], name, { type: "application/octet-stream" });

describe("uploadAttachmentFiles — one channel for both composers", () => {
	test("writes each chip as base64 and returns [Attachment] refs", async () => {
		const { client, writes, files } = fakeRpc();
		const refs = await uploadAttachmentFiles(client, "/ws", [
			{ file: file("report.pdf"), name: "report.pdf" },
			{ file: file("notes.txt", "hi"), name: "notes.txt" },
		]);
		expect(refs).toEqual(["[Attachment] attachments/report.pdf", "[Attachment] attachments/notes.txt"]);
		expect(writes).toHaveLength(2);
		expect(writes.every(w => w.encoding === "base64" && w.cwd === "/ws")).toBe(true);
		// Base64, not the raw text — the daemon decodes it.
		expect(files.get("attachments/notes.txt")).toBe(Buffer.from("hi").toString("base64"));
	});

	test("same-name chips get -2 suffixes instead of overwriting", async () => {
		// Regression: the suffixing used to live inline in Composer.tsx only.
		// Extracting it must not drop it — two files called "a.log" in one
		// send would otherwise collide and the second would silently win.
		const { client, writes } = fakeRpc();
		const refs = await uploadAttachmentFiles(client, "/ws", [
			{ file: file("a.log", "first"), name: "a.log" },
			{ file: file("a.log", "second"), name: "a.log" },
			{ file: file("a.log", "third"), name: "a.log" },
		]);
		expect(refs).toEqual([
			"[Attachment] attachments/a.log",
			"[Attachment] attachments/a-2.log",
			"[Attachment] attachments/a-3.log",
		]);
		expect(writes.map(w => w.path)).toEqual(["attachments/a.log", "attachments/a-2.log", "attachments/a-3.log"]);
	});

	test("sanitizes traversal out of the client-supplied name", async () => {
		const { client, writes } = fakeRpc();
		const refs = await uploadAttachmentFiles(client, "/ws", [
			{ file: file("x"), name: "../../etc/passwd" },
			{ file: file("y"), name: "dir\\sub\\ok.txt" },
		]);
		expect(refs[0]).toBe("[Attachment] attachments/passwd");
		expect(refs[1]).toBe("[Attachment] attachments/ok.txt");
		// Nothing escapes the workspace prefix.
		expect(writes.every(w => w.path.startsWith("attachments/") && !w.path.includes(".."))).toBe(true);
	});

	test("throws on the first failure so the caller can abort the send", async () => {
		const { client } = fakeRpc({ ok: false, error: "disk full" });
		await expect(uploadAttachmentFiles(client, "/ws", [{ file: file("a.bin"), name: "a.bin" }])).rejects.toThrow(
			"disk full",
		);
	});

	test("refuses a chip whose handle is gone (restored draft)", async () => {
		const { client } = fakeRpc();
		await expect(uploadAttachmentFiles(client, "/ws", [{ name: "ghost.bin" }])).rejects.toThrow(
			"attachment expired re-add",
		);
	});

	test("refuses to upload without a workspace", async () => {
		// The empty-state composer hits this when the host could not resolve a
		// project for the session it created — better a clear refusal than a
		// prompt referencing a file that was never written.
		const { client } = fakeRpc();
		await expect(uploadAttachmentFiles(client, null, [{ file: file("a.bin"), name: "a.bin" }])).rejects.toThrow(
			"no workspace for attachments",
		);
		await expect(uploadAttachmentFiles(client, undefined, [{ file: file("a.bin"), name: "a.bin" }])).rejects.toThrow(
			"no workspace for attachments",
		);
	});

	test("an empty batch is a no-op, not a workspace demand", async () => {
		const { client, writes } = fakeRpc();
		expect(await uploadAttachmentFiles(client, null, [])).toEqual([]);
		expect(writes).toHaveLength(0);
	});
});

describe("attachmentWorkspacePath — unchanged contract after extraction", () => {
	test("prefixes and sanitizes", () => {
		expect(attachmentWorkspacePath("a b.png")).toBe("attachments/a b.png");
		expect(attachmentWorkspacePath("C:\\x\\y.png")).toBe("attachments/y.png");
		expect(attachmentWorkspacePath("../../evil")).toBe("attachments/evil");
		expect(attachmentWorkspacePath("")).toBe("attachments/file");
	});

	test("keeps CJK names (they are common in this user base)", () => {
		expect(attachmentWorkspacePath("设计稿.png")).toBe("attachments/设计稿.png");
	});
});

describe("board chip identity — the click-to-extend contract", () => {
	test("a finished board's name is unique even within the same millisecond", () => {
		// Two finishes in the same ms used to share a name — marking then hit
		// both chips and a re-edit targeted the wrong one.
		const a = nextSketchFileName(1_700_000_000_000);
		const b = nextSketchFileName(1_700_000_000_000);
		expect(a).not.toBe(b);
		// Still recognizably a board chip (drafts and logs read these names).
		expect(a.startsWith("sketch-")).toBe(true);
		expect(a.endsWith(".png")).toBe(true);
	});

	test("marking targets exactly the chip that was added", () => {
		const chips = [
			{ id: 1, kind: "image" as const, name: "sketch-old.png" },
			{ id: 2, kind: "image" as const, name: "sketch-new.png" },
		];
		const marked = markSketchChip(chips, "sketch-new.png");
		expect(marked[0]?.sketch).toBeUndefined();
		expect(marked[1]?.sketch).toBe(true);
	});

	test("does not match on the sketch- prefix alone (the original bug)", () => {
		// A chip named `sketch-…` for an unrelated reason (or an OLDER board
		// chip) must not be re-flagged by a later finish.
		const chips = [{ id: 1, kind: "image" as const, name: "sketch-1.png" }];
		const marked = markSketchChip(chips, "sketch-2.png");
		expect(marked[0]?.sketch).toBeUndefined();
	});

	test("leaves file chips alone even on a name collision", () => {
		const chips = [
			{ id: 1, kind: "file" as const, name: "sketch-a.png" },
			{ id: 2, kind: "image" as const, name: "sketch-a.png" },
		];
		const marked = markSketchChip(chips, "sketch-a.png");
		expect(marked[0]?.sketch).toBeUndefined();
		expect(marked[1]?.sketch).toBe(true);
	});

	test("is idempotent — re-marking never flips a flag back off", () => {
		const once = markSketchChip([{ id: 1, kind: "image" as const, name: "n.png" }], "n.png");
		const twice = markSketchChip(once, "n.png");
		expect(twice[0]?.sketch).toBe(true);
	});

	test("the mark must land AFTER the add settles", async () => {
		// This is the defect the user reported: the marking call ran before
		// addFiles resolved, so it mapped the pre-add (empty) array and the
		// flag vanished — the chip then opened the plain image preview instead
		// of the board. Model both orders against a deferred add.
		const add = async (chips: { id: number; kind: "image" | "file"; name: string }[], name: string) => {
			await Promise.resolve(); // the settings read addFiles awaits
			chips.push({ id: 1, kind: "image", name });
			return chips;
		};

		// BEFORE (wrong): mark runs against the empty pre-add state.
		type Chip = { id: number; kind: "image" | "file"; name: string; sketch?: boolean };
		let chips: Chip[] = [];
		let earlyMarked: Chip[] = [];
		const pending = add(chips, "sketch-x.png");
		earlyMarked = markSketchChip(chips, "sketch-x.png");
		chips = await pending;
		expect(earlyMarked).toHaveLength(0);
		expect(chips[0]?.sketch).toBeUndefined();

		// AFTER (correct): mark runs once the chip exists.
		let chips2: Chip[] = [];
		chips2 = await add(chips2, "sketch-y.png");
		const lateMarked = markSketchChip(chips2, "sketch-y.png");
		expect(lateMarked[0]?.sketch).toBe(true);
	});
});
