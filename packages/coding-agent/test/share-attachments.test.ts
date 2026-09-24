import { describe, expect, test } from "bun:test";
import type { SessionData } from "../src/export/html";
import {
	buildShareSnapshot,
	computeAttachmentStats,
	MAX_SHARE_ATTACHMENT_BYTES,
	SERVER_MAX_SEALED_BYTES,
	ShareTooLargeError,
	sealToFit,
	shareSession,
} from "../src/export/share";
import { SecretObfuscator } from "../src/secrets/obfuscator";
import type { SessionEntry } from "../src/session/session-entries";
import type { SessionManager } from "../src/session/session-manager";

const IV_LENGTH = 12;

async function makeKey(): Promise<CryptoKey> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Mirror of share-loader.js: AES-GCM open + gunzip + parse. */
async function open(key: CryptoKey, sealed: Uint8Array<ArrayBuffer>): Promise<SessionData> {
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: sealed.subarray(0, IV_LENGTH) },
		key,
		sealed.subarray(IV_LENGTH),
	);
	return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(plain))));
}

/** Incompressible filler so gzip cannot absorb the payload (mirrors test/share.test.ts). */
function randomHex(words: number): string {
	return Array.from(crypto.getRandomValues(new Uint32Array(words)), v => v.toString(16)).join("");
}

function header(): SessionData["header"] {
	return { type: "session", version: 3, id: "t", timestamp: "2026-06-12T00:00:00.000Z", cwd: "/tmp" };
}

function sessionData(entries: SessionEntry[], leafId: string): SessionData {
	return { header: header(), entries, leafId };
}

function messageEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-06-12T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }] },
	} as unknown as SessionEntry;
}

/** A fileMention entry carrying the given file payloads. */
function fileMentionEntry(id: string, files: Array<{ path: string; content: string; image?: unknown }>): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-12T00:00:00.000Z",
		message: { role: "fileMention", files, timestamp: 1 },
	} as unknown as SessionEntry;
}

function mockSm(entries: SessionEntry[], leafId: string): SessionManager {
	return {
		getHeader: () => header(),
		getEntries: () => entries,
		getLeafId: () => leafId,
	} as unknown as SessionManager;
}

describe("computeAttachmentStats", () => {
	test("tallies file-mention contents and inline image bytes from the raw snapshot", () => {
		const smallFile = "x".repeat(100);
		const bigFile = "y".repeat(200);
		const fileImage = { type: "image", data: "z".repeat(50), mimeType: "image/png" };
		const inlineImageData = "w".repeat(3_000);
		const entries = [
			fileMentionEntry("f1", [
				{ path: "/a.txt", content: smallFile },
				{ path: "/b.txt", content: bigFile, image: fileImage },
			]),
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-06-12T00:00:00.000Z",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "hi" },
						{ type: "image", data: inlineImageData, mimeType: "image/png" },
					],
					timestamp: 2,
				},
			} as unknown as SessionEntry,
		];
		const data = sessionData(entries, "u1");

		const stats = computeAttachmentStats(data);

		// Two file-mention entries; the second also carries an inline `image` block.
		expect(stats.fileMentions).toBe(2);
		expect(stats.fileMentionBytes).toBe(300);
		// One inline image in a file-mention (`file.image`) + one inline image block in content.
		expect(stats.inlineImages).toBe(2);
		expect(stats.inlineImageBytes).toBe(3050);
		expect(stats.totalBytes).toBe(3350);
	});

	test("counts attachments inside sub-sessions, not just the main entries", () => {
		const entries = [messageEntry("e1", null, "plain text only")];
		const data = sessionData(entries, "e1");
		data.subSessions = {
			ToolAsk: {
				agentId: "ToolAsk",
				parent: null,
				header: header(),
				entries: [fileMentionEntry("sub-f", [{ path: "/sub.txt", content: "q".repeat(400) }])],
				leafId: "sub-f",
			},
		};

		const stats = computeAttachmentStats(data);

		expect(stats.fileMentions).toBe(1);
		expect(stats.fileMentionBytes).toBe(400);
		expect(stats.totalBytes).toBe(400);
	});

	test("reports zero across the board for a text-only session", () => {
		const data = sessionData([messageEntry("e1", null, "no attachments here")], "e1");
		const stats = computeAttachmentStats(data);
		expect(stats).toEqual({
			fileMentions: 0,
			fileMentionBytes: 0,
			inlineImages: 0,
			inlineImageBytes: 0,
			totalBytes: 0,
		});
	});
});

