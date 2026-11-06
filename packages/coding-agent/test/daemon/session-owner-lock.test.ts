import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireSessionOwnerLock,
	readSessionOwner,
	SessionOwnedError,
} from "@musepi/pi-coding-agent/daemon/session-owner-lock";
import { TempDir } from "@musepi/pi-utils";

const waiter = async (dir: string, sessionId: string): Promise<string> => path.join(dir, `${sessionId}.owner`);

describe("session owner lock", () => {
	it("acquires and releases the owner file", async () => {
		using tempDir = TempDir.createSync("@omp-session-owner-");
		const dir = path.join(tempDir.path(), "locks");
		const lock = await acquireSessionOwnerLock("s1", dir);
		expect((await readSessionOwner("s1", dir))?.pid).toBe(process.pid);
		await lock.release();
		expect(await readSessionOwner("s1", dir)).toBeNull();
	});

	it("refuses a live holder from another process view", async () => {
		using tempDir = TempDir.createSync("@omp-session-owner-");
		const dir = path.join(tempDir.path(), "locks");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			await waiter(dir, "s4"),
			JSON.stringify({
				token: "other-process",
				pid: process.pid,
				hostname: os.hostname(),
				startedAt: Date.now(),
				instanceId: "other",
				heartbeatAt: Date.now(),
			}),
		);
		await expect(acquireSessionOwnerLock("s4", dir)).rejects.toBeInstanceOf(SessionOwnedError);
	});

	it("re-entrant acquisition in one process shares one owner file", async () => {
		using tempDir = TempDir.createSync("@omp-session-owner-");
		const dir = path.join(tempDir.path(), "locks");
		const first = await acquireSessionOwnerLock("s2", dir);
		const second = await acquireSessionOwnerLock("s2", dir);
		expect(second.owner.token).toBe(first.owner.token);
		await first.release();
		expect(await readSessionOwner("s2", dir)).not.toBeNull();
		await second.release();
		expect(await readSessionOwner("s2", dir)).toBeNull();
	});

	it("takes over a stale holder", async () => {
		using tempDir = TempDir.createSync("@omp-session-owner-");
		const dir = path.join(tempDir.path(), "locks");
		await fs.mkdir(dir, { recursive: true });
		const file = await waiter(dir, "s3");
		await fs.writeFile(
			file,
			JSON.stringify({
				token: "stale",
				pid: 999_999,
				hostname: os.hostname(),
				startedAt: 1,
				instanceId: "dead",
				heartbeatAt: 1,
			}),
		);
		const lock = await acquireSessionOwnerLock("s3", dir);
		expect(lock.owner.token).not.toBe("stale");
		expect(await readSessionOwner("s3", dir)).toMatchObject({ pid: process.pid });
		await lock.release();
	});
});
