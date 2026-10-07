import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileType, type GlobMatch, listWorkspace } from "@musepi/pi-natives";
import type { FileIndexService } from "../../file-index";
import type { FsOpResult } from "../fs-ops";
import {
	createWorkspaceDir,
	deleteWorkspaceEntry,
	renameWorkspaceEntry,
	resolveInCwd,
	writeWorkspaceFile,
} from "../fs-ops";
import type { DaemonService } from "./types";

/**
 * FileService — 工作区文件面（L2 宿主服务，P1 抽取）。
 *
 * 能力缝声明（M2-2.4）：
 * - 输入：RPC `fs.read` / `fs.readBytes` / `fs.write` / `fs.mkdir` /
 *   `fs.rename` / `fs.delete`（GUI 文件面板 + 附件）、`fs.stat`（只读存在性
 *   探测，侧栏项目列表幽灵清理）、`workspace.tree`
 *   （结构化工作区树）、`index.search`（工作区文件内容索引）。
 * - 输出：全部为软错误约定（`{ error }` / `{ content: null }`），与
 *   git.* 一致，不抛进 JSON-RPC；workspace.tree 返回扁平 entries +
 *   truncated 标记。读写边界由 fs-ops 模块强制（相对路径、`..` 逃逸拒绝）。
 * - 生命周期：无自有状态。FileIndexService 实例仍归 DaemonSessionHost
 *  （懒创建、进程级单例），本服务经 ensureFileIndex 句柄访问。
 *
 * 已知差距：分页文本流与文件系统变更 feed 尚未实现——列入 M2 增强候选。
 * 本次只搬移不改行为：readBytes 已覆盖二进制预览
 * （8MiB 软帽 / 32MiB 硬帽）。
 *
 */
export interface FileServiceDeps {
	/** workspace.tree 根目录兜底（host #options.cwd，未设置时 homedir）。 */
	fallbackCwd(): string | undefined;
	/** 懒创建工作区文件索引（实例归属宿主，P1 不搬）。 */
	ensureFileIndex(): FileIndexService;
}

const FILE_MIME: Record<string, string> = {
	txt: "text/plain",
	md: "text/markdown",
	json: "application/json",
	js: "text/javascript",
	mjs: "text/javascript",
	cjs: "text/javascript",
	ts: "text/plain",
	tsx: "text/plain",
	jsx: "text/plain",
	html: "text/html",
	css: "text/css",
	scss: "text/plain",
	less: "text/plain",
	xml: "application/xml",
	yaml: "text/yaml",
	yml: "text/yaml",
	toml: "text/plain",
	py: "text/x-python",
	rs: "text/plain",
	go: "text/plain",
	java: "text/plain",
	c: "text/plain",
	cpp: "text/plain",
	h: "text/plain",
	sh: "application/x-sh",
	bash: "application/x-sh",
	zsh: "application/x-sh",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	ico: "image/x-icon",
	avif: "image/avif",
	pdf: "application/pdf",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	mp4: "video/mp4",
	webm: "video/webm",
};

function mimeForPath(filePath: string): string {
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return "application/octet-stream";
	const ext = filePath.slice(dot + 1).toLowerCase();
	return FILE_MIME[ext] ?? "application/octet-stream";
}

export class FileService implements DaemonService {
	readonly key = "files";
	readonly routes = {
		"fs.delete": "deleteEntry",
		"fs.mkdir": "mkdir",
		"fs.read": "read",
		"fs.readBytes": "readBytes",
		"fs.rename": "rename",
		"fs.stat": "stat",
		"fs.write": "write",
		"workspace.tree": "tree",
		"index.search": "searchIndex",
	} as const;

	readonly #deps: FileServiceDeps;

	constructor(deps: FileServiceDeps) {
		this.#deps = deps;
	}

	/** RPC fs.read：最小安全文件读取（dev-server 探测）——仅文本文件、
	 *  512 KiB 上限；任何不满足返回 `{ content: null }` 而非抛错。 */
	read(params: { path?: string }): { content: string | null } {
		const p = params ?? {};
		if (!p.path) return { content: null };
		try {
			const st = fs.statSync(p.path);
			if (!st.isFile() || st.size > 512 * 1024) return { content: null };
			return { content: fs.readFileSync(p.path, "utf8") };
		} catch {
			return { content: null };
		}
	}

