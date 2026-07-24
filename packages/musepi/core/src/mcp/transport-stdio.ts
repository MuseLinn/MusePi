// ============================================================
// MusePi MCP — stdio transport.
//
// Spawns the server as a child process; JSON-RPC messages are
// newline-delimited UTF-8 JSON on stdin/stdout (MCP stdio framing —
// messages MUST NOT contain embedded newlines). stderr is captured
// into a short tail for crash diagnostics.
// ============================================================

import { type ChildProcess, spawn } from "node:child_process";
import type { McpTransport } from "./json-rpc.ts";
import type { McpJsonRpcMessage } from "./types.ts";

export interface StdioTransportOptions {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd: string;
}

/** Injectable process handle for tests. */
export interface McpSpawnedProcess {
	write(chunk: string): void;
	onStdout(listener: (chunk: Buffer) => void): void;
	onStderr?(listener: (chunk: Buffer) => void): void;
	kill(): void;
	readonly exited: Promise<number | null>;
}

export type McpSpawnFn = (
	command: string,
	args: string[],
	options: { cwd: string; env: Record<string, string> },
) => McpSpawnedProcess;

export const mcpNodeSpawn: McpSpawnFn = (command, args, { cwd, env }) => {
	// Windows: npm/pip shims resolve to .cmd/.bat launchers, which Node (≥18.20)
	// refuses to spawn without a shell. Quote every token and go through
	// cmd.exe — args are server-config tokens ("--stdio", …), never user input.
	const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
	const proc: ChildProcess = needsShell
		? spawn([command, ...args].map((token) => `"${token.replace(/"/g, '\\"')}"`).join(" "), {
				cwd,
				env,
				shell: true,
				stdio: ["pipe", "pipe", "pipe"],
			})
		: spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	// The child (and its pipes) must not keep the parent's event loop alive on
	// their own — a finished `musepi -p` run should be able to exit while a
	// warm server stays up. Activity is tracked by the client instead.
	proc.unref();
	for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
		(stream as { unref?: () => void } | null)?.unref?.();
	}
	const exited = new Promise<number | null>((resolve) => {
		proc.once("exit", (code) => resolve(code));
		proc.once("error", () => resolve(null));
	});
	return {
		write(chunk) {
			proc.stdin?.write(chunk);
		},
		onStdout(listener) {
			proc.stdout?.on("data", listener);
		},
		onStderr(listener) {
			proc.stderr?.on("data", listener);
		},
		kill() {
			proc.kill();
		},
		exited,
	};
};

export class StdioMcpTransport implements McpTransport {
	#proc: McpSpawnedProcess;
	#buffer = "";
	#messageListener: ((message: McpJsonRpcMessage) => void) | null = null;
	#closeListener: (() => void) | null = null;
	#closed = false;
	/** Short stderr tail for crash diagnostics. */
	stderrTail = "";

	constructor(options: StdioTransportOptions, spawnFn: McpSpawnFn = mcpNodeSpawn) {
		const env = { ...process.env, ...options.env } as Record<string, string>;
		this.#proc = spawnFn(options.command, options.args ?? [], { cwd: options.cwd, env });
		this.#proc.onStdout((chunk) => this.#onData(chunk));
		this.#proc.onStderr?.((chunk) => {
			this.stderrTail = (this.stderrTail + chunk.toString("utf-8")).slice(-2000);
		});
		this.#proc.exited.then(() => this.#handleClose());
	}

	#onData(chunk: Buffer): void {
		this.#buffer += chunk.toString("utf-8");
		let newline = this.#buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.#buffer.slice(0, newline).trim();
			this.#buffer = this.#buffer.slice(newline + 1);
			newline = this.#buffer.indexOf("\n");
			if (line.length === 0) continue;
			let message: McpJsonRpcMessage;
			try {
				message = JSON.parse(line) as McpJsonRpcMessage;
			} catch {
				continue; // malformed line — later frames are still well-framed
			}
			try {
				this.#messageListener?.(message);
			} catch {
				// listener errors must not kill the reader loop
			}
		}
	}

	#handleClose(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#closeListener?.();
	}

	send(message: McpJsonRpcMessage): void {
		if (this.#closed) return;
		this.#proc.write(`${JSON.stringify(message)}\n`);
	}

	onMessage(listener: (message: McpJsonRpcMessage) => void): void {
		this.#messageListener = listener;
	}

	onClose(listener: () => void): void {
		this.#closeListener = listener;
	}

	close(): void {
		if (this.#closed) return;
		this.#proc.kill();
		this.#handleClose();
	}
}
