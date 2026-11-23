// Lid-closed sleep prevention for the desktop shell.
//
// Owned by the main process because every mechanism here belongs to the
// machine the shell runs on, not to the daemon session: macOS keeps an IOKit
// assertion alive through a timeout the shell renews (so a daemon restart does
// not drop it), Windows switches the lid power actions to "do nothing" (a
// system setting, backed up and restored), and Linux holds a login-manager
// inhibitor for lid switches.
//
// Every enable returns its own handle, so a superseded request can never
// release the mechanism a newer one just acquired. The caller decides when the
// feature is on and calls acquire/release; nothing here reads the daemon
// settings, so this module stays testable on its own.

const { spawn } = require("node:child_process");

const HELPER_TIMEOUT_MS = 15_000;
// Comfortably longer than the renewal interval in
// startMacOSPowerAssertionWithTimeout, so a daemon restart window is covered.
const MAC_ASSERTION_TIMEOUT_SECONDS = 10;
const WINDOWS_LIDACTION_DO_NOTHING = 0;
const LIDACTION_SCHEME = "scheme_current";
const SUPPORTED = new Set(["darwin", "win32", "linux"]);

let log = msg => console.log(`[lid-power] ${msg}`);

function startMacAssertionWithTimeout(seconds) {
	// Bundled builds resolve the compiled daemon's embedded addon through the
	// same loader the daemon uses; a development tree resolves the local one.
	const { startMacOSPowerAssertionWithTimeout } = require("@musepi/pi-natives");
	return startMacOSPowerAssertionWithTimeout(seconds);
}

/**
 * @param {{ log?: (message: string) => void, macAssertionTimeout?: (seconds: number) => { stop(): void } }} [options]
 *   `macAssertionTimeout` replaces the renewed macOS assertion; tests inject a
 *   fake so the state machine can run on any platform.
 */
function createLidPower({ log: logger, macAssertionTimeout } = {}) {
	if (logger) log = logger;
	const assertion = macAssertionTimeout ?? startMacAssertionWithTimeout;
	let handle;
	// Requests are applied in order; a superseded enable hands its mechanism
	// back instead of hiding it behind a handle nobody can release.
	let serial = 0;

	return {
		get enabled() {
			return handle !== undefined;
		},
		supported: () => SUPPORTED.has(process.platform),
		/** Apply the preference; resolves once the machine is held awake. */
		async acquire() {
			const request = ++serial;
			const next = await acquireForPlatform(assertion);
			if (request !== serial) {
				// A newer request owns the state; hand this mechanism back and
				// report what holds now rather than surfacing a race.
				await discard(next).catch(() => {});
				return { enabled: handle !== undefined };
			}
			await discard(handle);
			handle = next;
			log(`enabled (${next.kind})`);
			return { enabled: true };
		},
		/** Drop the preference; resolves once the machine's own policy is back. */
		async release() {
			serial++;
			const released = handle;
			handle = undefined;
			if (!released) return { enabled: false };
			try {
				await discard(released);
			} catch (error) {
				// The mechanism is still in place; say so instead of claiming sleep.
				handle = released;
				throw error;
			}
			log("disabled");
			return { enabled: false };
		},
		/** A helper that exited on its own means the preference no longer holds. */
		noteLost() {
			if (!handle) return;
			log(`lost (${handle.kind})`);
			handle = undefined;
		},
		/** Restore the machine's own policy when the shell quits. */
		restoreBeforeQuit() {
			const held = handle;
			handle = undefined;
			if (!held) return;
			discard(held).catch(error => log(`restore on quit failed: ${error?.message ?? error}`));
		},
	};
}

function discard(handle) {
	if (!handle) return Promise.resolve();
	return handle.restore ? handle.restore() : Promise.resolve(handle.stop());
}

function run(command, args, timeoutMs = HELPER_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		const result = { status: null, stdout: "", stderr: "" };
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`${command} timed out`));
		}, timeoutMs);
		child.stdout.on("data", chunk => {
			result.stdout += chunk;
		});
		child.stderr.on("data", chunk => {
			result.stderr += chunk;
		});
		child.on("error", error => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", status => {
			clearTimeout(timer);
			resolve({ ...result, status });
		});
	});
}

// ── macOS: IOKit assertion with a renewed timeout ──────────────────────────

function acquireDarwin(assertion) {
	const held = assertion(MAC_ASSERTION_TIMEOUT_SECONDS);
	return { kind: "darwin", stop: () => held.stop() };
}

// ── Windows: lid power actions ─────────────────────────────────────────────

/** Parse the AC/DC lid action indices out of `powercfg /query` output. */
function parseLidActions(output) {
	const matches = [...output.matchAll(/:\s*0[xX]([0-9a-fA-F]{8})\s*$/gm)];
	if (matches.length !== 2) return undefined;
	const ac = Number.parseInt(matches[0][1], 16);
	const dc = Number.parseInt(matches[1][1], 16);
	return ac <= 3 && dc <= 3 ? { ac, dc } : undefined;
}

