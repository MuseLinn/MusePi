/**
 * Daemon remote-workspace RPC handlers (remote.hosts / hostAdd / connect /
 * browse / disconnect). Tested against the shared module functions with a
 * scratch ssh.json; ssh-side effects (probe/mount) are injected via the
 * `_remoteForTests` seam so the suite never touches a real ssh.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	_remoteForTests,
	addRemoteHost,
	browseRemoteDir,
	connectRemoteHost,
	disconnectRemoteHost,
	listRemoteHosts,
} from "../../src/daemon/remote";
import { readSSHConfigFile } from "../../src/ssh/config-writer";

let scratch: string | null = null;
let savedHelpers: Parameters<typeof _remoteForTests.setHelpers>[0] | null = null;

async function tmpConfigDir(): Promise<string> {
	scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-remote-"));
	const configPath = path.join(scratch, "ssh.json");
	savedHelpers = {
		sshConfigPath: () => configPath,
		// Defaults to *not* mounted; browse tests override per-case.
		isMounted: async () => false,
	};
	_remoteForTests.setHelpers(savedHelpers);
	return configPath;
}

afterEach(async () => {
	if (savedHelpers) {
		_remoteForTests.setHelpers(savedHelpers);
		savedHelpers = null;
	}
	if (scratch) {
		await fs.promises.rm(scratch, { recursive: true, force: true });
		scratch = null;
	}
});

describe("remote.hosts", () => {
	test("empty when no ssh.json", async () => {
		await tmpConfigDir();
		const res = await listRemoteHosts();
		expect(res.hosts).toEqual([]);
		expect(res.sshfs).toBeTypeOf("boolean");
	});

	test("lists saved hosts with their config", async () => {
		await tmpConfigDir();
		await addRemoteHost({
			name: "nas",
			host: "192.168.1.50",
			username: "root",
			port: 2222,
			keyPath: "~/.ssh/id_ed25519",
		});
		const res = await listRemoteHosts();
		expect(res.hosts).toHaveLength(1);
		expect(res.hosts[0]).toMatchObject({ name: "nas", host: "192.168.1.50", username: "root", port: 2222 });
	});
});

describe("remote.hostAdd", () => {
	test("requires name and host", async () => {
		await tmpConfigDir();
		await expect(addRemoteHost({ name: "", host: "x" })).rejects.toThrow("name and host required");
		await expect(addRemoteHost({ name: "x", host: "" })).rejects.toThrow("name and host required");
	});

	test("persists to user ssh.json", async () => {
		const configPath = await tmpConfigDir();
		await addRemoteHost({ name: "edge", host: "edge.internal", username: "u", port: 22 });
		const config = await readSSHConfigFile(configPath);
		expect(config.hosts?.edge).toMatchObject({ host: "edge.internal", username: "u", port: 22 });
		expect(config.hosts?.edge.keyPath).toBeUndefined();
	});
});

describe("remote.connect", () => {
	test("unknown host errors with add-first hint", async () => {
		await tmpConfigDir();
		await expect(connectRemoteHost({ name: "ghost" })).rejects.toThrow("add it first");
	});

	test("missing sshfs reports platform hint", async () => {
		const configPath = await tmpConfigDir();
		await addRemoteHost({ name: "nas", host: "192.168.1.50" });
		_remoteForTests.setHelpers({ ...savedHelpers!, sshConfigPath: () => configPath, hasSshfs: () => false });
		await expect(connectRemoteHost({ name: "nas" })).rejects.toThrow("sshfs is not installed");
	});

	test("probes host then mounts, returns mount metadata", async () => {
		const configPath = await tmpConfigDir();
		await addRemoteHost({ name: "nas", host: "192.168.1.50", username: "root" });
		_remoteForTests.setHelpers({
			...savedHelpers!,
			sshConfigPath: () => configPath,
			hasSshfs: () => true,
			isMounted: async () => false,
			ensureHostInfo: async () => ({ os: "linux", shell: "bash" }),
			mountRemote: async () => "/tmp/fake-mount/nas",
		});
		const res = await connectRemoteHost({ name: "nas" });
		expect(res).toMatchObject({
			mountPath: "/tmp/fake-mount/nas",
			os: "linux",
			shell: "bash",
			alreadyMounted: false,
		});
	});

	test("already-mounted returns idempotently", async () => {
		const configPath = await tmpConfigDir();
		await addRemoteHost({ name: "nas", host: "192.168.1.50" });
		_remoteForTests.setHelpers({
			...savedHelpers!,
			sshConfigPath: () => configPath,
			hasSshfs: () => true,
			isMounted: async () => true,
			ensureHostInfo: async () => ({ os: "macos", shell: "zsh" }),
			mountRemote: async () => "/tmp/fake-mount/nas",
		});
		const res = await connectRemoteHost({ name: "nas" });
		expect(res.alreadyMounted).toBe(true);
	});
});

describe("remote.browse", () => {
	async function mountedScratch(): Promise<{ configPath: string; mount: string }> {
		const configPath = await tmpConfigDir();
		await addRemoteHost({ name: "nas", host: "192.168.1.50" });
		const mount = path.join(scratch!, "mount");
		savedHelpers = { ...savedHelpers!, getMountPath: () => mount };
		_remoteForTests.setHelpers(savedHelpers);
		await fs.promises.mkdir(path.join(mount, "proj-a", "src"), { recursive: true });
		await fs.promises.writeFile(path.join(mount, "proj-a", "README.md"), "hi");
		await fs.promises.writeFile(path.join(mount, "proj-a", "src", "main.ts"), "x");
		await fs.promises.mkdir(path.join(mount, ".hidden"), { recursive: true });
		_remoteForTests.setHelpers({
			...savedHelpers!,
			sshConfigPath: () => configPath,
			isMounted: async () => true,
		});
		return { configPath, mount };
	}

	test("lists dirs first, hides dotfiles, tracks parent", async () => {
		await mountedScratch();
		const res = await browseRemoteDir({ name: "nas", path: "/" });
		expect(res.path).toBe("/");
		expect(res.parent).toBeNull();
		expect(res.entries.map(e => `${e.name}:${e.dir ? "d" : "f"}`)).toEqual(["proj-a:d"]);
		// subdir navigation
		const sub = await browseRemoteDir({ name: "nas", path: "/proj-a" });
		expect(sub.parent).toBe("/");
		expect(sub.entries.map(e => e.name)).toEqual(["src", "README.md"]);
	});

	test("rejects path traversal outside the mount", async () => {
		await mountedScratch();
		await expect(browseRemoteDir({ name: "nas", path: "../../etc" })).rejects.toThrow("escapes mount");
	});

	test("not-connected host errors", async () => {
		await tmpConfigDir();
		await addRemoteHost({ name: "nas", host: "192.168.1.50" });
		// isMounted stays false (default helpers)
		await expect(browseRemoteDir({ name: "nas", path: "/" })).rejects.toThrow("not connected");
	});

	test("missing path errors", async () => {
		await mountedScratch();
		await expect(browseRemoteDir({ name: "nas", path: "/nope" })).rejects.toThrow("no such path");
	});
});

describe("remote.disconnect", () => {
	test("unmounts and reports result", async () => {
		const configPath = await tmpConfigDir();
		await addRemoteHost({ name: "nas", host: "192.168.1.50" });
		let called = 0;
		_remoteForTests.setHelpers({
			...savedHelpers!,
			sshConfigPath: () => configPath,
			unmountRemote: async () => {
				called += 1;
				return true;
			},
		});
		const res = await disconnectRemoteHost({ name: "nas" });
		expect(res).toEqual({ unmounted: true });
		expect(called).toBe(1);
	});
});
