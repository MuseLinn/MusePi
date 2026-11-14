import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { markSketchChip, nextSketchFileName, uploadAttachmentFiles } from "../src/components/composer/use-attachments";

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

/** Minimal RpcClient stand-in: records upload calls and can fail on cue. */
function fakeRpc(opts: { failOn?: string; error?: string; failPath?: boolean } = {}) {
	const puts: { name: string; mimeType: string; content: string }[] = [];
	const filePuts: { path: string; name: string; mimeType: string }[] = [];
	return {
		puts,
		filePuts,
		client: {
			request: async (method: string, params: Record<string, unknown>) => {
				if (method === "attachment.putFile") {
					const p = params as { path: string; name: string; mimeType: string };
					filePuts.push(p);
					if (opts.failPath) return { error: "file not found" };
					if (opts.failOn === p.name) return { error: opts.error ?? "attachment.putFile failed" };
					const bytes = Buffer.from(`path:${p.path}`);
					const hash = new Bun.SHA256().update(bytes).digest("hex");
					return {
						ref: { scheme: "blob", hash, size: bytes.length, mimeType: p.mimeType, name: p.name },
						url: `blob://${hash}`,
					};
				}
				if (method !== "attachment.put") throw new Error(`unexpected method ${method}`);
				const p = params as { name: string; mimeType: string; content: string };
				puts.push(p);
				if (opts.failOn === p.name) return { error: opts.error ?? "attachment.put failed" };
				const bytes = Buffer.from(p.content, "base64");
				const hash = new Bun.SHA256().update(bytes).digest("hex");
				return {
					ref: { scheme: "blob", hash, size: bytes.length, mimeType: p.mimeType, name: p.name },
					url: `blob://${hash}`,
				};
			},
		} as never,
	};
}

const file = (name: string, body = "hello") => new File([body], name, { type: "application/octet-stream" });

