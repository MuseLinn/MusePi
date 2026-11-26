/**
 * Managed remote targets — the processes the shell spawns so a forwarded
 * endpoint can answer.
 *
 * Before this module the connection manager only *described* what a user had
 * to run (`ssh -N -L …`, `wsl.exe -d …`, `docker exec …`) and said the
 * lifecycle was a follow-up. It now runs those commands, which makes ownership
 * the central problem:
 *
 *  - **Identity is the child handle, never the number.** Every record keeps the
 *    `ChildProcess` object it spawned plus a per-spawn token, and only that
 *    handle is ever signalled. A recycled pid would name somebody else's
 *    process, and `process.kill(pid)` on it is precisely the bug this refuses.
 *  - **Nothing is adopted.** A listener that already answers before we spawn
 *    (the user's own tunnel, a launch-at-login daemon) is reported as
 *    `port-in-use` and left alone; a container this shell did not create is
 *    never removed. `stop` on an unknown target is a no-op that says so.
 *  - **A crash is a failure, not a silence.** ssh writes its reason to stderr;
 *    that text becomes the target's status instead of "tunnel closed".
 *  - **One tunnel per target.** A second start while the first is live is
 *    refused, so two `-L` binds cannot race for the same local port.
 *
 * Pure Node — no electron import — so the whole lifecycle is unit-testable
 * against a fake `ssh` binary (see `apps/desktop/test/remote-targets.test.cjs`).
 */
"use strict";

const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SSH_CONNECT_TIMEOUT_MS = 20_000;
const DAEMON_START_TIMEOUT_MS = 60_000;
const TERMINATE_GRACE_MS = 3_000;
const STDERR_TAIL_LINES = 24;

/** Test seam: a fake spawn lets a test drive the lifecycle without a real ssh. */
let spawnImpl = spawn;
/** Test seam: shorten the port poll so a suite does not wait real seconds. */
let timeouts = { ssh: SSH_CONNECT_TIMEOUT_MS, daemon: DAEMON_START_TIMEOUT_MS, terminateGrace: TERMINATE_GRACE_MS };

/**
 * Records of the processes this shell owns, keyed by target id.
 *
 * The map *is* the ownership claim: a record only exists because we called
 * `spawn` for it, and it is deleted when that child is gone, so "is this
 * process ours" is answered by presence here — never by a port being busy.
 */
const owned = new Map();
let spawnSeq = 0;
const statusListeners = new Set();

function resetForTests(options = {}) {
	spawnImpl = options.spawn ?? spawn;
	timeouts = {
		ssh: options.sshTimeoutMs ?? SSH_CONNECT_TIMEOUT_MS,
		daemon: options.daemonTimeoutMs ?? DAEMON_START_TIMEOUT_MS,
		terminateGrace: options.terminateGraceMs ?? TERMINATE_GRACE_MS,
	};
	for (const record of owned.values()) {
		try {
			record.child?.kill?.("SIGKILL");
		} catch {
			// already gone
		}
	}
	owned.clear();
	statusListeners.clear();
}

function onStatus(listener) {
	statusListeners.add(listener);
	return () => statusListeners.delete(listener);
}

function emit(record) {
	const snapshot = statusOf(record);
	for (const listener of statusListeners) {
		try {
			listener(snapshot);
		} catch {
			// a renderer that went away must not break the supervisor
		}
	}
	return snapshot;
}

/** True while the handle we spawned is the process that is still running. */
function stillOwned(record) {
	if (!record?.child) return false;
	// The pid check catches a handle whose process object was replaced; the
	// exit/signal fields catch one that ended without an `exit` we handled.
	return record.child.pid === record.pid && record.child.exitCode === null && record.child.signalCode === null;
}

function stderrTail(record) {
	const text = record.stderr.join("").trim();
	if (!text) return "";
	const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
	return lines.slice(-8).join("\n");
}

function statusOf(record) {
	return {
		targetId: record.targetId,
		kind: record.kind,
		status: record.status,
		pid: record.pid ?? null,
		startedAt: record.startedAt ?? null,
		listeningPort: record.listeningPort ?? null,
		/** ssh/docker/wsl's own words, not a generic "failed". */
		error: record.error ?? null,
		stderr: stderrTail(record),
		command: record.displayCommand ?? null,
	};
}

