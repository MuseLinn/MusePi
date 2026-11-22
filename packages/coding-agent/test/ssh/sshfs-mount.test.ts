import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isMounted } from "../../src/ssh/sshfs-mount";

describe("isMounted", () => {
	it("detects a macOS mount point when mountpoint is unavailable", async () => {
		const parentPath = import.meta.dir;
		const mountPath = path.join(parentPath, "mounted");
		const stat = async (filePath: string) => ({ dev: filePath === mountPath ? 2 : 1 });

		await expect(isMounted(mountPath, { platform: "darwin", stat, which: () => null })).resolves.toBe(true);
	});

	it("treats a non-empty mount dir as mounted on win32 (sshfs-win, no mountpoint)", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sshfs-win-mount-"));
		try {
			await fs.promises.writeFile(path.join(dir, "rootfile"), "x");
			await expect(isMounted(dir, { platform: "win32", which: () => null })).resolves.toBe(true);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("treats an empty/missing mount dir as not mounted on win32", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sshfs-win-mount-"));
		try {
			await expect(isMounted(dir, { platform: "win32", which: () => null })).resolves.toBe(false);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("sshfs argv carries the jump chain", () => {
	const { _sshfsForTests } = require("../../src/ssh/sshfs-mount");

	it("emits -J for a host reached through a bastion", () => {
		// Without `-J` sshfs resolves the destination directly and a
		// bastion-only host fails to mount, even though it is listed and
		// registered — the "visible but unusable" shape.
		const args: string[] = _sshfsForTests.buildSshfsArgs({
			name: "internal",
			host: "10.0.0.5",
			username: "me",
			proxyJump: "bastion",
		});
		expect(args[args.indexOf("-J") + 1]).toBe("bastion");
	});

	it("omits -J when the host has no chain", () => {
		const args: string[] = _sshfsForTests.buildSshfsArgs({ name: "direct", host: "h.example.com" });
		expect(args).not.toContain("-J");
	});

	it("keeps -p and the identity file alongside -J", () => {
		const args: string[] = _sshfsForTests.buildSshfsArgs({
			name: "both",
			host: "10.0.0.5",
			port: 2222,
			keyPath: "~/.ssh/id_ed25519",
			proxyJump: "a,b",
		});
		expect(args[args.indexOf("-p") + 1]).toBe("2222");
		expect(args).toContain("IdentityFile=~/.ssh/id_ed25519");
		expect(args[args.indexOf("-J") + 1]).toBe("a,b");
	});
});