describe("share pre-publish attachment interception", () => {
	test("rejects an oversized-attachment share with a structured, retryable reason (not a silent truncation)", async () => {
		// A single file-mention whose content blows past the raw attachment budget.
		const entries = [fileMentionEntry("f1", [{ path: "/huge.log", content: randomHex(6_000_000) }])];
		const sm = mockSm(entries, "f1");

		let err: unknown;
		try {
			await shareSession(sm);
		} catch (e) {
			err = e;
		}

		expect(err).toBeInstanceOf(ShareTooLargeError);
		const e = err as ShareTooLargeError;
		// The caller can offer "strip attachments and continue" because the rejection is attachment-specific.
		expect(e.detail.canRetryWithStrippedAttachments).toBe(true);
		expect(e.detail.strippedAttachments).toBe(0);
		expect(e.detail.maxBytes).toBe(MAX_SHARE_ATTACHMENT_BYTES);
		// The message is human-readable and names the attachment budget, not a bare size error.
		expect(e.message).toContain("attachments too large to share");
		expect(e.message).toContain(String(MAX_SHARE_ATTACHMENT_BYTES));
	});

	test("does not reject a small attachment, and uploads normally", async () => {
		const entries = [
			fileMentionEntry("f1", [{ path: "/small.txt", content: "a".repeat(50) }]),
			messageEntry("e1", "f1", "hi"),
		];
		const sm = mockSm(entries, "e1");

		let uploaded: Uint8Array<ArrayBuffer> | null = null;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method !== "POST") return new Response("nope", { status: 405 });
				uploaded = new Uint8Array(await req.arrayBuffer());
				return Response.json({ id: "okid000001" });
			},
		});
		try {
			const result = await shareSession(sm, { serverUrl: `http://localhost:${server.port}` });
			expect(result.method).toBe("server");
			expect(result.strippedAttachments).toBe(0);
			expect(uploaded).not.toBeNull();
		} finally {
			server.stop(true);
		}
	});

	test("with stripAttachments:true, strips the attachment and still shares, reporting how many were removed", async () => {
		const entries = [fileMentionEntry("f1", [{ path: "/huge.log", content: randomHex(6_000_000) }])];
		const sm = mockSm(entries, "f1");

		let uploaded: Uint8Array<ArrayBuffer> | null = null;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method !== "POST") return new Response("nope", { status: 405 });
				uploaded = new Uint8Array(await req.arrayBuffer());
				return Response.json({ id: "okid000002" });
			},
		});
		try {
			const result = await shareSession(sm, {
				serverUrl: `http://localhost:${server.port}`,
				stripAttachments: true,
			});

			// The share succeeded despite the 6 MB attachment...
			expect(result.method).toBe("server");
			expect(result.sealedBytes).toBeLessThanOrEqual(SERVER_MAX_SEALED_BYTES);
			// ...and the caller now knows exactly how many attachments were stripped.
			expect(result.strippedAttachments).toBeGreaterThanOrEqual(1);

			// The sealed blob no longer carries the raw attachment content.
			const key = await crypto.subtle.importKey(
				"raw",
				Buffer.from(result.url.split("#")[1]!, "base64url"),
				"AES-GCM",
				false,
				["decrypt"],
			);
			const opened = await open(key, uploaded as unknown as Uint8Array<ArrayBuffer>);
			const flat = JSON.stringify(opened);
			expect(flat).toContain("/huge.log"); // the file reference survives
			expect(flat).not.toContain("f1f1"); // raw random content is gone (placeholdered)
			expect(flat).toContain("[file content omitted from share]");
		} finally {
			server.stop(true);
		}
	});
});