/** True if `127.0.0.1:port` accepts TCP connections right now. */
function portOpen(port) {
	return new Promise(resolve => {
		const socket = net.connect({ host: "127.0.0.1", port });
		const done = ok => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(ok);
		};
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
		socket.setTimeout(700, () => done(false));
	});
}

/**
 * Poll until the forwarded port answers, the child dies, or time runs out.
 *
 * Returns `"open"`, `"exited"` (the child is gone) or `"timeout"`. The caller
 * decides what each one means for the target's status, so this never guesses.
 */
async function waitForPort(port, timeoutMs, stillRunning) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (!stillRunning()) return "exited";
		if (await portOpen(port)) return "open";
		if (Date.now() >= deadline) return "timeout";
		await new Promise(resolve => setTimeout(resolve, 200));
	}
}

/** Quote a word for display only; argv is never built from this. */
function shellWord(value) {
	return /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

function displayCommand(file, args) {
	return [file, ...args].map(shellWord).join(" ");
}

/**
 * `ssh -N -L` arguments for one target.
 *
 * `BatchMode=yes` is deliberate: a tunnel has no terminal, so a password or
 * host-key prompt would hang the connect instead of failing. In batch mode ssh
 * exits and prints its reason, which is the text the row shows. The host key
 * is never auto-accepted — `ExitOnForwardFailure=yes` makes a bind conflict
 * fail immediately rather than leave a silent tunnel behind.
 */
function buildSshTunnelArgs(input) {
	const args = ["-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes"];
	if (Number.isInteger(input.sshPort) && input.sshPort > 0 && input.sshPort !== 22) {
		args.push("-p", String(input.sshPort));
	}
	if (input.keyPath) args.push("-i", input.keyPath);
	// A ProxyJump chain survives verbatim: ssh resolves the comma list itself,
	// so a bastion the user configured in ~/.ssh/config keeps working here.
	if (input.proxyJump) args.push("-J", input.proxyJump);
	args.push("-L", `${input.localPort}:127.0.0.1:${input.remotePort}`, input.destination);
	return args;
}

/**
 * Ask a remote host what it can run — on that host, through ssh.
 *
 * The local probes (`detectDocker`, `listWslDistros`) run against this machine,
 * so "remote + container" could only be refused. Refusing was correct while the
 * question could not be asked; asking it is one ssh exec, using the same
 * destination, key and jump chain the tunnel already uses.
 *
 * `BatchMode=yes` for the same reason the tunnel uses it: there is no terminal,
 * so a password or host-key prompt must fail fast instead of hanging the form.
 *
 * The wire between the two ends is one line per fact, so nothing here depends
 * on quoting a nested command substitution:
 *
 *   docker=1:<version>   a docker CLI answered with its server version
 *   docker=0:<reason>    missing, or its daemon is not running
 *   wsl=1                `wsl.exe -l -q` answered; its names follow, one line each
 *   wsl=0                not Windows, or no WSL
 *
 * A fact the host does not print stays absent rather than defaulting, so an
 * unreachable host and a host without docker remain distinguishable.
 */
async function probeRemoteCapabilities(input = {}) {
	const destination = input.destination;
	if (!destination) return { ok: false, reason: "missing-destination" };
	const script = [
		"if command -v docker >/dev/null 2>&1; then",
		'v=$(docker info --format "{{.ServerVersion}}" 2>/dev/null)',
		'if [ -n "$v" ]; then echo "docker=1:$v"; else echo "docker=0:daemon-unreachable"; fi',
		"else echo docker=0:docker-not-found; fi",
		"if command -v wsl.exe >/dev/null 2>&1; then echo wsl=1; wsl.exe -l -q 2>/dev/null",
		"else echo wsl=0; fi",
	].join("; ");
	const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"];
	if (Number.isInteger(input.sshPort) && input.sshPort > 0 && input.sshPort !== 22) {
		args.push("-p", String(input.sshPort));
	}
	if (input.keyPath) args.push("-i", input.keyPath);
	if (input.proxyJump) args.push("-J", input.proxyJump);
	args.push(destination, script);
	const result = await runOnce(input.sshCommand ?? "ssh", args, 20_000);
	if (!result.ok) {
		return { ok: false, reason: "unreachable", error: (result.stderr || result.stdout).trim() };
	}
	const lines = result.stdout
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);
	const parsed = { ok: true, docker: null, wsl: null };
	for (const line of lines) {
		if (line.startsWith("docker=1:")) parsed.docker = { available: true, version: line.slice(9) };
		else if (line.startsWith("docker=0:")) parsed.docker = { available: false, reason: line.slice(9) };
		else if (line === "wsl=1") parsed.wsl = { available: true, distros: [] };
		else if (line === "wsl=0") parsed.wsl = { available: false };
		// After `wsl=1` every remaining line is a distribution name exactly as
		// `wsl.exe -l -q` printed it.
		else if (parsed.wsl?.available) parsed.wsl.distros.push(line);
	}
	return parsed;
}

