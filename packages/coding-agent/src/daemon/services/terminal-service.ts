import type { Settings } from "../../config/settings";
import type { DaemonService } from "./types";

/**
 * TerminalService — 交互式终端面（L2 宿主服务，P1 抽取）。
 *
 * 能力缝声明（M2-2.4）：
 * - 输入：RPC `terminal.open`（按连接开一个 pty，cwd/cols/rows）、
 *   `terminal.input` / `terminal.resize` / `terminal.close`（按 id 寻址）。
 * - 输出：pty 输出/退出经调用方连接的 envelope 推送（terminal-output /
 *  terminal-exit）；seq 编号沿用 DaemonServer 的共享计数器（依赖注入
 *  nextSeq，保证编号空间与原实现逐点一致）。
 * - 生命周期：桥接表（id → provider handle）为服务内内存态；进程退出随
 *  daemon 消亡。terminal.close 是唯一清理路径（原语义：未知 id 静默
 *  ok，input/resize 未知 id 抛错）。
 *
 * 范围边界：终端 provider 解析（terminal-provider.ts 的 manifest seam →
 *  settings → auto 三级）仍在服务内，但 provider 模块图保持动态 import
 * 懒加载；设置读取经 settings() 依赖（宿主 #settingsForRpc），P1 不搬
 * 设置面。
 */
export interface TerminalServiceDeps {
	/** DaemonServer 共享 envelope 序号（terminal-output / terminal-exit
	 *  沿用原 #eventSeq 编号空间）。 */
	nextSeq(): number;
	/** 向调用方连接推送 envelope（宿主 emitEvent）。 */
	emit(
		conn: unknown,
		envelope: { kind: "terminal-output" | "terminal-exit"; seq: number; payload: Record<string, unknown> },
	): void;
	/** 解析设置（宿主 #settingsForRpc；解析失败返回 null，原语义）。 */
	settings(): Promise<Settings | null>;
}

/** 桥接条目：provider handle 的写/处置适配面（原 server 内联形状）。 */
interface TerminalBridge {
	write(msg: unknown): Promise<void>;
	dispose(): void;
}

export class TerminalService implements DaemonService {
	readonly key = "terminal";
	readonly routes = {
		"terminal.close": "close",
		"terminal.input": "input",
		"terminal.open": "open",
		"terminal.resize": "resize",
	} as const;

	readonly #deps: TerminalServiceDeps;
	/** Live pty bridges keyed by terminal id（provider 进程/handle 拥有 node-pty）。 */
	readonly #terminals = new Map<string, TerminalBridge>();
	#terminalSeq = 0;

	constructor(deps: TerminalServiceDeps) {
		this.#deps = deps;
	}

