/**
 * Losing the owner file must be reported, not just silently stop the heartbeat.
 *
 * Before this, a holder that discovered another token kept running: the daemon
 * had already adopted the session and went on appending to a journal the new
 * holder now owned. `onLost` is what lets the live session dispose instead.
 */
import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