function spawnOwned(record, file, args) {
	const child = spawnImpl(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	record.child = child;
	record.pid = child.pid ?? null;
	record.token = `spawn-${++spawnSeq}`;
	record.displayCommand = displayCommand(file, args);

	const pushStderr = chunk => {
		for (const line of String(chunk).split(/\r?\n/)) {
			if (!line.trim()) continue;
			record.stderr.push(line);
			if (record.stderr.length > STDERR_TAIL_LINES) record.stderr.shift();
		}
	};
	child.stderr?.on?.("data", pushStderr);
	child.stdout?.on?.("data", () => {
		// ssh -N prints nothing on success; draining stdout keeps the pipe from
		// filling and stalling the child.
	});
	child.on?.("error", err => {
		record.status = "failed";
		record.error =
			err && err.code === "ENOENT"
				? `${file} is not installed or not on PATH`
				: err instanceof Error
					? err.message
					: String(err);
		emit(record);
	});
	child.on?.("exit", (code, signal) => {
		if (record.stopping) {
			// A teardown never rewrites a verdict that was already reached. The
			// timeout path marks `failed` and then terminates the child to release
			// the port; without this guard that exit reports `stopped`, so a
			// firewall drop, a slow host or WSL2 forwarding being off would read as
			// "the user pressed stop" and the reason would be lost.
			if (record.status !== "failed") record.status = "stopped";
			emit(record);
			return;
		}
		record.status = "failed";
		// ssh's own stderr is the reason a user can act on ("Permission denied
		// (publickey)", "Host key verification failed", "bind: Address already
		// in use"). Only when it said nothing does a generic line stand in.
		const tail = stderrTail(record);
		record.error =
			tail ||
			(signal ? `${file} was killed by ${signal}` : `${file} exited with code ${code === null ? "unknown" : code}`);
		emit(record);
	});
	return child;
}

/** Signal the handle we own, escalating to SIGKILL after the grace period. */
function terminate(record) {
	if (!stillOwned(record)) return;
	record.stopping = true;
	try {
		record.child.kill("SIGTERM");
	} catch {
		return;
	}
	const child = record.child;
	const pid = record.pid;
	setTimeout(() => {
		// Re-check identity: the handle must still be the same live process.
		if (child.pid !== pid || child.exitCode !== null || child.signalCode !== null) return;
		try {
			child.kill("SIGKILL");
		} catch {
			// gone between the check and the signal
		}
	}, timeouts.terminateGrace).unref?.();
}

/**
 * Start an ssh tunnel for one target.
 *
 * Refuses when the same target already owns a live tunnel, and refuses when
 * the local port already answers — that listener is somebody else's, and a
 * `-L` bind on it would fail anyway.
 */
async function startSshTunnel(target) {
	const existing = owned.get(target.id);
	if (existing && stillOwned(existing)) {
		return { ok: false, reason: "already-running", status: statusOf(existing) };
	}
	if (existing) owned.delete(target.id);

	const destination = target.destination;
	if (!destination) return { ok: false, reason: "missing-destination" };

	if (await portOpen(target.localPort)) {
		return {
			ok: false,
			reason: "port-in-use",
			error: `127.0.0.1:${target.localPort} is already listening — this shell did not start it, so it is left alone. Stop your own tunnel to manage this target here.`,
		};
	}

	const args = buildSshTunnelArgs({
		localPort: target.localPort,
		remotePort: target.remotePort,
		destination,
		sshPort: target.sshPort,
		proxyJump: target.proxyJump,
		keyPath: target.keyPath,
	});
	const record = {
		targetId: target.id,
		kind: "ssh",
		status: "connecting",
		startedAt: Date.now(),
		stderr: [],
		listeningPort: target.localPort,
	};
	owned.set(target.id, record);
	spawnOwned(record, target.sshCommand ?? "ssh", args);
	emit(record);

	const outcome = await waitForPort(target.localPort, timeouts.ssh, () => record.status !== "failed" && stillOwned(record));
	if (record.status === "failed") return { ok: false, reason: "failed", status: statusOf(record) };
	if (outcome === "open") {
		record.status = "running";
		return { ok: true, status: emit(record) };
	}
	record.status = "failed";
	record.error = stderrTail(record) || `ssh did not open 127.0.0.1:${target.localPort} in time`;
	record.stopping = true;
	terminate(record);
	return { ok: false, reason: "timeout", status: emit(record) };
}

/**
 * Which command runs `docker`, and the argv that gets there.
 *
 * A docker CLI on another machine is reached the way every other remote action
 * here is: one ssh exec, with the same destination, key and jump chain the
 * tunnel uses. That is expressed as a *prefix*, not as a second set of
 * `runContainer`-shaped functions — the argv after `docker` is identical either
 * way, so there is one definition of "run a container" and one of "list them".
 *
 * `extraSshArgs` exists for the one thing a remote container additionally
 * needs: its published port lives on the far host's loopback, which this shell
 * cannot dial. The caller passes `-L` so the same ssh connection that execs the
 * daemon also forwards that port here.
 */
function dockerCommandFor(options, extraSshArgs = []) {
	const transport = options?.transport;
	if (!transport?.destination) {
		return { file: options?.dockerCommand ?? "docker", prefix: [] };
	}
	const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", ...extraSshArgs];
	if (Number.isInteger(transport.sshPort) && transport.sshPort > 0 && transport.sshPort !== 22) {
		args.push("-p", String(transport.sshPort));
	}
	if (transport.keyPath) args.push("-i", transport.keyPath);
	if (transport.proxyJump) args.push("-J", transport.proxyJump);
	args.push(transport.destination, "docker");
	return { file: transport.sshCommand ?? "ssh", prefix: args };
}

/** `docker ps --format` fields this module asks for. */
const DOCKER_PS_FORMAT = "{{.Names}}\t{{.Image}}\t{{.Ports}}";

/**
 * Parse `docker ps` rows.
 *
 * Fixture shape (`--format "{{.Names}}\t{{.Image}}\t{{.Ports}}"`):
 *   musepi-dev\tmusepi:latest\t127.0.0.1:8300->8300/tcp
 */
function parseDockerPs(output) {
	const rows = [];
	for (const line of String(output).split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [name, image, ports] = line.split("\t");
		if (!name || !name.trim()) continue;
		rows.push({ name: name.trim(), image: (image ?? "").trim(), ports: parsePublishedPorts(ports ?? "") });
	}
	return rows;
}

/** `0.0.0.0:8300->8300/tcp, :::8300->8300/tcp` → host/container port pairs. */
function parsePublishedPorts(text) {
	const ports = [];
	for (const part of String(text).split(",")) {
		const match = /(?:^|:)(\d+)->(\d+)\/(tcp|udp)$/.exec(part.trim());
		if (!match) continue;
		const hostPort = Number(match[1]);
		const containerPort = Number(match[2]);
		if (!Number.isInteger(hostPort) || !Number.isInteger(containerPort)) continue;
		ports.push({ hostPort, containerPort, protocol: match[3] });
	}
	return ports;
}

/** Containers publishing the daemon's port, with the port it is mapped to. */
function containersPublishing(rows, daemonPort) {
	const matches = [];
	for (const row of rows) {
		for (const port of row.ports) {
			if (port.containerPort !== daemonPort) continue;
			matches.push({ name: row.name, image: row.image, hostPort: port.hostPort, containerPort: port.containerPort });
			break;
		}
	}
	return matches;
}

/** Run one short-lived docker/wsl query and resolve its stdout. */
function runOnce(file, args, timeoutMs = 15_000) {
	return new Promise(resolve => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const child = spawnImpl(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		const finish = result => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// gone
			}
			finish({ ok: false, code: null, stdout, stderr: stderr || `${file} timed out` });
		}, timeoutMs);
		timer.unref?.();
		child.stdout?.on?.("data", chunk => {
			stdout += String(chunk);
		});
		child.stderr?.on?.("data", chunk => {
			stderr += String(chunk);
		});
		child.on?.("error", err => {
			clearTimeout(timer);
			finish({
				ok: false,
				code: null,
				stdout,
				stderr:
					err && err.code === "ENOENT"
						? `${file} is not installed or not on PATH`
						: err instanceof Error
							? err.message
							: String(err),
			});
		});
		child.on?.("exit", code => {
			clearTimeout(timer);
			finish({ ok: code === 0, code, stdout, stderr });
		});
	});
}

