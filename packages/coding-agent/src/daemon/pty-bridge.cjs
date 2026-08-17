/**
 * PTY bridge — runs under plain `node` (node-pty forks via posix_spawnp,
 * which Bun's runtime can't host). The daemon spawns this process per
 * terminal, speaks newline-delimited JSON-RPC over stdio:
 *
 *   parent → bridge: {"id":1,"method":"open|input|resize|close","params":…}
 *   bridge → parent: {"kind":"open|data|exit|error","id":…,"data"/"code":…}
 *
 * node-pty is installed via Bun's symlinked cache; the native build lives
 * under prebuilds/ and only gets copied to build/Release by the package's
 * install script (which Bun skips). Self-heal by copying it here.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function ensureNativeBuild() {
	try {
		const pkgDir = path.dirname(require.resolve("node-pty/package.json"));
		const release = path.join(pkgDir, "build", "Release");
		if (fs.existsSync(path.join(release, "pty.node"))) return;
		const pre = path.join(pkgDir, "prebuilds", `${process.platform}-${process.arch}`);
		fs.mkdirSync(release, { recursive: true });
		for (const name of ["pty.node", "spawn-helper"]) {
			fs.copyFileSync(path.join(pre, name), path.join(release, name));
		}
		fs.chmodSync(path.join(release, "spawn-helper"), 0o755);
	} catch {
		// resolve or copy failed — let require surface the real error
	}
}

ensureNativeBuild();
const pty = require("node-pty");

const shells = new Map();

function send(obj) {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// Announce readiness immediately — the daemon waits for this line before
// sending the open request (avoids a handshake deadlock).
send({ kind: "ready" });

function handle(msg) {
	const { id, method, params } = msg;
	const p = params || {};
	try {
		switch (method) {
			case "open": {
				// Shell selection mirrors opencode: $SHELL → platform default,
				// and bash/zsh/sh/dash/ksh launch as LOGIN shells so the user's
				// profile (PATH, aliases, env) is loaded. The bridge inherits
				// the daemon's env, which includes the user's $SHELL.
				const platform = process.platform;
				let shell = p.shell || process.env.SHELL || (platform === "win32" ? "powershell.exe" : "bash");
				const base = path.basename(shell).toLowerCase();
				const args = ["bash", "zsh", "sh", "dash", "ksh"].includes(base) ? ["-l"] : [];
				// Fall back to HOME when the requested cwd doesn't exist.
				let cwd = p.cwd;
				try {
					if (!cwd || !fs.statSync(cwd).isDirectory()) cwd = process.env.HOME || "/";
				} catch {
					cwd = process.env.HOME || "/";
				}
				const env = {
					...process.env,
					TERM: "xterm-256color",
					COLORTERM: "truecolor",
					SHELL: shell,
					// GUI-spawned daemon hygiene (mirrors server.ts bun-pty path):
					// strip Electron/node-child artifacts that would leak into
					// the shell, suppress the macOS dev-tools dialog and git
					// credential prompts nobody can answer.
					APPLE_SUPPRESS_DEVELOPER_TOOL_POPUP: "1",
					GIT_TERMINAL_PROMPT: "0",
				};
				for (const k of ["ELECTRON_RUN_AS_NODE", "NODE_CHANNEL_FD", "BASH_ENV", "BASH_XTRACEFD", "ENV", "ARGV0"]) {
					delete env[k];
				}
				if (platform === "win32") {
					env.LC_ALL = "C.UTF-8";
					env.LC_CTYPE = "C.UTF-8";
					env.LANG = "C.UTF-8";
				}
				const proc = pty.spawn(shell, args, {
					cols: Number(p.cols) || 100,
					rows: Number(p.rows) || 30,
					cwd,
					env,
				});
				shells.set(id, proc);
				proc.onData(data => send({ kind: "data", id, data }));
				proc.onExit(({ exitCode }) => {
					shells.delete(id);
					send({ kind: "exit", id, code: exitCode });
				});
				send({ kind: "open", id, ok: true });
				break;
			}
			case "input":
				shells.get(id)?.write(p.data || "");
				break;
			case "resize":
				shells.get(id)?.resize(Number(p.cols) || 100, Number(p.rows) || 30);
				break;
			case "close":
				shells.get(id)?.kill();
				break;
			default:
				send({ kind: "error", id, message: `unknown method: ${method}` });
		}
	} catch (err) {
		send({ kind: "error", id, message: err instanceof Error ? err.message : String(err) });
	}
}

process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", chunk => {
	buf += chunk;
	let idx;
	while ((idx = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, idx);
		buf = buf.slice(idx + 1);
		if (!line.trim()) continue;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}
		handle(msg);
	}
});
process.stdin.on("end", () => {
	for (const proc of shells.values()) proc.kill();
	process.exit(0);
});
