// ============================================================
// Terminal provider seam — explicit backend selection for daemon
// terminal.open RPC calls.
//
// Providers:
//   "bun-pty" — native Bun process (preferred, lowest latency)
//   "node-pty" — node-pty bridge subprocess (fallback, more portable)
//   "auto" — try bun-pty first, fall back to node-pty on failure
//            (default behavior matches existing code)
//
// When the manifest declares an explicit provider, that selection is
// followed strictly — bun-pty failure surfaces as a terminal error
// instead of silently falling back. This is the "avoid automatic
// fallback recovery" piece of the assembly design.
//
// 收编第三刀（设计稿 §2）：具体实现（spawnBunPty/spawnNodePtyBridge）
// 注册进 TerminalRegistry（terminal-registry.ts 的 registerBackend
// 形状）；provider 解析策略（manifest > settings > auto）
// 不变。backend 缺席 = 结构化 NO_BACKEND（禁用兜底归因的数据源），
// auto 只在在册 backend 间回退。
// ============================================================

import * as path from "node:path";
import { spawn } from "@musepi/pi-utils/nodespawn";
import type { IPty } from "bun-pty";
import type { Settings } from "../config/settings.ts";
import {
	defaultTerminalRegistry,
	type TerminalBackend,
	type TerminalBackendType,
	type TerminalHandle,
	type TerminalRegistry,
	TerminalRegistryError,
} from "./terminal-registry.ts";

/** Explicit terminal backend selection. */
export type TerminalProvider = TerminalBackendType | "auto";

/** The handle returned to a daemon client for one open terminal.
 *  （契约类型本体在 terminal-registry.ts，此处重导出保持既有
 *  import 面不动。） */
export type { TerminalHandle } from "./terminal-registry.ts";

export interface TerminalProviderFactory {
	/** Resolve which provider to use given settings (and fallback). */
	resolve(settings: Settings): TerminalProvider;
	/** Spawn a terminal using this provider. */
	open(
		cwd: string,
		cols: number,
		rows: number,
		shell: string,
		shellArgs: string[],
		env: Record<string, string>,
	): Promise<TerminalHandle>;
}

// ------------------------------------------------------------
// bun-pty provider
// ------------------------------------------------------------

async function spawnBunPty(
	cwd: string,
	cols: number,
	rows: number,
	shell: string,
	shellArgs: string[],
	env: Record<string, string>,
): Promise<TerminalHandle> {
	const { spawn } = (await import("bun-pty")) as unknown as {
		spawn(
			cmd: string,
			args: string[],
			opts: { cols: number; rows: number; cwd: string; env: Record<string, string> },
		): IPty;
	};
	const proc = spawn(shell, shellArgs, { cols, rows, cwd, env });
	return {
		write: data => proc.write(data),
		resize: (columns, lines) => proc.resize(columns, lines),
		dispose: () => proc.kill(),
		onData: callback => proc.onData(callback),
		onExit: callback => proc.onExit(event => callback(event.exitCode)),
	};
}

// ------------------------------------------------------------
// node-pty bridge provider (runs via pty-bridge.cjs subprocess)
// ------------------------------------------------------------