/** Is a docker CLI reachable, and does its daemon answer? */
async function detectDocker(options = {}) {
	const command = dockerCommandFor(options);
	const result = await runOnce(command.file, [...command.prefix, "info", "--format", "{{.ServerVersion}}"]);
	if (!result.ok) {
		return {
			available: false,
			reason: /not installed|not on PATH|ENOENT/.test(result.stderr) ? "docker-not-found" : "daemon-unreachable",
			error: result.stderr.trim() || "docker did not answer",
		};
	}
	return { available: true, version: result.stdout.trim() };
}

/** Running containers, or the reason the list could not be read. */
async function listContainers(options = {}) {
	const command = dockerCommandFor(options);
	const result = await runOnce(command.file, [...command.prefix, "ps", "--format", DOCKER_PS_FORMAT]);
	if (!result.ok) {
		return {
			ok: false,
			reason: /not installed|not on PATH|ENOENT/.test(result.stderr) ? "docker-not-found" : "daemon-unreachable",
			error: result.stderr.trim() || "docker ps failed",
		};
	}
	return { ok: true, containers: parseDockerPs(result.stdout) };
}

/**
 * Start a container from an image with the documented publish command.
 *
 * Ownership is recorded only after `docker run` succeeds, so a stop can never
 * remove a container this shell failed to create.
 */