	/** RPC fs.readBytes：GUI 文件预览的二进制安全读取（base64 + mime +
	 *  size）。8 MiB 默认帽、32 MiB 硬帽——预览面向小文件，大文件走 OS
	 *  打开。 */
	readBytes(params: { path?: string; maxBytes?: number }): Record<string, unknown> {
		const p = params ?? {};
		if (!p.path) return { error: "missing path" };
		try {
			const st = fs.statSync(p.path);
			if (!st.isFile()) return { error: "not a file" };
			const max = Math.min(Math.max(p.maxBytes ?? 8 * 1024 * 1024, 1), 32 * 1024 * 1024);
			if (st.size > max) return { error: `file too large (${st.size} bytes)` };
			const buf = fs.readFileSync(p.path);
			return { base64: buf.toString("base64"), size: buf.length, mime: mimeForPath(p.path) };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** RPC fs.write：在会话工作区内新建/覆写文件（仅相对路径，`..` 逃逸
	 *  拒绝）。支撑 GUI 文件面板的新建文件与 composer 文件附件；UTF-8 文本，
	 *  或 encoding:"base64" 时解码字节（PDF 不能以 base64 文本落盘）。 */
	write(params: { cwd?: string; path?: string; content?: string; encoding?: string }): FsOpResult | { error: string } {
		const p = params ?? {};
		if (!p.cwd || !p.path) return { error: "missing cwd/path" };
		return writeWorkspaceFile(p.cwd, p.path, p.content ?? "", p.encoding);
	}

	mkdir(params: { cwd?: string; path?: string }): FsOpResult | { error: string } {
		const p = params ?? {};
		if (!p.cwd || !p.path) return { error: "missing cwd/path" };
		return createWorkspaceDir(p.cwd, p.path);
	}

	/** RPC fs.stat：只读存在性探测（侧栏项目列表的幽灵目录清理用）——
	 *  任何错误（不存在 / 无权限 / 参数缺失）一律归一为 exists:false，
	 *  绝不抛错；调用方据 exists 过滤列表，探测本身无副作用。 */
	stat(params: { path?: string }): { exists: boolean; isDirectory: boolean } {
		const p = params ?? {};
		if (!p.path) return { exists: false, isDirectory: false };
		try {
			const st = fs.statSync(p.path);
			return { exists: true, isDirectory: st.isDirectory() };
		} catch {
			return { exists: false, isDirectory: false };
		}
	}

	rename(params: { cwd?: string; from?: string; to?: string }): FsOpResult | { error: string } {
		const p = params ?? {};
		if (!p.cwd || !p.from || !p.to) return { error: "missing cwd/from/to" };
		return renameWorkspaceEntry(p.cwd, p.from, p.to);
	}

	/** RPC fs.delete：删除工作区条目（文件或目录树）。GUI 仅在显式确认
	 *  对话框后发送。 */
	deleteEntry(params: { cwd?: string; path?: string }): FsOpResult | { error: string } {
		const p = params ?? {};
		if (!p.cwd || !p.path) return { error: "missing cwd/path" };
		return deleteWorkspaceEntry(p.cwd, p.path);
	}

	/**
	 * RPC workspace.tree：结构化工作区树（文件面板）——native 单遍扫描 +
	 * 每目录帽（超帽时保留最新 + 最旧，与 TUI 同策略）。`gitignore: false`
	 * 连 .gitignore 内的路径也列出（Files 面板开关）；缺省过滤。
	 *
	 * `root`（M1.12 target picker）把扫描起点缩到 cwd 内的一个子目录——
	 * 标签「+」选目录后，tab 的浏览根就是它而非整个工作区。扫描返回的
	 * entries 路径**仍相对 cwd**（带子根前缀），FilePane 的预览/外显对账
	 * 等逻辑不需要第二条路径规则。越出 cwd 的 root 拒绝为空树，与 fs 面板
	 * 其余部位的越界契约一致（不抛进 JSON-RPC）。
	 */
	async tree(params: {
		cwd?: string;
		maxDepth?: number;
		perDirLimit?: number | null;
		gitignore?: boolean;
		root?: string;
	}): Promise<{
		rootPath: string;
		truncated: boolean;
		entries: Array<{ name: string; path: string; isDir: boolean; size: number; mtime: number; depth: number }>;
	}> {
		const p = params ?? {};
		const rootPath = path.resolve(p.cwd || this.#deps.fallbackCwd() || os.homedir());
		const maxDepth = p.maxDepth ?? 2;
		const perDirLimit = p.perDirLimit ?? 50;
		// The sub-root: a cwd-relative directory the scan starts from. Depth
		// budget stays as asked — a narrower root with the same depth reaches
		// proportionally deeper content, which is the point of picking one.
		let scanRoot = rootPath;
		const relRoot = p.root?.trim().replace(/\\/g, "/") ?? "";
		const subRoot = relRoot === "" || relRoot === "." ? "" : relRoot.replace(/\/+$/, "");
		if (subRoot !== "") {
			const resolved = resolveInCwd(rootPath, subRoot);
			if (resolved === null) return { rootPath, truncated: false, entries: [] };
			scanRoot = resolved;
		}
		let result: { entries: readonly GlobMatch[]; truncated: boolean };
		try {
			const scan = await listWorkspace({
				path: scanRoot,
				maxDepth,
				hidden: true,
				gitignore: p.gitignore ?? true,
			});
			result = { entries: scan.entries, truncated: scan.truncated };
		} catch {
			// Native scan unavailable (e.g. missing binary) — empty tree.
			result = { entries: [], truncated: false };
		}
		// Per-directory cap: sort by mtime desc, keep recent + oldest (same
		// strategy as the TUI: limit-1 newest + the single oldest).
		const byParent = new Map<string, Array<{ name: string; entry: GlobMatch; parentPath: string }>>();
		const entries: Array<{ name: string; path: string; isDir: boolean; size: number; mtime: number; depth: number }> =
			[];
		for (const entry of result.entries) {
			// Scan paths are relative to `scanRoot`; re-root them onto cwd so every
			// consumer below keeps one path rule.
			const relToCwd = subRoot === "" ? entry.path : `${subRoot}/${entry.path}`;
			const slash = relToCwd.lastIndexOf("/");
			const name = slash === -1 ? relToCwd : relToCwd.slice(slash + 1);
			const parentPath = slash === -1 ? "" : relToCwd.slice(0, slash);
			const bucket = byParent.get(parentPath) ?? [];
			bucket.push({ name, entry, parentPath });
			byParent.set(parentPath, bucket);
		}
		let truncated = result.truncated;
		for (const [parentPath, bucket] of byParent) {
			if (perDirLimit !== null && bucket.length > perDirLimit) {
				bucket.sort((a, b) => (b.entry.mtime ?? 0) - (a.entry.mtime ?? 0));
				const keep =
					perDirLimit <= 1
						? bucket.slice(0, Math.max(0, perDirLimit))
						: [...bucket.slice(0, perDirLimit - 1), bucket.at(-1)!];
				byParent.set(
					parentPath,
					keep.map(k => ({ name: k.name, entry: k.entry, parentPath })),
				);
				truncated = true;
			}
		}
		for (const [parentPath, bucket] of byParent) {
			for (const item of bucket) {
				entries.push({
					name: item.name,
					path: parentPath ? `${parentPath}/${item.name}` : item.name,
					isDir: item.entry.fileType === FileType.Dir,
					size: item.entry.size ?? 0,
					mtime: item.entry.mtime ?? 0,
					depth: parentPath ? parentPath.split("/").length + 1 : 1,
				});
			}
		}
		entries.sort((a, b) => a.path.localeCompare(b.path));
		return { rootPath, truncated, entries };
	}

	/** RPC index.search：工作区文件内容索引（设置 → 索引库 → 代码库）。
	 *  索引进程级单例仍归宿主（懒创建），本服务经句柄查询。 */
	searchIndex(params: { query?: string; limit?: number }): unknown {
		const p = params ?? {};
		return this.#deps.ensureFileIndex().search(p.query ?? "", p.limit ?? 30);
	}
}
