import { describe, expect, it } from "bun:test";
import * as postmortem from "../src/postmortem";

const childFlag = "--quit-without-drain-child";

if (process.argv.includes(childFlag)) {
	Object.defineProperty(process.stdout, "writableLength", { value: 1, configurable: true });
	await postmortem.quit(23, { drainStdout: false });
}

describe("postmortem quit", () => {
	it("exits without waiting for pending stdout when draining is disabled", async () => {
		const child = Bun.spawn([process.execPath, import.meta.path, childFlag], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const timeout = Bun.sleep(500).then(() => "timeout" as const);
		try {
			expect(await Promise.race([child.exited, timeout])).toBe(23);
		} finally {
			child.kill();
			await child.exited;
		}
	});
});
