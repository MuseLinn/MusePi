import { describe, expect, it } from "bun:test";

const childFlag = "--ebadf-child";
const childFlagIndex = process.argv.indexOf(childFlag);
if (childFlagIndex >= 0) {
	// EBADF from a write is a closed-descriptor race on a comms path: the
	// postmortem unhandledRejection handler must log and continue, not tear
	// the process down (mirror of the EPIPE exemption — Windows surfaces a
	// gone-away pipe peer as EBADF where POSIX reports EPIPE).
	process.stdout.write("started\n");
	const err = Object.assign(new Error("bad file descriptor"), { code: "EBADF", syscall: "write" });
	void Promise.reject(err);
	// Keep the child alive; the parent decides liveness by observing whether
	// this process exits on its own.
	await new Promise<void>(() => {});
}

describe("postmortem EBADF handling", () => {
	it("does not tear down the process on an unhandled EBADF write rejection", async () => {
		const child = Bun.spawn([process.execPath, "run", import.meta.path, childFlag], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			// Event-driven gate: wait for the child's synchronous "started"
			// banner (proves it reached the rejection point), then race its
			// exit against a deadline. With the EBADF exemption the child
			// stays alive; without it the fatal path exits with code 1. A
			// wall-clock deadline is unavoidable here — the condition being
			// asserted is precisely that no event (exit) arrives.
			const decoder = new TextDecoder();
			const reader = child.stdout.getReader();
			let banner = "";
			while (!banner.includes("started\n")) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("Child exited before printing its started banner");
				banner += decoder.decode(chunk.value);
			}
			reader.releaseLock();

			const outcome = await Promise.race([
				child.exited.then(code => `exited:${code}`),
				Bun.sleep(3000).then(() => "still-alive"),
			]);
			expect(outcome).toBe("still-alive");
		} finally {
			child.kill();
			await child.exited;
		}
	});
});
