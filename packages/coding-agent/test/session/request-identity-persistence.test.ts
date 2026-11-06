import { describe, expect, it } from "bun:test";
import { loadEntriesFromFile } from "@musepi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { TempDir } from "@musepi/pi-utils";

/**
 * The send idempotency identity must survive a daemon restart, so it is stored
 * on the user message entry itself — not only in a process-local map.
 */
describe("request identity persistence", () => {
	it("writes requestIdentity/requestFingerprint onto the user message entry", async () => {
		using tempDir = TempDir.createSync("@omp-request-identity-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({
			role: "user",
			content: "hello",
			timestamp: Date.now(),
			requestIdentity: "msg:device-a:request-1",
			requestFingerprint: "fingerprint-1",
		});
		await manager.ensureOnDisk();
		await manager.flush();
		const file = manager.getSessionFile();
		expect(file).toBeString();
		const entries = await loadEntriesFromFile(file!);
		const message = entries.find(entry => entry.type === "message" && entry.message.role === "user");
		expect(message?.type).toBe("message");
		if (message?.type !== "message") throw new Error("expected a message entry");
		expect(message.message).toMatchObject({
			role: "user",
			content: "hello",
			requestIdentity: "msg:device-a:request-1",
			requestFingerprint: "fingerprint-1",
		});
	});
});
