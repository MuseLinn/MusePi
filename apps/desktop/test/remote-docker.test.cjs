const { afterEach, describe, expect, it } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const targets = require("../electron/remote-targets.cjs");

/**
 * Docker on another machine.
 *
 * The container commands themselves do not change: `docker run -d --name …` is
 * the same argv wherever docker runs. What changes is the hop, and the port.
 *
 * These assertions pin both halves, because either alone is a broken feature:
 *
 *  - the ssh hop carries the destination, key and jump chain the tunnel uses,
 *    so a bastion-only host works for containers exactly as it does for shells;
 *  - a remote exec also forwards the container's published port, because that
 *    port lives on the far host's loopback and nothing here can dial it.
 */

const tmpDirs = [];

function tmpDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-docker-"));
	tmpDirs.push(dir);
	return dir;
}

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
			if (!script) return spawn(file, args, options);
			return spawn(process.execPath, [script, ...args], options);
		},
		sshTimeoutMs: 8000,
		daemonTimeoutMs: 8000,
		terminateGraceMs: 400,
	});
	return { dir, command: name => path.join(dir, `${name}.sh`) };
}

function readLines(scratch) {
	const file = path.join(scratch, "argv.log");
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];
}

// The fake writes its argv to the scratch dir, so a test reads the exact words
// that would have reached ssh(1) rather than a string this test rebuilt.
function logArgv(scratch) {
	const file = path.join(scratch, "argv.log").replace(/\\/g, "\\\\");
	return `require("node:fs").appendFileSync("${file}", process.argv.slice(2).join(" ") + "\\n");`;
}

function bindPort(port) {
	return `require("node:net").createServer().listen(${port}, "127.0.0.1");`;
}

async function freePort() {
	const net = require("node:net");
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

afterEach(() => {
	targets.resetForTests();
	for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("local docker is unchanged", () => {
	it("runs docker directly when no transport is given", async () => {
		const scratch = tmpDir();
		const fakes = useFakes({ docker: logArgv(scratch) + "process.exit(0);" });
		const ran = await targets.runContainer({ name: "musepi-dev", port: 8300, dockerCommand: fakes.command("docker") });
		expect(ran.ok).toBe(true);
		// The docker binary itself, never ssh: a user with only a local daemon
		// must not pay for a hop that does not exist.
		expect(readLines(scratch)).toEqual(["run -d --name musepi-dev -p 127.0.0.1:8300:8300 musepi"]);
	});
});

describe("remote docker goes through ssh", () => {
	it("lists containers by execing docker on the far host", async () => {
		const scratch = tmpDir();
		const fakes = useFakes({
			ssh: logArgv(scratch) + 'process.stdout.write("musepi-dev\\tmusepi:latest\\t127.0.0.1:8300->8300/tcp\\n");',
		});
		const list = await targets.listContainers({
			transport: { destination: "me@build", sshPort: 2222, keyPath: "/keys/id", proxyJump: "bastion" },
		});
		expect(list.ok).toBe(true);
		expect(list.containers.map(row => row.name)).toEqual(["musepi-dev"]);
		const argv = readLines(scratch)[0];
		// One ssh exec, batch mode, and the host facts verbatim: a container on a
		// bastion-only host must reach the same way a shell does.
		expect(argv).toContain("-o BatchMode=yes");
		expect(argv).toContain("-p 2222");
		expect(argv).toContain("-i /keys/id");
		expect(argv).toContain("-J bastion");
		expect(argv).toContain("me@build docker ps --format");
	});

	it("detects docker on the far host with the same hop", async () => {
		const scratch = tmpDir();
		const fakes = useFakes({ ssh: logArgv(scratch) + 'process.stdout.write("27.1.1\\n");' });
		const detected = await targets.detectDocker({ transport: { destination: "me@build" } });
		expect(detected).toEqual({ available: true, version: "27.1.1" });
		expect(readLines(scratch)[0]).toContain("me@build docker info --format");
	});

	it("runs a container on the far host", async () => {
		const scratch = tmpDir();
		const fakes = useFakes({ ssh: logArgv(scratch) + "process.exit(0);" });
		const ran = await targets.runContainer({
			name: "musepi-dev",
			port: 8300,
			transport: { destination: "me@build" },
		});
		expect(ran.ok).toBe(true);
		expect(readLines(scratch)[0]).toContain("me@build docker run -d --name musepi-dev");
	});

	it("removes a remote container it created, over the transport it recorded", async () => {
		const scratch = tmpDir();
		const fakes = useFakes({ ssh: logArgv(scratch) + "process.exit(0);" });
		await targets.runContainer({ name: "musepi-dev", port: 8300, transport: { destination: "me@build" } });
		// No transport passed here on purpose: a stop that happens after a reload
		// has only the record, so the record has to carry the hop.
		await targets.stopTarget("docker-run:musepi-dev");
		expect(readLines(scratch)[1]).toContain("me@build docker rm -f musepi-dev");
	});

	it("execs the daemon and forwards its published port in the same child", async () => {
		const hostPort = await freePort();
		const containerPort = await freePort();
		const scratch = tmpDir();
		const fakes = useFakes({ ssh: logArgv(scratch) + bindPort(hostPort) });
		const exec = await targets.execContainer({
			targetId: "r1",
			container: "theirs",
			hostPort,
			containerPort,
			transport: { destination: "me@build", keyPath: "/keys/id" },
		});
		expect(exec.ok).toBe(true);
		const argv = readLines(scratch)[0];
		// The forward is what makes a remote container usable at all: its port is
		// published on the far loopback, so without -L this shell polls a port
		// nothing on this machine will ever open.
		expect(argv).toContain(`-L ${hostPort}:127.0.0.1:${hostPort}`);
		expect(argv).toContain("-o ExitOnForwardFailure=yes");
		expect(argv).toContain(`me@build docker exec theirs musepi serve --port ${containerPort}`);
		// The daemon binds inside the container, never the forwarded side.
		expect(argv).not.toContain(`--port ${hostPort}`);
	});
});
