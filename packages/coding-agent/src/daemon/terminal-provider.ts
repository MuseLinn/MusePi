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
		): TerminalHandle;
	};
	const proc = spawn(shell, shellArgs, { cols, rows, cwd, env });
	return proc;
}

// ------------------------------------------------------------
// node-pty bridge provider (runs via pty-bridge.cjs subprocess)
// ------------------------------------------------------------

async function spawnNodePtyBridge(
	_cwd: string,
	cols: number,
	rows: number,
	_shell: string,
	_shellArgs: string[],
	_env: Record<string, string>,
): Promise<TerminalHandle> {
	const { createInterface } = await import("node:readline");
	const bridgePath = path.join(import.meta.dir, "pty-bridge.cjs");

	const nodeBin = await resolveNodeBinary();
	const child = spawn(nodeBin, [bridgePath], {
		stdio: ["pipe", "pipe", "inherit"],
		env: { ...process.env, COLUMNS: String(cols), LINES: String(rows) },
	}) as unknown as {
		stdin: NodeJS.WritableStream;
		stdout: NodeJS.ReadableStream;
		kill(): void;
		on(event: "exit", cb: (code: number | null) => void): void;
		once(event: "error", cb: (err: Error) => void): void;
		off(event: "exit", cb: () => void): void;
	};

	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity }) as unknown as {
		on(event: "line", cb: (line: string) => void): void;
		once(event: "line", cb: (line: string) => void): void;
		close(): void;
	};

	return new Promise<TerminalHandle>((resolve, reject) => {
		let open = false;
		let exitSent = false;
		lines.on("line", (line: string) => {
			let msg: { kind?: string; id?: string; data?: string; code?: number; message?: string } | null = null;
			try {
				msg = JSON.parse(line);
			} catch {
				/* skip */
			}
			if (!msg) return;
			if (msg.kind === "open") {
				open = true;
			} else if (msg.kind === "exit" && !exitSent) {
				exitSent = true;
				child.off("exit", () => {});
				resolve({
					write(d: string) {
						if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ method: "input", data: d })}\n`);
					},
					resize(c: number, r: number) {
						child.stdin.write(`${JSON.stringify({ method: "resize", cols: c, rows: r })}\n`);
					},
					dispose() {
						lines.close();
						child.kill();
					},
					onExit(cb) {
						child.on("exit", cb);
					},
					onData(cb) {
						lines.on("line", (l: string) => {
							try {
								const m = JSON.parse(l);
								if (m.kind === "data") cb(m.data ?? "");
							} catch {}
						});
					},
				});
			} else if (msg.kind === "error") {
				reject(new Error(msg.message ?? "terminal bridge error"));
			}
		});
		child.once("error", (err: Error) => {
			if (!open) reject(err);
		});
		// Timeout fallback: if bridge doesn't open within 8s, fail.
		setTimeout(() => {
			if (!open && !exitSent) reject(new Error("terminal bridge spawn timeout"));
		}, 8000).unref?.();
	});
}

async function resolveNodeBinary(): Promise<string> {
	const { existsSync } = await import("node:fs");
	const candidates = [
		process.env.NODE_BINARY,
		"/opt/homebrew/bin/node",
		"/usr/local/bin/node",
		"/opt/local/bin/node",
		"/usr/bin/node",
		"/usr/bin/env node",
	].filter((c): c is string => typeof c === "string");
	for (const c of candidates) {
		if (c === "/usr/bin/env node") return c;
		try {
			if (existsSync(c)) return c;
		} catch {
			/* ignore */
		}
	}
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

/** 解析 provider 工厂。显式 provider 的 open 直查注册表——backend
 *  缺席给结构化 NO_BACKEND（manifest 显式声明的严格语义：不静默回退）；
 *  auto 只在在册 backend 间按 bun-pty → node-pty 顺序回退，
 *  全缺席 = 结构化 NO_BACKEND。
 *
 *  组件黑名单（terminal.disabledBackends，插件「包含的组件」开关写入，
 *  voice/engine-denylist 同哲学）：被禁后端从 auto 回退顺序剔除；显式
 *  选中（manifest 或 settings）被禁后端时 open 给结构化 DISABLED_BACKEND
 *  ——禁用是用户显式意图，不静默回退到 auto。 */
export function getTerminalProvider(
	name: TerminalProvider,
	registry: TerminalRegistry = defaultTerminalRegistry,
	disabled: ReadonlySet<string> = new Set(),
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
					if (!registry.hasBackend(type) || disabled.has(type)) continue;
					try {
						return await registry.getBackend(type).open(cwd, cols, rows, shell, shellArgs, env);
					} catch (err) {
						// Log but continue — auto is intended to degrade, but only
						// among registered backends (disabled plugins are skipped).
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
			if (disabled.has(name)) {
				throw new TerminalRegistryError(
					"DISABLED_BACKEND",
					`terminal backend "${name}" is disabled (plugin component toggle)`,
				);
			}
			return registry.getBackend(name).open(cwd, cols, rows, shell, shellArgs, env);
		},
	};
}

/** 读终端后端组件黑名单（fail-soft：坏值/非数组 = 空集）。组件开关
 *  （extensions.setComponentEnabled 经 extension-service）写
 *  `terminal.disabledBackends`，本 helper 是唯一读取方。 */
export function readDisabledTerminalBackends(source: { get(key: string): unknown }): Set<string> {
	let raw: unknown;
	try {
		raw = source.get("terminal.disabledBackends");
	} catch {
		return new Set();
	}
	if (!Array.isArray(raw)) return new Set();
	return new Set(raw.filter((item): item is string => typeof item === "string"));
}

const PROVIDER_NAMES: readonly TerminalProvider[] = ["bun-pty", "node-pty", "auto"];

export function isTerminalProvider(value: unknown): value is TerminalProvider {
	return typeof value === "string" && (PROVIDER_NAMES as readonly string[]).includes(value);
}
