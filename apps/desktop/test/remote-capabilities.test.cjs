const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const targets = require("../electron/remote-targets.cjs");

/**
 * Remote capability probe.
 *
 * The dialog used to refuse "remote + container" because the only probes were
 * local. These assertions pin the contract that replaced the refusal: one ssh
 * exec on the remote host, one line per fact, and no defaulting of a fact the
 * host did not print — because "cannot reach the host" and "the host has no
 * docker" lead to different fixes.
 *
 * The fake command runs through the same `resetForTests` spawn seam the
 * tunnel suite uses, so the probe is exercised as the shell runs it: real
 * spawn, real argv, real exit code.
 */

function useFakes(scripts) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-probe-"));
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
	});
	return { dir, command: name => path.join(dir, `${name}.sh`) };
}

function print(lines) {
	return `process.stdout.write(${JSON.stringify(lines.join("\n") + "\n")});`;
}

function fail(message) {
	return `process.stderr.write(${JSON.stringify(message + "\n")}); process.exit(255);`;
}

test.afterEach(() => targets.resetForTests());

test("a host that can run docker and WSL reports both", async () => {
	const fakes = useFakes({ ssh: print(["docker=1:27.1.1", "wsl=1", "Ubuntu-22.04", "Debian"]) });
	const out = await targets.probeRemoteCapabilities({ destination: "me@build", sshCommand: fakes.command("ssh") });
	assert.equal(out.ok, true);
	assert.deepEqual(out.docker, { available: true, version: "27.1.1" });
	assert.deepEqual(out.wsl, { available: true, distros: ["Ubuntu-22.04", "Debian"] });
});

test("a host without the docker CLI says which reason", async () => {
	const fakes = useFakes({ ssh: print(["docker=0:docker-not-found", "wsl=0"]) });
	const out = await targets.probeRemoteCapabilities({ destination: "me@build", sshCommand: fakes.command("ssh") });
	// "not installed" and "installed but not running" need different fixes.
	assert.deepEqual(out.docker, { available: false, reason: "docker-not-found" });
	assert.deepEqual(out.wsl, { available: false });
});

test("an unreachable host stays distinguishable from a host with nothing", async () => {
	const fakes = useFakes({ ssh: fail("Permission denied (publickey).") });
	const out = await targets.probeRemoteCapabilities({ destination: "me@build", sshCommand: fakes.command("ssh") });
	assert.equal(out.ok, false);
	assert.equal(out.reason, "unreachable");
	assert.match(out.error, /Permission denied/);
});

test("the probe carries the same transport facts as the tunnel", async () => {
	const argvFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "musepi-probe-")), "argv.json");
	const fakes = useFakes({
		ssh: `require("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));` +
			print(["wsl=0"]),
	});
	await targets.probeRemoteCapabilities({
		destination: "me@build",
		sshCommand: fakes.command("ssh"),
		sshPort: 2222,
		keyPath: "/keys/build",
		proxyJump: "bastion",
	});
	const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
	// Batch mode and a timeout: a prompt would hang the form, so it must fail.
	assert.ok(argv.includes("BatchMode=yes"));
	assert.ok(argv.includes("ConnectTimeout=8"));
	assert.deepEqual(argv.slice(argv.indexOf("-p"), argv.indexOf("-p") + 2), ["-p", "2222"]);
	assert.deepEqual(argv.slice(argv.indexOf("-i"), argv.indexOf("-i") + 2), ["-i", "/keys/build"]);
	assert.deepEqual(argv.slice(argv.indexOf("-J"), argv.indexOf("-J") + 2), ["-J", "bastion"]);
});
