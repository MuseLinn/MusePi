/**
 * Losing the owner file must be reported, not just silently stop the heartbeat.
 *
 * Before this, a holder that discovered another token kept running: the daemon
 * had already adopted the session and went on appending to a journal the new
 * holder now owned. `onLost` is what lets the live session dispose instead.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { tryAcquireFileLock } from "@musepi/pi-utils/file-lock";
import { acquireSessionOwnerLock, readSessionOwner } from "../../src/daemon/session-owner-lock";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it("reports loss when another holder replaces the owner file", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-lost-"));
	dirs.push(dir);
	let lost = 0;
	const lock = await acquireSessionOwnerLock("s1", dir, {
		heartbeatMs: 15,
		onLost: () => {
			lost += 1;
		},
	});

	// What a preemption looks like from this holder's side: someone else's token
	// is now in the file.
	const file = path.join(dir, "s1.owner");
	const current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	fs.writeFileSync(file, JSON.stringify({ ...current, token: "other-process", pid: process.pid + 1 }));

	await Bun.sleep(120);
	expect(lost).toBe(1);
	// The heartbeat stopped with the loss, so the other holder's file is intact.
	expect((await readSessionOwner("s1", dir))?.token).toBe("other-process");
	await lock.release();
});

it("holds the owner transition lock during a heartbeat rewrite", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-transition-"));
	dirs.push(dir);
	const file = path.join(dir, "s1.owner");
	const lock = await acquireSessionOwnerLock("s1", dir, { heartbeatMs: 10 });
	const originalRename = fsp.rename;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	let enteredObserved = false;
	const renameSpy = spyOn(fsp, "rename").mockImplementation(async (from, to) => {
		if (String(from) === `${file}.${lock.owner.token}.tmp` && String(to) === file) {
			enteredObserved = true;
			entered.resolve();
			await release.promise;
			const result = await originalRename(from, to);
			finished.resolve();
			return result;
		}
		return originalRename(from, to);
	});
	let contending: ReturnType<typeof tryAcquireFileLock> = null;
	try {
		await Promise.race([
			entered.promise,
			Bun.sleep(1_500).then(() => {
				throw new Error("heartbeat did not reach its owner-file rename");
			}),
		]);
		contending = tryAcquireFileLock(file);
		expect(contending).toBeNull();
		release.resolve();
		await finished.promise;
	} finally {
		release.resolve();
		contending?.release();
		if (enteredObserved) await finished.promise;
		renameSpy.mockRestore();
		await lock.release();
	}
});