describe("sealToFit attachment stripping", () => {
	test("strips file-mention contents as an explicit step and reports the count", async () => {
		const entries = [
			fileMentionEntry("f1", [{ path: "/a.txt", content: randomHex(3_000_000) }]),
			fileMentionEntry("f2", [{ path: "/b.txt", content: randomHex(3_000_000) }]),
		];
		const data = sessionData(entries, "f2");
		const key = await makeKey();

		const { sealed, truncated, strippedAttachments } = await sealToFit(key, data, SERVER_MAX_SEALED_BYTES);

		expect(truncated).toBe(true);
		// Two file-mention payloads were stripped.
		expect(strippedAttachments).toBe(2);
		expect(sealed.byteLength).toBeLessThanOrEqual(SERVER_MAX_SEALED_BYTES);

		const opened = await open(key, sealed);
		for (const entry of opened.entries) {
			if (entry.type !== "message") continue;
			const message = entry.message as { role?: string; files?: Array<{ path: string; content: string }> };
			if (message.role !== "fileMention") continue;
			for (const file of message.files ?? []) {
				// Path reference survives; the heavy content is replaced with the omission marker.
				expect(file.content).toBe("[file content omitted from share]");
			}
		}
	});

	test("strips inline images and file-mention contents together under one reported count", async () => {
		const inlineImageData = randomHex(2_000_000);
		const entries = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-06-12T00:00:00.000Z",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "see screenshot" },
						{ type: "image", data: inlineImageData, mimeType: "image/png" },
					],
					timestamp: 1,
				},
			} as unknown as SessionEntry,
			fileMentionEntry("f1", [{ path: "/c.txt", content: randomHex(2_000_000) }]),
		];
		const data = sessionData(entries, "f1");
		const key = await makeKey();

		const { sealed, truncated, strippedAttachments } = await sealToFit(key, data, SERVER_MAX_SEALED_BYTES);

		expect(truncated).toBe(true);
		// One inline image + one file-mention content = 2 stripped payloads.
		expect(strippedAttachments).toBe(2);
		const flat = JSON.stringify(await open(key, sealed));
		expect(flat).toContain("[image omitted from share]");
		expect(flat).toContain("[file content omitted from share]");
		expect(flat).toContain("see screenshot");
	});
});

describe("redaction ordering vs attachment stripping (hard constraint)", () => {
	test("redaction's whole-snapshot pre-scan sees file-mention attachment bytes before they are stripped", async () => {
		// A plain secret with a friendly name that would collide with the regex secret's normalized
		// form, and a regex secret that lives ONLY inside a (large, to-be-stripped) file-mention
		// attachment. Redaction must pre-scan the attachment content BEFORE sealToFit strips it; if
		// stripping ran first, the pre-scan would miss the regex secret and the header's plain-secret
		// placeholder would be minted WITHOUT collision avoidance (it would contain "TOKABC123_").
		const plainSecret = "OTHERSECRET";
		const friendlyName = "TOKABC123";
		const regexSecret = "tok_abc123";
		const headerWithPlain = {
			...header(),
			title: `investigating ${plainSecret}`,
		};
		const entries = [
			fileMentionEntry("f1", [
				{ path: "/leak.log", content: `${randomHex(4_000_000)} ${regexSecret} ${randomHex(1_000_000)}` },
			]),
		];
		const sm = {
			getHeader: () => headerWithPlain,
			getEntries: () => entries,
			getLeafId: () => "f1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: plainSecret, friendlyName },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);

		// Redaction happens here, in buildShareSnapshot — its pre-scan must already cover the
		// file-mention content before sealToFit strips it below.
		const snapshot = buildShareSnapshot(sm, { obfuscator });
		const key = await makeKey();
		const { sealed, strippedAttachments } = await sealToFit(key, snapshot, SERVER_MAX_SEALED_BYTES);

		// The attachment was actually stripped, exercising the post-redaction step.
		expect(strippedAttachments).toBeGreaterThanOrEqual(1);

		const flat = JSON.stringify(await open(key, sealed));
		// Neither raw secret leaks.
		expect(flat).not.toContain(plainSecret);
		expect(flat).not.toContain(regexSecret);
		// Collision avoidance stayed active: the pre-scan saw the regex secret inside the (later
		// stripped) file mention, so the header's plain-secret placeholder avoids the friendly prefix.
		// A mis-ordered implementation that stripped before redacting would let "TOKABC123_" appear.
		expect(flat).not.toContain(`${friendlyName}_`);
	});
});
