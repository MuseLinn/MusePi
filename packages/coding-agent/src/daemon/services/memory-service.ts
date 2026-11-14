/**
 * MemoryService — the memory-backend surface (settings → memory plus the
 * workspace browser).
 *
 * Seam:
 * - Input: `memory.*` routes, the effective settings that pick the backend,
 *   and the live sessions of the current cwd for a per-session clear.
 * - Output: backend status/stats/diagnose text, developer instructions, and the
 *   workspace file list/contents. Files are only ever read by bare name inside
 *   the memory workspace root.
 * - Lifecycle: stateless. Backend state lives in the memory stores; this
 *   service resolves the backend per call.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@musepi/pi-utils";
import type { DaemonSessionHost } from "../session-host";
import type { DaemonService } from "./types";

export class MemoryService implements DaemonService {
	readonly key = "memory";
	readonly routes = {
		"memory.status": "status",
		"memory.view": "view",
		"memory.stats": "stats",
		"memory.diagnose": "diagnose",
		"memory.clear": "clear",
		"memory.enqueue": "enqueue",
		"memory.workspace": "workspace",
		"memory.workspaceRead": "workspaceRead",
		"memory.workspaceReveal": "workspaceReveal",
	} as const;

	constructor(private readonly host: Pick<DaemonSessionHost, "cwd" | "settings" | "allSessions">) {}

	/** Resolve a workspace-memory request to its per-cwd memory directory.
	 *  `slug` must be an existing directory name under the memories root — the
	 *  GUI only ever echoes names this RPC itself handed out, but the check is
	 *  enforced here: no separators, no `..`, must exist. */
	async #workspaceDir(p: { cwd?: unknown; slug?: unknown }): Promise<{
		rootDir: string;
		slug: string;
		dir: string;
	} | null> {
		const settings = this.host.settings();
		if (!settings) return null;
		const { resolveMemoryBackend } = await import("../../memory-backend/resolve");
		const backend = await resolveMemoryBackend(settings);
		const agentDir = getAgentDir();
		const cwd = typeof p.cwd === "string" && p.cwd.length > 0 ? path.resolve(p.cwd) : this.host.cwd();
		const ownDir = backend.workspaceDir?.(agentDir, cwd);
		if (!ownDir) return null;
		const rootDir = path.dirname(ownDir);
		const slug =
			typeof p.slug === "string" &&
			p.slug.startsWith("--") &&
			p.slug.endsWith("--") &&
			!p.slug.includes("..") &&
			fs.existsSync(path.join(rootDir, p.slug))
				? p.slug
				: path.basename(ownDir);
		return { rootDir, slug, dir: path.join(rootDir, slug) };
	}

	async status(params: unknown): Promise<unknown> {
		// TUI /memory status parity:MemoryBackendStatus 结构化输出。
		const settings = this.host.settings();
		if (!settings) throw new Error("settings unavailable");
		const { resolveMemoryBackend } = await import("../../memory-backend/resolve");
		const backend = await resolveMemoryBackend(settings);
		const status = backend.status
			? await backend.status({ agentDir: getAgentDir(), cwd: this.host.cwd() })
			: { backend: backend.id, active: false, writable: false, searchable: false };
		return { id: backend.id, status };
	}

	async view(params: unknown): Promise<unknown> {
		// TUI /memory view parity:developer-instructions markdown。
		const settings = this.host.settings();
		if (!settings) throw new Error("settings unavailable");
		const { resolveMemoryBackend } = await import("../../memory-backend/resolve");
		const backend = await resolveMemoryBackend(settings);
		const text = await backend.buildDeveloperInstructions(getAgentDir(), settings.getCwd(), settings);
		return { text: text ?? "(no instructions)" };
	}

	async stats(params: unknown): Promise<unknown> {
		// TUI /memory stats parity:markdown 统计。
		const settings = this.host.settings();
		if (!settings) throw new Error("settings unavailable");
		const { resolveMemoryBackend } = await import("../../memory-backend/resolve");
		const backend = await resolveMemoryBackend(settings);
		return { text: (await backend.stats?.(getAgentDir(), this.host.cwd())) ?? "(no stats)" };
	}

	async diagnose(params: unknown): Promise<unknown> {
		// TUI /memory diagnose parity:markdown 诊断。
		const settings = this.host.settings();
		if (!settings) throw new Error("settings unavailable");
		const { resolveMemoryBackend } = await import("../../memory-backend/resolve");
		const backend = await resolveMemoryBackend(settings);
		return { text: (await backend.diagnose?.(getAgentDir(), this.host.cwd())) ?? "(no diagnostics)" };
	}

	async clear(params: unknown): Promise<unknown> {
		// TUI /memory clear parity:清空后端持久状态。
		const settings = this.host.settings();
		if (!settings) throw new Error("settings unavailable");
		const { resolveMemoryBackend } = await import("../../memory-backend/resolve");
		const backend = await resolveMemoryBackend(settings);
		const cwd = this.host.cwd();
		// 路由不绑定单会话:对 cwd 匹配本 host 的每个活动会话执行
		// 带 session 的清空(失效其记忆快照缓存)并刷新系统提示;
		// 无活动会话时维持允许的全局清空。
		const affected = [...this.host.allSessions()].filter(live => live.cwd === cwd);
		if (affected.length === 0) {
			await backend.clear(getAgentDir(), cwd);
		} else {
			for (const live of affected) {
				await backend.clear(getAgentDir(), cwd, live.agentSession);
				await live.agentSession.refreshBaseSystemPrompt();
			}
		}
		return { ok: true };
	}

	async enqueue(params: unknown): Promise<unknown> {
		// TUI /memory enqueue parity:立即强制合并/固化。
		const settings = this.host.settings();
		if (!settings) throw new Error("settings unavailable");
		const { resolveMemoryBackend } = await import("../../memory-backend/resolve");
		const backend = await resolveMemoryBackend(settings);
		await backend.enqueue(getAgentDir(), this.host.cwd());
		return { ok: true };
	}

	async workspace(params: unknown): Promise<unknown> {
		// 设置 → 记忆的工作区记忆卡:记忆根下的
		// 各工作区目录 + 选中工作区的 .md 记忆文件列表(mtime 降序)。
		// 目录缺失时列出空集(该工作区还没有记忆产物)。
		const p = (params ?? {}) as { cwd?: unknown; slug?: unknown };
		const workspace = await this.#workspaceDir(p);
		if (!workspace) return { root: "", slug: "", workspaces: [], files: [], supported: false };
		const { rootDir, slug, dir } = workspace;
		const workspaces: string[] = [];
		try {
			for (const e of fs.readdirSync(rootDir, { withFileTypes: true })) {
				if (e.isDirectory() && e.name.startsWith("--") && e.name.endsWith("--")) workspaces.push(e.name);
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		const files: Array<{ name: string; size: number; mtimeMs: number }> = [];
		try {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
				const st = fs.statSync(path.join(dir, e.name));
				files.push({ name: e.name, size: st.size, mtimeMs: st.mtimeMs });
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		files.sort((a, b) => b.mtimeMs - a.mtimeMs);
		return { root: dir, slug, workspaces: workspaces.sort(), files, supported: true };
	}

	async workspaceRead(params: unknown): Promise<unknown> {
		// 读取一个记忆 .md 供面板内查看。name 只接受根内裸文件名,
		// 上限 512KB(面板阅读用,不是编辑器)。
		const p = (params ?? {}) as { cwd?: unknown; slug?: unknown; name?: unknown };
		const workspace = await this.#workspaceDir(p);
		if (!workspace) throw new Error("the active memory backend has no browsable workspace");
		const { dir } = workspace;
		const name = typeof p.name === "string" ? p.name : "";
		if (
			!name ||
			name.includes("/") ||
			name.includes("\\") ||
			name.includes("..") ||
			!name.toLowerCase().endsWith(".md")
		) {
			throw new Error("invalid memory file name");
		}
		const target = path.join(dir, name);
		const st = fs.statSync(target);
		if (!st.isFile()) throw new Error("not a file");
		if (st.size > 512 * 1024) throw new Error("memory file too large to display");
		return { name, content: fs.readFileSync(target, "utf8"), mtimeMs: st.mtimeMs };
	}

	async workspaceReveal(params: unknown): Promise<unknown> {
		// 在文件管理器中显示一个记忆文件(缺省显示工作区记忆目录)。
		// daemon 宿主侧执行 —— 远程 daemon 的 GUI 会在远程机器上打开,
		// 与其它 daemon 侧路径语义一致。
		const p = (params ?? {}) as { cwd?: unknown; slug?: unknown; name?: unknown };
		const workspace = await this.#workspaceDir(p);
		if (!workspace) throw new Error("the active memory backend has no browsable workspace");
		const { dir } = workspace;
		let target = dir;
		if (typeof p.name === "string" && p.name) {
			const name = p.name;
			if (name.includes("/") || name.includes("\\") || name.includes("..") || !name.toLowerCase().endsWith(".md")) {
				throw new Error("invalid memory file name");
			}
			target = path.join(dir, name);
			if (!fs.existsSync(target)) throw new Error(`Unknown memory file: ${name}`);
		}
		if (process.platform === "win32") {
			Bun.spawn(["explorer.exe", `/select,${target}`], { stdout: "ignore", stderr: "ignore" });
		} else if (process.platform === "darwin") {
			Bun.spawn(["open", "-R", target], { stdout: "ignore", stderr: "ignore" });
		} else {
			Bun.spawn(["xdg-open", path.dirname(target)], { stdout: "ignore", stderr: "ignore" });
		}
		return { ok: true };
	}
}
