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