async function runContainer(input) {
	const name = input.name;
	const image = input.image ?? "musepi";
	if (!name) return { ok: false, reason: "missing-name" };
	if (owned.has(`docker-run:${name}`)) return { ok: false, reason: "already-running" };
	const command = dockerCommandFor(input);
	const args = ["run", "-d", "--name", name, "-p", `127.0.0.1:${input.port}:${input.port}`, image];
	const result = await runOnce(command.file, [...command.prefix, ...args], 120_000);
	if (!result.ok) return { ok: false, reason: "failed", error: result.stderr.trim() || "docker run failed" };
	const record = {
		targetId: `docker-run:${name}`,
		kind: "docker",
		status: "running",
		startedAt: Date.now(),
		stderr: [],
		listeningPort: input.port,
		containerName: name,
		remote: Boolean(input.transport?.destination),
		transport: input.transport?.destination ? input.transport : undefined,
		displayCommand: displayCommand(command.file, [...command.prefix, ...args]),
	};
	owned.set(record.targetId, record);
	return { ok: true, status: emit(record) };
}

/**
 * Start `musepi serve` inside an existing container as an owned child.
 *
 * Two ports, and they are different: the daemon must bind the port that is
 * published *inside* the container (`containerPort`), while this shell can only
 * observe the port the container maps to on the host (`hostPort`). Using the
 * host port for both — which this did — starts a daemon on a port nothing
 * publishes, so the poll never succeeds and the failure is misreported as "the
 * daemon did not start".
 *
 * `docker exec` is a client process: stopping it ends the client, and the
 * daemon inside the container is expected to exit with its stdio closed. The
 * container itself is never removed — this shell did not create it.
 *
 * A remote container needs one thing more than a local one, and it is not the
 * `docker` call: the container publishes its port on the *far* host's loopback,
 * which this machine cannot dial. So the ssh connection that execs the daemon
 * also carries `-L`, mapping the same port from here to there. One child, two
 * jobs; stopping it drops both, which is exactly the lifetime a user expects.
 */
