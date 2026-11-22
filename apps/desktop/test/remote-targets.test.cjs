/**
 * Managed remote targets — the ownership contract.
 *
 * Every test here runs the real supervisor against a fake command, so what is
 * asserted is the behaviour the packaged shell has: which process it spawns,
 * what it does with that process's own output, and — the hard rule — that it
 * never touches a process it did not create.
 *
 * Fakes go through the supervisor's one spawn seam rather than being executable
 * files: Windows refuses to spawn a script directly (EFTYPE), and the seam is
 * also what lets a test read the exact argv that would have reached ssh(1),
 * docker or wsl.exe without a real ssh host or Docker daemon.
 */
const { afterEach, describe, expect, it } = require("bun:test");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const targets = require("../electron/remote-targets.cjs");

const tmpDirs = [];
const servers = [];

function tmpDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-remote-"));
	tmpDirs.push(dir);
	return dir;
}

/**
 * Install fake commands for one test.
 *
 * Each entry maps a command name (`ssh`, `docker`, `wsl.exe`) to a Node script
 * that receives the real argv in `process.argv.slice(2)`.
 */
function useFakes(scripts) {
	const dir = tmpDir();
	const files = new Map();
	for (const [name, source] of Object.entries(scripts)) {
		const file = path.join(dir, `${name}.js`);
		fs.writeFileSync(file, source);
		files.set(name, file);
	}
	targets.resetForTests({
		spawn: (file, args, options) => {
			const script = files.get(path.basename(file, ".sh")) ?? files.get(path.basename(file));
			// An unknown command falls through to a real spawn, so a test can
			// still exercise the "binary is not installed" path (ENOENT) while
			// the named fakes answer.
			if (!script) return spawn(file, args, options);
			return spawn(process.execPath, [script, ...args], options);
		},
		sshTimeoutMs: 8000,
		daemonTimeoutMs: 8000,
		terminateGraceMs: 400,
	});
	return {
		dir,
		/** The path to hand the supervisor for a fake command. */
		command: name => path.join(dir, `${name}.sh`),
	};
}

/** Reserve a port, then free it, so the number is very likely unbound. */
async function freePort() {
	return new Promise(resolve => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

/** Keep a port busy for the duration of one test. */
async function occupyPort() {
	const server = net.createServer();
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	servers.push(server);
	return server.address().port;
}

/** A fake that binds the forwarded port, the way a real tunnel does. */
const BIND = port => `
const net = require("node:net");
const server = net.createServer();
server.listen(${port}, "127.0.0.1");
process.on("SIGTERM", () => { server.close(); process.exit(0); });
`;

/** A fake that appends its argv to `<dir>/argv.log`. */
const LOG_ARGV = dir => `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(path.join(dir, "argv.log"))}, process.argv.slice(2).join(" ") + "\\n");
`;

function readArgvLog(dir) {
	return fs.readFileSync(path.join(dir, "argv.log"), "utf8").trim().split("\n");
}

afterEach(async () => {
	await targets.stopAll().catch(() => {});
	targets.resetForTests();
	for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve));
	for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ssh tunnel argv", () => {
	it("forwards the local port to the remote daemon and never auto-accepts a key", () => {
		const args = targets.buildSshTunnelArgs({
			localPort: 9400,
			remotePort: 8300,
			destination: "me@build.example.com",
		});
		expect(args).toEqual([
			"-N",
			"-o",
			"BatchMode=yes",
			"-o",
			"ExitOnForwardFailure=yes",
			"-L",
			"9400:127.0.0.1:8300",
			"me@build.example.com",
		]);
		// A background child has no terminal: a host-key prompt would hang the
		// connect instead of failing with a reason the row can show.
		expect(args.join(" ")).not.toContain("StrictHostKeyChecking=no");
	});

	it("keeps a ProxyJump chain, a non-default ssh port and an identity file", () => {
		const args = targets.buildSshTunnelArgs({
			localPort: 9400,
			remotePort: 8300,
			destination: "me@internal",
			sshPort: 2222,
			proxyJump: "bastion",
			keyPath: "~/.ssh/id_ed25519",
		});
		expect(args[args.indexOf("-J") + 1]).toBe("bastion");
		expect(args[args.indexOf("-p") + 1]).toBe("2222");
		expect(args[args.indexOf("-i") + 1]).toBe("~/.ssh/id_ed25519");
	});

	it("omits -p for the default ssh port", () => {
		const args = targets.buildSshTunnelArgs({ localPort: 1, remotePort: 2, destination: "h", sshPort: 22 });
		expect(args).not.toContain("-p");
	});
});