/** Lid-action block of a full `powercfg /q` dump, up to the next setting. */
function lidActionBlock(output) {
	const lines = output.split(/\r?\n/);
	const start = lines.findIndex(line => /LIDACTION|5ca83367/.test(line));
	if (start < 0) return undefined;
	const rest = lines.slice(start + 1, start + 16);
	const end = rest.findIndex(line => /设置 GUID|Setting GUID|^\s{2}\S/.test(line));
	return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

async function queryWindowsLidActions() {
	try {
		const scoped = await run("powercfg", ["/q", LIDACTION_SCHEME, "SUB_BUTTONS", "LIDACTION"]);
		const direct = scoped.status === 0 ? parseLidActions(scoped.stdout) : undefined;
		if (direct) return direct;
		// Some OEM profiles resolve the lid setting only from the full dump; a
		// profile without the setting at all has no lid action to switch.
		const full = await run("powercfg", ["/q", LIDACTION_SCHEME]);
		if (full.status !== 0) return undefined;
		const block = lidActionBlock(full.stdout);
		return block ? parseLidActions(block) : { ac: WINDOWS_LIDACTION_DO_NOTHING, dc: WINDOWS_LIDACTION_DO_NOTHING };
	} catch {
		return undefined;
	}
}

async function writeWindowsLidActions(ac, dc) {
	const set = async (alias, index) => {
		const { status, stderr } = await run("powercfg", [
			`/set${alias}valueindex`,
			LIDACTION_SCHEME,
			"SUB_BUTTONS",
			"LIDACTION",
			String(index),
		]);
		if (status !== 0) throw new Error(stderr.trim() || `powercfg ${alias} lid action write failed`);
	};
	await Promise.all([set("ac", ac), set("dc", dc)]);
	const applied = await queryWindowsLidActions();
	if (!applied || applied.ac !== ac || applied.dc !== dc) throw new Error("powercfg lid action was not applied");
}

async function acquireWindows() {
	const current = await queryWindowsLidActions();
	if (!current) throw new Error("powercfg lid action query failed");
	if (current.ac === WINDOWS_LIDACTION_DO_NOTHING && current.dc === WINDOWS_LIDACTION_DO_NOTHING) {
		return { kind: "win32", restore: async () => {} };
	}
	await writeWindowsLidActions(WINDOWS_LIDACTION_DO_NOTHING, WINDOWS_LIDACTION_DO_NOTHING);
	return {
		kind: "win32",
		restore: async () => {
			// Only restore the sides still switched by us: a value the user
			// changed back by hand must not be overwritten with a stale backup.
			const now = await queryWindowsLidActions();
			if (!now) throw new Error("powercfg lid action query failed");
			const ac = now.ac === WINDOWS_LIDACTION_DO_NOTHING ? current.ac : undefined;
			const dc = now.dc === WINDOWS_LIDACTION_DO_NOTHING ? current.dc : undefined;
			if (ac === undefined && dc === undefined) return;
			await writeWindowsLidActions(ac ?? now.ac, dc ?? now.dc);
		},
	};
}

// ── Linux: logind inhibitor ────────────────────────────────────────────────

async function acquireLinux() {
	const child = spawn(
		"systemd-inhibit",
		[
			"--what=handle-lid-switch",
			"--mode=block",
			"--who=MusePi",
			"--why=MusePi keeps running with the lid closed",
			"sh",
			"-c",
			'printf "ready\\n"; read -r lifetime',
		],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	const ready = Promise.withResolvers();
	let stderr = "";
	let adopting = true;
	const onEarlyExit = () => {
		if (adopting) ready.reject(new Error(stderr.trim() || "systemd-inhibit exited"));
	};
	const onData = chunk => {
		if (adopting && String(chunk).includes("ready\n")) {
			adopting = false;
			child.stdout.off("data", onData);
			child.off("exit", onEarlyExit);
			ready.resolve();
		}
	};
	child.stderr.on("data", chunk => {
		stderr = (stderr + chunk).slice(-2048);
	});
	child.stdout.on("data", onData);
	child.once("error", error => ready.reject(error));
	child.once("exit", onEarlyExit);
	const timer = setTimeout(() => ready.reject(new Error("systemd-inhibit timed out")), HELPER_TIMEOUT_MS);
	try {
		await ready.promise;
	} catch (error) {
		child.stdin?.destroy();
		child.kill();
		throw error;
	} finally {
		clearTimeout(timer);
	}
	return {
		kind: "linux",
		source: child,
		stop: () => {
			child.stdin?.end();
			child.kill();
		},
	};
}

// ── Platform dispatch ──────────────────────────────────────────────────────

async function acquireForPlatform(assertion) {
	if (process.platform === "darwin") return acquireDarwin(assertion);
	if (process.platform === "win32") return acquireWindows();
	if (process.platform === "linux") return acquireLinux();
	throw new Error(`lid sleep prevention is unsupported on ${process.platform}`);
}

module.exports = { createLidPower, lidActionBlock, parseLidActions };