async function execContainer(input) {
	const key = input.targetId;
	const existing = owned.get(key);
	if (existing && stillOwned(existing)) return { ok: false, reason: "already-running", status: statusOf(existing) };
	if (existing) owned.delete(key);
	const containerPort = input.containerPort ?? input.port;
	const hostPort = input.hostPort ?? containerPort;
	if (await portOpen(hostPort)) {
		return {
			ok: false,
			reason: "port-in-use",
			error: `127.0.0.1:${hostPort} is already listening — this shell did not start it, so it is left alone.`,
		};
	}
	const forward = input.transport?.destination
		? ["-o", "ExitOnForwardFailure=yes", "-L", `${hostPort}:127.0.0.1:${hostPort}`]
		: [];
	const command = dockerCommandFor(input, forward);
	const args = ["exec", input.container, "musepi", "serve", "--port", String(containerPort)];
	const record = {
		targetId: key,
		kind: "docker",
		status: "connecting",
		startedAt: Date.now(),
		stderr: [],
		listeningPort: hostPort,
		containerName: input.container,
		remote: Boolean(input.transport?.destination),
	};
	owned.set(key, record);
	spawnOwned(record, command.file, [...command.prefix, ...args]);
	emit(record);
	const outcome = await waitForPort(hostPort, timeouts.daemon, () => record.status !== "failed" && stillOwned(record));
	if (record.status === "failed") return { ok: false, reason: "failed", status: statusOf(record) };
	if (outcome === "open") {
		record.status = "running";
		return { ok: true, status: emit(record) };
	}
	record.status = "failed";
	record.error =
		stderrTail(record) ||
		`docker exec did not open 127.0.0.1:${hostPort} in time — is container port ${containerPort} published?`;
	record.stopping = true;
	terminate(record);
	return { ok: false, reason: "timeout", status: emit(record) };
}

/** `wsl.exe -l -q` argv (the distribution list the form renders). */
function wslListArgs() {
	return ["-l", "-q"];
}

/**
 * Decode `wsl.exe` output.
 *
 * Real output is UTF-16LE, but the same command prints UTF-8 under some
 * configurations; a NUL-interleaved string is the UTF-16 form read as bytes,
 * so the presence of NULs decides the decoding rather than the platform.
 */
function decodeWslOutput(raw) {
	const text = String(raw);
	if (!text.includes("\u0000")) return text;
	// Re-encode the Latin-1 view back to bytes, then read it as UTF-16LE.
	return Buffer.from(text, "latin1").toString("utf16le");
}

/** Distributions installed for WSL, or why the list is unknown. */
async function listWslDistros(options = {}) {
	const result = await runOnce(options.wslCommand ?? "wsl.exe", wslListArgs());
	if (!result.ok) {
		return {
			ok: false,
			reason: /not installed|not on PATH|ENOENT/.test(result.stderr) ? "wsl-not-found" : "failed",
			error: result.stderr.trim() || "wsl.exe -l -q failed",
		};
	}
	const text = decodeWslOutput(result.stdout);
	return { ok: true, output: text };
}

/** `wsl.exe -d <distro> -- <command…>` argv for the daemon. */
function wslServeArgs(distro, port) {
	return ["-d", distro, "--", "musepi", "serve", "--port", String(port)];
}

