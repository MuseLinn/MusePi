#!/usr/bin/env bun
/**
 * Dev-loop desktop launcher — `bun run desktop` without the full rebuild
 * ceremony on every start.
 *
 * The plain `desktop` chain (`build && relaunch && electron .`) wipes and
 * rebuilds the dist bundle (11k modules, pages of asset output) even when
 * nothing changed since the last start, which buried the one log line that
 * matters (did the app come up?) under noise and cost ~15s per iteration.
 *
 * Freshness rule: dist/index.html is up to date when it exists and is newer
 * than every bundler input — this package's src/public/html entries and the
 * workspace dependency sources that get compiled into the bundle
 * (@musepi/* packages). Inputs are stat-walked only (no hashing), which is
 * sub-second for this tree. MUSEPI_FORCE_BUILD=1 always rebuilds.
 *
 * After the (skipped or real) build it runs the same relaunch + electron
 * steps as the old chain, forwarding Electron's exit code.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const pkgDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(pkgDir, "..", "..");
const marker = join(pkgDir, "dist", "index.html");

/** Recursive newest-mtime walk (dirs recursed; missing paths skipped). */
function newestMtime(paths) {
	let newest = 0;
	const walk = (p) => {
		let st;
		try {
			st = statSync(p);
		} catch {
			return; // dangling symlink / race — the build would surface it
		}
		if (st.isDirectory()) {
			for (const entry of readdirSync(p)) walk(join(p, entry));
			return;
		}
		if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
	};
	for (const p of paths) walk(p);
	return newest;
}

/** Directories compiled into the renderer bundle (workspace sources). */
const INPUT_DIRS = [
	join(pkgDir, "src"),
	join(pkgDir, "public"),
	...["client-core", "coding-agent", "catalog", "agent", "ai", "utils", "tui", "natives"].map((p) =>
		join(repoRoot, "packages", p, "src"),
	),
];
const INPUT_FILES = [
	...["index.html", "pet.html", "bubbles.html", "pin.html", "tray-menu.html"].map((f) => join(pkgDir, f)),
	join(pkgDir, "package.json"),
];

function distFresh() {
	if (!existsSync(marker)) return false;
	if (process.env.MUSEPI_FORCE_BUILD === "1") return false;
	const builtAt = statSync(marker).mtimeMs;
	const inputsNewest = Math.max(newestMtime(INPUT_DIRS), newestMtime(INPUT_FILES));
	return builtAt >= inputsNewest;
}

function run(cmd, args, options = {}) {
	return spawnSync(cmd, args, { cwd: pkgDir, stdio: "inherit", ...options });
}

if (distFresh()) {
	const ageSec = Math.round((Date.now() - statSync(marker).mtimeMs) / 1000);
	console.log(`dist fresh (built ${ageSec}s ago, no bundler input newer) — skipping build`);
} else {
	console.log("dist stale or missing — rebuilding…");
	const build = run("bun", ["run", "build"]);
	if (build.status !== 0) process.exit(build.status ?? 1);
}

const relaunch = run("bun", ["scripts/relaunch-gui.mjs"]);
if (relaunch.status !== 0) process.exit(relaunch.status ?? 1);

// Resolve the Electron binary the same way electron's own cli would, then
// hand over stdio so main-process output streams through unchanged.
// require("electron") outside Electron returns the exe path string.
const { createRequire } = await import("node:module");
const require = createRequire(join(pkgDir, "package.json"));
const electronPath = (() => {
	try {
		const resolved = require("electron");
		if (typeof resolved === "string") return resolved;
	} catch {
		// fall through to the .bin shim
	}
	return join(pkgDir, "node_modules", ".bin", process.platform === "win32" ? "electron.exe" : "electron");
})();

// Startup resilience. This machine class (PC-manager "optimizers" / policy
// resets) breaks Electron in TWO independent ways, both surfacing as a fast
// bare exit 3:
//   A. Chromium sandbox init killed silently — even `electron --version`
//      exits 3 sandboxed, fine under --no-sandbox.
//   B. SeCreateSymbolicLinkPrivilege revoked — the ProcessSingleton lock is
//      a SYMLINK (Chromium-internal, no opt-out); creation ACCESS-DENIEDs.
//      Nasty twist: with the sandbox bypassed, Chromium logs the lock error
//      but exits 0 (single-instance guard quits cleanly) — a bare exit-code
//      check reads "success" while no window appeared. So stderr is piped
//      through a rolling scanner: a <10s exit 3 retries once with
//      --no-sandbox (dev loop only; release keeps the sandbox), and ANY fast
//      exit hitting the ProcessSingleton pattern prints the remediation and
//      exits 1 instead of forwarding the misleading 0.
const SINGLETON_PATTERN = /process_singleton_win|Lock file can not be created/i;
let startAt = Date.now();
let retried = false;
let stderrBuf = "";
const launch = (args) => {
	startAt = Date.now();
	stderrBuf = "";
	const child = spawn(electronPath, args, { cwd: pkgDir, stdio: ["inherit", "inherit", "pipe"] });
	child.stderr.on("data", (chunk) => {
		process.stderr.write(chunk);
		stderrBuf = (stderrBuf + chunk.toString()).slice(-4096);
	});
	child.on("exit", (code, signal) => {
		if (signal) {
			process.kill(process.pid, signal);
			return;
		}
		const fast = Date.now() - startAt < 10_000;
		if (code === 3 && !retried && fast) {
			retried = true;
			process.stderr.write("[desktop] sandbox init blocked on this machine — retrying once with --no-sandbox (dev loop only)…\n");
			launch(["--no-sandbox", "."]);
			return;
		}
		if (SINGLETON_PATTERN.test(stderrBuf) && fast) {
			process.stderr.write(
				"[desktop] single-instance lock creation failed: the SeCreateSymbolicLinkPrivilege user right was revoked; the app did not start.\n" +
					"[desktop] Fix: run scripts/grant-symlink-privilege.ps1 as administrator, then sign out & back in (a reboot usually cures both this and the sandbox).\n",
			);
			process.exit(1);
		}
		if (code !== 0 && code !== null && fast) {
			process.stderr.write(`[desktop] Electron exited fast (code ${code}) — if sandbox/privilege related, a reboot usually recovers.\n`);
		}
		process.exit(code ?? 0);
	});
	child.on("error", (err) => {
		process.stderr.write(`[desktop] failed to spawn electron: ${err.message}\n`);
		process.exit(1);
	});
};
launch(["."]);