	/** RPC terminal.open：开一个 pty 并把输出接到调用方连接。
	 *  主后端 bun-pty 原生跑在 Bun daemon 内（无额外进程）；失败回退
	 *  node pty-bridge 子进程。shell/env 处理对齐 opencode：$SHELL →
	 *  平台默认，bash/zsh/sh/dash/ksh 登录 shell，TERM/COLORTERM 强制。 */
	async open(params: { cwd?: string; cols?: number; rows?: number }, conn: unknown): Promise<{ id: string }> {
		const p = params ?? {};
		const path = await import("node:path");
		const fs = await import("node:fs");
		const id = `term-${++this.#terminalSeq}`;
		// Resolve the shell + env exactly as the bridge would.
		const platform = process.platform;
		const shell = process.env.SHELL || (platform === "win32" ? "powershell.exe" : "bash");
		const base = path.basename(shell).toLowerCase();
		const args = ["bash", "zsh", "sh", "dash", "ksh"].includes(base) ? ["-l"] : [];
		const cwd = p.cwd ?? "";
		let realCwd = cwd;
		try {
			if (!realCwd || !fs.statSync(realCwd).isDirectory()) realCwd = process.env.HOME || "/";
		} catch {
			realCwd = process.env.HOME || "/";
		}
		const cols = p.cols ?? 100;
		const rows = p.rows ?? 30;
		const env: Record<string, string> = {
			...process.env,
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			SHELL: shell,
			COLUMNS: String(cols),
			LINES: String(rows),
			// GUI-spawned daemons inherit Electron/node-child artifacts that
			// would leak into every pty shell (openchamber parity):
			// ELECTRON_RUN_AS_NODE turns `node`/`npx` into Electron's node,
			// NODE_CHANNEL_FD points at a dead IPC fd, BASH_ENV/ENV silently
			// alter shell startup. APPLE_SUPPRESS_DEVELOPER_TOOL_POPUP stops
			// the "install command line developer tools" dialog from a pty
			// nobody can answer (proma parity); GIT_TERMINAL_PROMPT keeps git
			// from hanging on credentials.
			APPLE_SUPPRESS_DEVELOPER_TOOL_POPUP: "1",
			GIT_TERMINAL_PROMPT: "0",
		};
		for (const k of [
			"ELECTRON_RUN_AS_NODE",
			"NODE_CHANNEL_FD",
			"BASH_ENV",
			"BASH_XTRACEFD",
			"ENV",
			"ARGV0",
		] as const) {
			delete env[k];
		}
		if (platform === "win32") {
			env.LC_ALL = "C.UTF-8";
			env.LC_CTYPE = "C.UTF-8";
			env.LANG = "C.UTF-8";
		}

		// Resolve provider from manifest seam > settings.raw > default "auto".
		const { getTerminalProvider, resolveTerminalProvider } = await import("../terminal-provider.ts");
		const settings = await this.#deps.settings().catch(() => null);
		const manifestProvider = await (async () => {
			try {
				const { getSessionState } = await import("../../assembly/index.ts");
				return getSessionState().manifest?.seams.terminal?.provider ?? null;
			} catch {
				return null;
			}
		})();
		const provider = getTerminalProvider(
			resolveTerminalProvider(settings ?? ({ getRaw: () => undefined } as never), manifestProvider),
		);

		// Wrap the provider handle to emit daemon events.
		const handle = await provider.open(realCwd, cols, rows, shell, args, env);
		const entry: TerminalBridge = {
			async write(msg: unknown): Promise<void> {
				const m = msg as { method?: string; params?: Record<string, unknown> };
				if (m.method === "input") handle.write(String(m.params?.data ?? ""));
				else if (m.method === "resize")
					handle.resize(Number(m.params?.cols) || cols, Number(m.params?.rows) || rows);
				else if (m.method === "close") handle.dispose();
			},
			dispose(): void {
				handle.dispose();
			},
		};
		handle.onData(d =>
			this.#deps.emit(conn, {
				kind: "terminal-output",
				seq: this.#deps.nextSeq(),
				payload: { id, data: d },
			}),
		);
		handle.onExit(code => {
			this.#deps.emit(conn, {
				kind: "terminal-exit",
				seq: this.#deps.nextSeq(),
				payload: { id, code: code ?? 0 },
			});
		});
		this.#terminals.set(id, entry);
		return { id };
	}

	/** RPC terminal.input：向指定 pty 写数据（未知 id 抛错，原语义）。 */
	async input(params: { id: string; data?: string }): Promise<{ ok: true }> {
		const p = params ?? ({} as { id: string });
		const bridge = this.#terminals.get(p.id);
		if (!bridge) throw new Error(`Unknown terminal: ${p.id}`);
		await bridge.write({ method: "input", id: p.id, params: { data: p.data ?? "" } });
		return { ok: true };
	}

	/** RPC terminal.resize：改 pty 窗口尺寸（未知 id 抛错，原语义）。 */
	async resize(params: { id: string; cols?: number; rows?: number }): Promise<{ ok: true }> {
		const p = params ?? ({} as { id: string });
		const bridge = this.#terminals.get(p.id);
		if (!bridge) throw new Error(`Unknown terminal: ${p.id}`);
		await bridge.write({ method: "resize", id: p.id, params: { cols: p.cols ?? 100, rows: p.rows ?? 30 } });
		return { ok: true };
	}

	/** RPC terminal.close：关 pty 并清桥接表（未知 id 静默 ok，原语义）。 */
	async close(params: { id: string }): Promise<{ ok: true }> {
		const p = params ?? ({} as { id: string });
		const bridge = this.#terminals.get(p.id);
		if (bridge) {
			await bridge.write({ method: "close", id: p.id, params: {} });
			bridge.dispose();
			this.#terminals.delete(p.id);
		}
		return { ok: true };
	}
}