describe("ssh tunnel lifecycle", () => {
	it("reports running once the forwarded port answers, and stops it again", async () => {
		const port = await freePort();
		const fakes = useFakes({ ssh: BIND(port) });
		const started = await targets.startSshTunnel({
			id: "t1",
			localPort: port,
			remotePort: 8300,
			destination: "me@host",
			sshCommand: fakes.command("ssh"),
		});
		expect(started.ok).toBe(true);
		expect(started.status.status).toBe("running");
		expect(started.status.pid).toBeGreaterThan(0);

		const stopped = await targets.stopTarget("t1");
		expect(stopped.ok).toBe(true);
		expect(stopped.stopped).toBe(true);
		expect(targets.listTargets()).toEqual([]);
	});

	it("refuses a second tunnel to the same target", async () => {
		const port = await freePort();
		const fakes = useFakes({ ssh: BIND(port) });
		const input = {
			id: "dup",
			localPort: port,
			remotePort: 8300,
			destination: "me@host",
			sshCommand: fakes.command("ssh"),
		};
		expect((await targets.startSshTunnel(input)).ok).toBe(true);
		const second = await targets.startSshTunnel(input);
		expect(second.ok).toBe(false);
		expect(second.reason).toBe("already-running");
	});

	it("refuses a second tunnel while the first is still connecting, before its port answers", async () => {
		// The ownership record is the only guard here: the port is not bound yet,
		// so a port check would let two `-L` binds race for it.
		const port = await freePort();
		const fakes = useFakes({ ssh: "setTimeout(() => {}, 60000);" });
		const input = {
			id: "slow",
			localPort: port,
			remotePort: 8300,
			destination: "me@host",
			sshCommand: fakes.command("ssh"),
		};
		const first = targets.startSshTunnel(input);
		// Let the first spawn record itself, then ask again.
		await new Promise(resolve => setTimeout(resolve, 150));
		const second = await targets.startSshTunnel(input);
		expect(second.ok).toBe(false);
		expect(second.reason).toBe("already-running");
		await targets.stopTarget("slow");
		await first;
	});

	it("surfaces ssh's own stderr instead of a generic failure", async () => {
		const port = await freePort();
		const fakes = useFakes({
			ssh: 'process.stderr.write("Permission denied (publickey).\\n"); process.exit(255);',
		});
		const result = await targets.startSshTunnel({
			id: "bad",
			localPort: port,
			remotePort: 8300,
			destination: "me@host",
			sshCommand: fakes.command("ssh"),
		});
		expect(result.ok).toBe(false);
		expect(result.status.status).toBe("failed");
		expect(result.status.stderr).toContain("Permission denied (publickey).");
	});

	it("does not adopt a listener that was already there", async () => {
		const port = await occupyPort();
		const fakes = useFakes({ ssh: BIND(port) });
		// The fake would bind the port, but it must never be spawned: something
		// else already answers there and this shell did not start it.
		const result = await targets.startSshTunnel({
			id: "foreign",
			localPort: port,
			remotePort: 8300,
			destination: "me@host",
			sshCommand: fakes.command("ssh"),
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("port-in-use");
		expect(targets.listTargets()).toEqual([]);
		// No record exists for it, so a stop cannot reach the user's process.
		expect(await targets.stopTarget("foreign")).toEqual({ ok: true, stopped: false, reason: "not-owned" });
	});

	it("refuses to stop a target it never started", async () => {
		useFakes({});
		expect(await targets.stopTarget("someone-elses")).toEqual({ ok: true, stopped: false, reason: "not-owned" });
	});

	it("marks a tunnel that dies after starting as failed with its reason", async () => {
		const port = await freePort();
		const fakes = useFakes({
			ssh: `
const net = require("node:net");
const server = net.createServer();
server.listen(${port}, "127.0.0.1", () => {
	setTimeout(() => {
		process.stderr.write("Connection reset by peer\\n");
		server.close();
		process.exit(1);
	}, 700);
});
`,
		});
		const started = await targets.startSshTunnel({
			id: "crash",
			localPort: port,
			remotePort: 8300,
			destination: "me@host",
			sshCommand: fakes.command("ssh"),
		});
		expect(started.ok).toBe(true);
		const seen = [];
		const off = targets.onStatus(status => seen.push(status));
		await new Promise(resolve => setTimeout(resolve, 2000));
		off();
		const last = seen.at(-1);
		expect(last).toBeDefined();
		expect(last.status).toBe("failed");
		expect(last.stderr).toContain("Connection reset by peer");
	});
});

describe("docker", () => {
	it("parses docker ps rows and finds containers publishing the daemon port", () => {
		const fixture = [
			"musepi-dev\tmusepi:latest\t127.0.0.1:8300->8300/tcp",
			"other\tnginx:latest\t0.0.0.0:8080->80/tcp",
			"both\timg:tag\t0.0.0.0:8300->8300/tcp, 0.0.0.0:9000->9000/tcp",
		].join("\n");
		const rows = targets.parseDockerPs(fixture);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toEqual({
			name: "musepi-dev",
			image: "musepi:latest",
			ports: [{ hostPort: 8300, containerPort: 8300, protocol: "tcp" }],
		});
		expect(targets.containersPublishing(rows, 8300).map(row => row.name)).toEqual(["musepi-dev", "both"]);
	});

	it("reports an empty docker ps as no containers, not a failure", async () => {
		const fakes = useFakes({ docker: "process.exit(0);" });
		const list = await targets.listContainers({ dockerCommand: fakes.command("docker") });
		expect(list.ok).toBe(true);
		expect(list.containers).toEqual([]);
		expect(targets.containersPublishing(list.containers, 8300)).toEqual([]);
	});

	it("a docker ps that failed is a failure, not an empty list", async () => {
		// The distinction a row depends on: "no container publishes this port"
		// and "the daemon would not answer" lead a user to different actions.
		const fakes = useFakes({
			docker: 'process.stderr.write("permission denied while trying to connect to the Docker daemon socket\\n"); process.exit(1);',
		});
		const list = await targets.listContainers({ dockerCommand: fakes.command("docker") });
		expect(list.ok).toBe(false);
		expect(list.reason).toBe("daemon-unreachable");
		expect(list.error).toContain("permission denied");
	});

	it("distinguishes a missing docker CLI from a daemon that will not answer", async () => {
		const missing = await targets.detectDocker({ dockerCommand: "musepi-no-such-docker-binary" });
		expect(missing.available).toBe(false);
		expect(missing.reason).toBe("docker-not-found");

		const fakes = useFakes({
			docker: 'process.stderr.write("Cannot connect to the Docker daemon\\n"); process.exit(1);',
		});
		const down = await targets.detectDocker({ dockerCommand: fakes.command("docker") });
		expect(down.available).toBe(false);
		expect(down.reason).toBe("daemon-unreachable");
		expect(down.error).toContain("Cannot connect to the Docker daemon");
	});

	it("runs a container with the documented publish command and removes only that one", async () => {
		const scratch = tmpDir();
		const fakes = useFakes({ docker: LOG_ARGV(scratch) + "process.exit(0);" });
		const ran = await targets.runContainer({
			name: "musepi-dev",
			port: 8300,
			dockerCommand: fakes.command("docker"),
		});
		expect(ran.ok).toBe(true);
		await targets.stopTarget("docker-run:musepi-dev", { dockerCommand: fakes.command("docker") });
		expect(readArgvLog(scratch)).toEqual([
			"run -d --name musepi-dev -p 127.0.0.1:8300:8300 musepi",
			"rm -f musepi-dev",
		]);
	});

	it("never removes a container it merely exec'd into", async () => {
		const port = await freePort();
		const scratch = tmpDir();
		const fakes = useFakes({ docker: LOG_ARGV(scratch) + BIND(port) });
		const exec = await targets.execContainer({
			targetId: "d1",
			container: "theirs",
			port,
			dockerCommand: fakes.command("docker"),
		});
		expect(exec.ok).toBe(true);
		await targets.stopTarget("d1", { dockerCommand: fakes.command("docker") });
		// Only the exec client ran; no `docker rm` was ever issued for a
		// container this shell did not create.
		expect(readArgvLog(scratch)).toEqual([`exec theirs musepi serve --port ${port}`]);
	});
});

describe("wsl", () => {
	it("builds `wsl.exe -d <distro> -- musepi serve --port N`", () => {
		expect(targets.wslServeArgs("Ubuntu-22.04", 8300)).toEqual([
			"-d",
			"Ubuntu-22.04",
			"--",
			"musepi",
			"serve",
			"--port",
			"8300",
		]);
	});

	it("decodes UTF-16LE output that was read as bytes", () => {
		const utf16 = Buffer.from("Ubuntu\r\n", "utf16le").toString("latin1");
		expect(targets.decodeWslOutput(utf16)).toBe("Ubuntu\r\n");
		expect(targets.decodeWslOutput("Ubuntu\r\n")).toBe("Ubuntu\r\n");
	});

	it("starts the daemon inside a distribution and reports running", async () => {
		const port = await freePort();
		const fakes = useFakes({ "wsl.exe": BIND(port) });
		const started = await targets.startWslDaemon({
			targetId: "w1",
			distro: "Ubuntu",
			port,
			wslCommand: fakes.command("wsl.exe"),
		});
		expect(started.ok).toBe(true);
		expect(started.status.status).toBe("running");
	});

	it("reports a failing wsl command with its stderr, not as a closed tunnel", async () => {
		const port = await freePort();
		const fakes = useFakes({
			"wsl.exe": 'process.stderr.write("There is no distribution with the supplied name.\\n"); process.exit(1);',
		});
		const started = await targets.startWslDaemon({
			targetId: "w2",
			distro: "Nope",
			port,
			wslCommand: fakes.command("wsl.exe"),
		});
		expect(started.ok).toBe(false);
		expect(started.status.status).toBe("failed");
		expect(started.status.stderr).toContain("no distribution");
	});

	it("lists distributions, and reports a missing wsl.exe as not found", async () => {
		const fakes = useFakes({ "wsl.exe": 'process.stdout.write("Ubuntu\\r\\nDebian\\r\\n");' });
		const listed = await targets.listWslDistros({ wslCommand: fakes.command("wsl.exe") });
		expect(listed.ok).toBe(true);
		expect(listed.output).toContain("Ubuntu");

		const missing = await targets.listWslDistros({ wslCommand: "musepi-no-such-wsl-binary" });
		expect(missing.ok).toBe(false);
		expect(missing.reason).toBe("wsl-not-found");
	});
});