async function spawnNodePtyBridge(
	cwd: string,
	cols: number,
	rows: number,
	shell: string,
	_shellArgs: string[],
	_env: Record<string, string>,
): Promise<TerminalHandle> {
	const { createInterface } = await import("node:readline");
	const bridgePath = path.join(import.meta.dir, "pty-bridge.cjs");

	const nodeBin = await resolveNodeBinary();
	const child = spawn(nodeBin, [bridgePath], {
		stdio: ["pipe", "pipe", "inherit"],
		// The bridge sanitizes shell-only variables before spawning the PTY.
		// Keep the original launcher environment here so Node wrappers retain
		// any IPC channel they need to start.
		env: { ...process.env, COLUMNS: String(cols), LINES: String(rows) },
	}) as unknown as {
		stdin: NodeJS.WritableStream;
		stdout: NodeJS.ReadableStream;
		kill(): void;
		on(event: "exit", cb: (code: number | null) => void): void;
		once(event: "error", cb: (err: Error) => void): void;
	};

	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity }) as unknown as {
		on(event: "line", cb: (line: string) => void): void;
		close(): void;
	};
	const { promise, resolve, reject } = Promise.withResolvers<TerminalHandle>();
	let open = false;
	let disposed = false;
	let exitSent = false;
	let exitCode: number | null = null;
	let dataCallback: ((data: string) => void) | undefined;
	let exitCallback: ((code: number | null) => void) | undefined;

	const send = (method: string, params: Record<string, unknown>): void => {
		if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ id: 1, method, params })}\n`);
	};
	const reportExit = (code: number | null): void => {
		if (exitSent) return;
		exitSent = true;
		exitCode = code;
		exitCallback?.(code);
	};
	const handle: TerminalHandle = {
		write: data => send("input", { data }),
		resize: (columns, lines) => send("resize", { cols: columns, rows: lines }),
		dispose: () => {
			if (disposed) return;
			disposed = true;
			lines.close();
			child.kill();
		},
		onData: callback => {
			dataCallback = callback;
		},
		onExit: callback => {
			exitCallback = callback;
			if (exitSent) callback(exitCode);
		},
	};
	const fail = (error: Error): void => {
		if (open) return;
		clearTimeout(timeout);
		lines.close();
		child.kill();
		reject(error);
	};
	const timeout = setTimeout(
		() => fail(new Error(`terminal bridge spawn timeout (node: ${nodeBin}, bridge: ${bridgePath})`)),
		8000,
	);
	timeout.unref?.();

	lines.on("line", (line: string) => {
		let msg: { kind?: string; data?: string; code?: number; message?: string };
		try {
			msg = JSON.parse(line) as typeof msg;
		} catch {
			return;
		}
		switch (msg.kind) {
			case "ready":
				send("open", { cwd, cols, rows, shell });
				break;
			case "open":
				open = true;
				clearTimeout(timeout);
				resolve(handle);
				break;
			case "data":
				dataCallback?.(msg.data ?? "");
				break;
			case "exit":
				reportExit(msg.code ?? 0);
				break;
			case "error":
				fail(new Error(msg.message ?? "terminal bridge error"));
				break;
		}
	});
	child.once("error", (err: Error) => fail(err));
	child.on("exit", code => reportExit(code));
	return promise;
}

async function resolveNodeBinary(): Promise<string> {
	const { existsSync } = await import("node:fs");
	const candidates = [
		process.env.NODE_BINARY,
		...(process.platform === "win32"
			? []
			: ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/opt/local/bin/node", "/usr/bin/node"]),
	].filter((c): c is string => typeof c === "string");
	for (const c of candidates) {
		try {
			if (existsSync(c)) return c;
		} catch {
			/* ignore */
		}
	}
	// Let the platform process launcher resolve Node from PATH. A string such
	// as "/usr/bin/env node" is not an executable path and also breaks Windows.
	return "node";
}

// ------------------------------------------------------------
// Provider registry（收编第三刀：静态 PROVIDERS 表 → TerminalRegistry
// registerBackend，provider 插件化的挂点）
// ------------------------------------------------------------

/** builtin bun-pty backend 工厂（terminal-provider-bunpty 插件单元与
 *  registerBuiltinTerminalBackends 共用同一实现，防漂移）。 */
export function createBunPtyBackend(): TerminalBackend {
	return { open: spawnBunPty };
}

/** builtin node-pty bridge backend 工厂（terminal-provider-nodepty 插件
 *  单元与 registerBuiltinTerminalBackends 共用同一实现，防漂移）。 */
export function createNodePtyBackend(): TerminalBackend {
	return { open: spawnNodePtyBridge };
}

/** builtin 后端（bun-pty / node-pty）注册进给定注册表。幂等：同一
 *  注册表重复调用是 no-op（模块热重载安全）；生产宿主路径已改走
 *  terminal-core-plugin.ts 的 provider 插件单元（cordis effect 账本
 *  挂接），本 helper 留给默认注册表消费者与测试。 */
const builtinRegistered = new WeakSet<TerminalRegistry>();

export function registerBuiltinTerminalBackends(registry: TerminalRegistry = defaultTerminalRegistry): void {
	if (builtinRegistered.has(registry)) return;
	builtinRegistered.add(registry);
	registry.registerBackend("bun-pty", createBunPtyBackend());
	registry.registerBackend("node-pty", createNodePtyBackend());
}

/**
 * Read the effective terminal provider from manifest + settings.
 *
 * Precedence (highest first):
 *   1. Manifest `[seams.terminal] provider`
 *   2. Settings `terminal.provider` (raw extension key)
 *   3. Defaults to "auto"
 */
export function resolveTerminalProvider(
	settings: Settings,
	manifestProvider?: TerminalProvider | null,
): TerminalProvider {
	if (manifestProvider) return manifestProvider;
	const raw = settings.getRaw("terminal.provider") as string | undefined;
	if (raw === "bun-pty" || raw === "node-pty") return raw;
	return "auto";
}

/** Resolve providers exclusively from the Cordis-owned backend registry.
 * Explicit selections never fall back silently; auto tries registered backends
 * in bun-pty → node-pty order and reports NO_BACKEND when none remain. */
export function getTerminalProvider(
	name: TerminalProvider,
	registry: TerminalRegistry = defaultTerminalRegistry,
): TerminalProviderFactory {
	if (name === "auto") {
		return {
			resolve(settings: Settings): TerminalProvider {
				const raw = settings.getRaw("terminal.provider") as string | undefined;
				return raw === "bun-pty" ? "bun-pty" : raw === "node-pty" ? "node-pty" : "auto";
			},
			async open(cwd, cols, rows, shell, shellArgs, env) {
				const order: readonly TerminalBackendType[] = ["bun-pty", "node-pty"];
				let lastErr: unknown;
				for (const type of order) {
					if (!registry.hasBackend(type)) continue;
					try {
						return await registry.getBackend(type).open(cwd, cols, rows, shell, shellArgs, env);
					} catch (err) {
						lastErr = err;
						console.warn(`[terminal] ${type} failed (${String(err)}), trying next backend`);
					}
				}
				throw new TerminalRegistryError(
					"NO_BACKEND",
					lastErr instanceof Error
						? `no terminal backend available: ${lastErr.message}`
						: "no terminal backend available",
				);
			},
		};
	}
	return {
		resolve(_settings): TerminalProvider {
			return name;
		},
		async open(cwd, cols, rows, shell, shellArgs, env) {
			return registry.getBackend(name).open(cwd, cols, rows, shell, shellArgs, env);
		},
	};
}

const PROVIDER_NAMES: readonly TerminalProvider[] = ["bun-pty", "node-pty", "auto"];

export function isTerminalProvider(value: unknown): value is TerminalProvider {
	return typeof value === "string" && (PROVIDER_NAMES as readonly string[]).includes(value);
}