/**
 * Start the daemon inside a distribution as an owned child.
 *
 * WSL2 forwards the distribution's loopback to Windows by default, which is
 * why the poll watches `127.0.0.1`; when forwarding is off (`.wslconfig`) the
 * port never answers and the target fails with that fact rather than hanging.
 */
async function startWslDaemon(input) {
	const key = input.targetId;
	const existing = owned.get(key);
	if (existing && stillOwned(existing)) return { ok: false, reason: "already-running", status: statusOf(existing) };
	if (existing) owned.delete(key);
	if (await portOpen(input.port)) {
		return {
			ok: false,
			reason: "port-in-use",
			error: `127.0.0.1:${input.port} is already listening — this shell did not start it, so it is left alone.`,
		};
	}
	const args = wslServeArgs(input.distro, input.port);
	const record = {
		targetId: key,
		kind: "wsl",
		status: "connecting",
		startedAt: Date.now(),
		stderr: [],
		listeningPort: input.port,
		distro: input.distro,
	};
	owned.set(key, record);
	spawnOwned(record, input.wslCommand ?? "wsl.exe", args);
	emit(record);
	const outcome = await waitForPort(input.port, timeouts.daemon, () => record.status !== "failed" && stillOwned(record));
	if (record.status === "failed") return { ok: false, reason: "failed", status: statusOf(record) };
	if (outcome === "open") {
		record.status = "running";
		return { ok: true, status: emit(record) };
	}
	record.status = "failed";
	record.error =
		stderrTail(record) ||
		`wsl.exe did not open 127.0.0.1:${input.port} in time — WSL2 localhost forwarding may be off (.wslconfig)`;
	record.stopping = true;
	terminate(record);
	return { ok: false, reason: "timeout", status: emit(record) };
}

/**
 * Stop one managed target.
 *
 * Only a record this shell created can be stopped. A target the user started
 * themselves has no record, so this reports `not-owned` and touches nothing.
 * A container this shell ran from an image is removed; a container it merely
 * exec'd into is not.
 */
async function stopTarget(targetId, options = {}) {
	const record = owned.get(targetId);
	if (!record) return { ok: true, stopped: false, reason: "not-owned" };
	if (record.kind === "docker" && record.containerName && targetId.startsWith("docker-run:")) {
		owned.delete(targetId);
		// The container may live on another host, so the removal goes the same
		// way the creation did. A record keeps its own transport rather than
		// trusting the caller to pass it again — a stop after an app restart has
		// nothing else to go on.
		const command = dockerCommandFor({ ...options, transport: record.transport ?? options.transport });
		const result = await runOnce(command.file, [...command.prefix, "rm", "-f", record.containerName], 60_000);
		record.status = result.ok ? "stopped" : "failed";
		if (!result.ok) record.error = result.stderr.trim() || "docker rm failed";
		return { ok: result.ok, stopped: result.ok, status: emit(record) };
	}
	if (!stillOwned(record)) {
		owned.delete(targetId);
		return { ok: true, stopped: false, reason: "already-exited", status: statusOf(record) };
	}
	terminate(record);
	owned.delete(targetId);
	record.status = "stopped";
	return { ok: true, stopped: true, status: emit(record) };
}

/** Every managed target's status (the renderer's initial read). */
function listTargets() {
	return [...owned.values()].map(statusOf);
}

/** Kill everything this shell owns. Called on app exit. */
async function stopAll() {
	const ids = [...owned.keys()];
	await Promise.all(ids.map(id => stopTarget(id).catch(() => {})));
	return ids;
}

module.exports = {
	buildSshTunnelArgs,
	containersPublishing,
	decodeWslOutput,
	detectDocker,
	execContainer,
	listContainers,
	listTargets,
	listWslDistros,
	onStatus,
	parseDockerPs,
	parsePublishedPorts,
	portOpen,
	probeRemoteCapabilities,
	resetForTests,
	runContainer,
	startSshTunnel,
	startWslDaemon,
	statusOf,
	stopAll,
	stopTarget,
	stillOwned,
	wslListArgs,
	wslServeArgs,
	SSH_CONNECT_TIMEOUT_MS,
	DAEMON_START_TIMEOUT_MS,
	DOCKER_PS_FORMAT,
};