describe("uploadAttachmentFiles — one channel for both composers", () => {
	test("uploads each chip as base64 and returns blob:// refs with the original name", async () => {
		const { client, puts } = fakeRpc();
		const refs = await uploadAttachmentFiles(client, "/ws", [
			{ file: file("report.pdf"), name: "report.pdf" },
			{ file: file("notes.txt", "hi"), name: "notes.txt" },
		]);
		const helloHash = new Bun.SHA256().update(Buffer.from("hello")).digest("hex");
		const hiHash = new Bun.SHA256().update(Buffer.from("hi")).digest("hex");
		expect(refs).toEqual([
			`[Attachment] blob://${helloHash} (report.pdf)`,
			`[Attachment] blob://${hiHash} (notes.txt)`,
		]);
		expect(puts).toHaveLength(2);
		// Base64, not the raw text — the daemon decodes it.
		expect(Buffer.from(puts[1]!.content, "base64").toString()).toBe("hi");
	});

	test("same-machine files go by path and never enter the RPC frame", async () => {
		const g = globalThis as unknown as { window?: unknown };
		const previous = g.window;
		g.window = { electronAPI: { getDroppedFilePath: () => "/tmp/big.pdf" } };
		try {
			const { client, puts, filePuts } = fakeRpc();
			const refs = await uploadAttachmentFiles(client, "/ws", [{ file: file("big.pdf"), name: "big.pdf" }]);

			expect(filePuts).toEqual([{ path: "/tmp/big.pdf", name: "big.pdf", mimeType: "application/octet-stream" }]);
			expect(puts).toHaveLength(0);
			expect(refs[0]!.startsWith("[Attachment] blob://")).toBe(true);
		} finally {
			g.window = previous;
		}
	});

	test("falls back to inline bytes when the daemon cannot read the path", async () => {
		const g = globalThis as unknown as { window?: unknown };
		const previous = g.window;
		g.window = { electronAPI: { getDroppedFilePath: () => "/missing/file.bin" } };
		try {
			const { client, puts, filePuts } = fakeRpc({ failPath: true });
			const refs = await uploadAttachmentFiles(client, "/ws", [
				{ file: file("file.bin", "bytes"), name: "file.bin" },
			]);

			expect(filePuts).toHaveLength(1);
			expect(puts).toHaveLength(1);
			expect(Buffer.from(puts[0]!.content, "base64").toString()).toBe("bytes");
			expect(refs).toHaveLength(1);
		} finally {
			g.window = previous;
		}
	});

	test("uses the upload staged when the chip appeared instead of re-sending", async () => {
		const { client, puts, filePuts } = fakeRpc();
		const staged = Promise.resolve({
			ref: { scheme: "blob" as const, hash: "b".repeat(64), size: 3, mimeType: "text/plain", name: "s.txt" },
			url: `blob://${"b".repeat(64)}`,
		});

		const refs = await uploadAttachmentFiles(client, "/ws", [{ file: file("s.txt"), name: "s.txt", staged }]);

		expect(puts).toHaveLength(0);
		expect(filePuts).toHaveLength(0);
		expect(refs).toEqual([`[Attachment] blob://${"b".repeat(64)} (s.txt)`]);
	});

	test("a staged upload that failed is retried rather than blocking the send", async () => {
		const { client, puts } = fakeRpc();
		const refs = await uploadAttachmentFiles(client, "/ws", [
			{ file: file("r.txt", "retry"), name: "r.txt", staged: Promise.resolve({ error: "boom" }) },
		]);

		expect(puts).toHaveLength(1);
		expect(refs).toHaveLength(1);
		expect(Buffer.from(puts[0]!.content, "base64").toString()).toBe("retry");
	});

	test("same-name chips keep their own bytes instead of overwriting each other", async () => {
		// Content addressing makes the hash the identity: two files called
		// "a.log" produce two blobs, so the second can no longer displace the
		// first on disk.
		const { client, puts } = fakeRpc();
		const refs = await uploadAttachmentFiles(client, "/ws", [
			{ file: file("a.log", "first"), name: "a.log" },
			{ file: file("a.log", "second"), name: "a.log" },
		]);
		expect(refs).toHaveLength(2);
		expect(refs[0]).not.toBe(refs[1]);
		expect(refs[1]!.endsWith("(a.log)")).toBe(true);
		expect(Buffer.from(puts[1]!.content, "base64").toString()).toBe("second");
	});

	test("identical bytes share one blob hash", async () => {
		const { client } = fakeRpc();
		const refs = await uploadAttachmentFiles(client, "/ws", [
			{ file: file("a.txt", "same"), name: "a.txt" },
			{ file: file("b.txt", "same"), name: "b.txt" },
		]);
		expect(refs[0]!.split(" ")[1]).toBe(refs[1]!.split(" ")[1]);
	});

	test("throws on the first failure so the caller can abort the send", async () => {
		const { client, puts } = fakeRpc({ failOn: "b.bin", error: "attachment too large" });
		await expect(
			uploadAttachmentFiles(client, "/ws", [
				{ file: file("a.bin"), name: "a.bin" },
				{ file: file("b.bin"), name: "b.bin" },
			]),
		).rejects.toThrow("attachment too large");
		// The failure is surfaced, not swallowed: nothing is returned for the
		// chips that did land, and no further chip is uploaded.
		expect(puts).toHaveLength(2);
	});

	test("refuses a chip whose handle is gone (restored draft)", async () => {
		const { client } = fakeRpc();
		await expect(uploadAttachmentFiles(client, "/ws", [{ name: "ghost.bin" }])).rejects.toThrow(
			"attachment expired re-add",
		);
	});

	test("needs no workspace — the blob store is content-addressed", async () => {
		// The empty-state composer reaches the daemon before any project is
		// resolved; an attachment upload must not depend on one.
		const { client } = fakeRpc();
		for (const cwd of [null, undefined]) {
			const refs = await uploadAttachmentFiles(client, cwd, [{ file: file("a.bin"), name: "a.bin" }]);
			expect(refs).toHaveLength(1);
		}
	});

	test("an empty batch is a no-op", async () => {
		const { client, puts } = fakeRpc();
		expect(await uploadAttachmentFiles(client, null, [])).toEqual([]);
		expect(puts).toHaveLength(0);
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
