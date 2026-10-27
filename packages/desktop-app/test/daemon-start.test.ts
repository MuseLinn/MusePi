import { afterEach, describe, expect, it, vi } from "bun:test";
import type * as ChildProcessModule from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof ChildProcessModule;
const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	delete require.cache[require.resolve("../electron/daemon.cjs")];
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("daemon startup diagnostics", () => {
	it("surfaces the child process error when the daemon exits before binding", async () => {
		const socketDir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-daemon-start-"));
		tempDirs.push(socketDir);
		const spawnFake = (() => {
			const child = Object.assign(new EventEmitter(), {
				stderr: new EventEmitter(),
				exitCode: null as number | null,
				signalCode: null as string | null,
				pid: 12345,
				unref: () => {},
			});
			queueMicrotask(() => {
				child.stderr.emit("data", Buffer.from("EPERM: operation not permitted, mkdir 'journal'"));
				child.exitCode = 1;
			});
			return child as unknown as ChildProcessModule.ChildProcessWithoutNullStreams;
		}) as unknown as typeof childProcess.spawn;
		vi.spyOn(childProcess, "spawn").mockImplementation(spawnFake);
		delete require.cache[require.resolve("../electron/daemon.cjs")];
		const { resetSocketDirForTests, start } = require("../electron/daemon.cjs");
		resetSocketDirForTests(socketDir);

		await expect(start(8397)).rejects.toThrow(/EPERM: operation not permitted, mkdir 'journal'/);
	});
});

function fakeChild(): ChildProcessModule.ChildProcessWithoutNullStreams {
	return Object.assign(new EventEmitter(), {
		stderr: new EventEmitter(),
		exitCode: null,
		signalCode: null,
		pid: 12345,
		unref: () => {},
	}) as unknown as ChildProcessModule.ChildProcessWithoutNullStreams;
}

async function socketDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-daemon-start-"));
	tempDirs.push(dir);
	return dir;
}

describe("daemon startup coordination", () => {
	it("allows a slow first compile to finish instead of failing at ten seconds", async () => {
		const dir = await socketDir();
		vi.spyOn(childProcess, "spawn").mockImplementation(fakeChild);
		delete require.cache[require.resolve("../electron/daemon.cjs")];
		const { resetSocketDirForTests, start } = require("../electron/daemon.cjs");
		resetSocketDirForTests(dir);
		const port = 8621;
		setTimeout(() => {
			const server = net.createServer();
			server.listen(port, "127.0.0.1", () => {
				void fs.writeFile(path.join(dir, "ws.port"), String(port));
			});
			setTimeout(() => server.close(), 1000);
		}, 10_200);
		await expect(start(port)).resolves.toBe(port);
	}, 30_000);

	it("shares one in-flight startup across concurrent callers", async () => {
		const dir = await socketDir();
		const spawnFake = vi.fn(fakeChild);
		vi.spyOn(childProcess, "spawn").mockImplementation(spawnFake);
		delete require.cache[require.resolve("../electron/daemon.cjs")];
		const { resetSocketDirForTests, start } = require("../electron/daemon.cjs");
		resetSocketDirForTests(dir);
		const port = 8622;
		setTimeout(() => {
			const server = net.createServer();
			server.listen(port, "127.0.0.1", () => {
				void fs.writeFile(path.join(dir, "ws.port"), String(port));
			});
			setTimeout(() => server.close(), 1000);
		}, 150);
		await expect(Promise.all([start(port), start(port)])).resolves.toEqual([port, port]);
		expect(spawnFake).toHaveBeenCalledTimes(1);
	}, 30_000);

	it("adopts an already listening daemon without spawning a replacement", async () => {
		const dir = await socketDir();
		const port = 8623;
		const server = net.createServer();
		server.listen(port, "127.0.0.1");
		await fs.writeFile(path.join(dir, "ws.port"), String(port));
		const spawnFake = vi.fn(fakeChild);
		vi.spyOn(childProcess, "spawn").mockImplementation(spawnFake);
		delete require.cache[require.resolve("../electron/daemon.cjs")];
		const { resetSocketDirForTests, start } = require("../electron/daemon.cjs");
		resetSocketDirForTests(dir);
		try {
			await expect(start(port)).resolves.toBe(port);
			expect(spawnFake).not.toHaveBeenCalled();
		} finally {
			server.close();
		}
	});
});
