import { highlightToCodeHtml, ImageLightbox, Markdown, t } from "@musepi/desktop-web";
import {
	ArrowLeft,
	FileCode,
	File as FileIcon,
	FileImage,
	FileJson,
	FilePlus,
	FileText,
	FileType,
	Folder,
	FolderPlus,
	RefreshCw,
	Search,
} from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatHighlight } from "../lib/highlight";
import type { RpcClient } from "../lib/rpc";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

/**
 * Workspace file pane: the daemon's structured workspace.tree scan rendered
 * as an expandable, searchable, virtualized directory browser with inline
 * preview (markdown renders through the shared Markdown component, code
 * files highlight via the tree-sitter bridge, images/PDFs inline) and a
 * right-click menu (preview / open / copy path / new file / new folder /
 * rename / delete-with-confirm / refresh). Writes go through the
 * cwd-scoped fs.* RPCs (fs-ops.ts rejects `..` escapes).
 */
export interface WorkspaceEntry {
	name: string;
	path: string;
	isDir: boolean;
	size: number;
	mtime: number;
	depth: number;
}

interface PreviewState {
	path: string;
	name: string;
	size: number;
	/** text preview content */
	text?: string;
	/** highlighted text preview (tree-sitter spans) */
	html?: string;
	/** live-rendered HTML page (openchamber parity: .html previews render) */
	htmlLive?: string;
	/** blob URL for image preview */
	imageUrl?: string;
	/** rendered PDF pages as data URLs (inline pdf.js preview) */
	pdfPages?: string[];
	error?: string;
	/** preview shown but content opens externally (unsupported binaries) */
	external?: boolean;
}

const TEXT_EXT = new Set([
	"txt",
	"md",
	"ts",
	"tsx",
	"js",
	"jsx",
	"json",
	"toml",
	"yaml",
	"yml",
	"css",
	"html",
	"xml",
	"log",
	"c",
	"h",
	"rs",
	"py",
	"go",
	"sh",
	"zsh",
	"bash",
	"csv",
	"env",
	"gitignore",
	"ini",
	"conf",
]);

/** Extension → tree-sitter language name for the preview highlighter.
 *  Mirrors the transcript diff set (tool-render parts.tsx EXT_HIGHLIGHT_LANG)
 *  so previews and diffs highlight the same languages consistently. */
const EXT_LANG: Record<string, string> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "tsx",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascript",
	json: "json",
	md: "markdown",
	markdown: "markdown",
	toml: "toml",
	yaml: "yaml",
	yml: "yaml",
	css: "css",
	scss: "scss",
	html: "html",
	htm: "html",
	xml: "xml",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	hh: "cpp",
	rs: "rust",
	py: "python",
	pyi: "python",
	rb: "ruby",
	go: "go",
	sh: "bash",
	zsh: "bash",
	bash: "bash",
	java: "java",
	kt: "kotlin",
	kts: "kotlin",
	swift: "swift",
	php: "php",
	sql: "sql",
};

/** Fixed virtual-row height (px); keep in sync with .gui-filepane-vrow CSS. */
const ROW_H = 26;
const ROW_BUFFER = 6;

interface TreeNode {
	entry: WorkspaceEntry;
	children: TreeNode[];
	/** Display label — "a/b" when a single-child dir chain is compressed
	 *  (bitfun lazyCompressFileTree / VS Code path-compression parity). */
	label: string;
}

type Editing =
	| { kind: "new-file"; parentDir: string; depth: number }
	| { kind: "new-dir"; parentDir: string; depth: number }
	| { kind: "rename"; entry: WorkspaceEntry; depth: number };

interface MenuState {
	entry: WorkspaceEntry;
	x: number;
	y: number;
	confirmDelete?: boolean;
}

/** Build the tree from the flat scan: dirs first (parents before children —
 *  listWorkspace is depth-first), then files attached to their parent dir. */
function buildTree(entries: WorkspaceEntry[]): TreeNode[] {
	const dirs = entries.filter(e => e.isDir);
	const files = entries.filter(e => !e.isDir);
	const byPath = new Map<string, TreeNode>();
	const roots: TreeNode[] = [];
	for (const e of dirs) {
		byPath.set(e.path, { entry: e, children: [], label: e.name });
	}
	for (const e of dirs) {
		const node = byPath.get(e.path)!;
		const slash = e.path.lastIndexOf("/");
		const parentPath = slash === -1 ? "" : e.path.slice(0, slash);
		const parent = byPath.get(parentPath);
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	for (const e of files) {
		const slash = e.path.lastIndexOf("/");
		const parentPath = slash === -1 ? "" : e.path.slice(0, slash);
		const node: TreeNode = { entry: e, children: [], label: e.name };
		const parent = byPath.get(parentPath);
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	return roots;
}

function matchesQuery(entry: WorkspaceEntry, query: string): boolean {
	if (!query) return true;
	const q = query.toLowerCase();
	return entry.name.toLowerCase().includes(q) || entry.path.toLowerCase().includes(q);
}

/** Flatten visible rows honoring collapse state + search query. In query
 *  mode, collapse is ignored: the whole tree is walked (cheap — a few
 *  hundred string matches) and every node whose path OR a descendant
 *  matches shows, along with all ancestors of a match. A matching dir
 *  drags its whole subtree in. */
function flattenVisible(
	nodes: TreeNode[],
	collapsed: Set<string>,
	query: string,
): Array<{ node: TreeNode; depth: number }> {
	const out: Array<{ node: TreeNode; depth: number }> = [];
	if (query) {
		const walk = (list: TreeNode[], depth: number, ancestorMatched: boolean): void => {
			for (const node of list) {
				const selfMatch = matchesQuery(node.entry, query);
				const show = selfMatch || ancestorMatched;
				if (show) out.push({ node, depth });
				if (node.entry.isDir) walk(node.children, depth + 1, ancestorMatched || selfMatch);
			}
		};
		walk(nodes, 1, false);
		return out;
	}
	const push = (list: TreeNode[], depth: number): void => {
		for (const node of list) {
			out.push({ node, depth });
			if (node.entry.isDir && !collapsed.has(node.entry.path)) push(node.children, depth + 1);
		}
	};
	push(nodes, 1);
	return out;
}

/** Collapse single-child directory chains into one display row
 *  (bitfun lazyCompressFileTree / VS Code path-compression parity):
 *  a dir with exactly one dir child (that itself has children) merges
 *  their labels into "a/b". The deepest entry.path stays the collapse
 *  key and the target of fs operations; only the label changes. */
function compressTree(nodes: TreeNode[]): TreeNode[] {
	const out: TreeNode[] = [];
	for (const node of nodes) {
		let cur: TreeNode = { ...node, children: compressTree(node.children) };
		while (
			cur.entry.isDir &&
			cur.children.length === 1 &&
			cur.children[0]!.entry.isDir &&
			cur.children[0]!.children.length > 0
		) {
			const child = cur.children[0]!;
			cur = {
				entry: { ...child.entry },
				children: child.children,
				label: `${cur.label}/${child.label}`,
			};
		}
		out.push(cur);
	}
	return out;
}

function extOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Extension-aware file glyph (proma FileTypeIcon parity): code, image,
 *  JSON and text files get a recognizable icon; the rest keep the plain
 *  document glyph. */
function TypeIcon({ name }: { name: string }): ReactElement {
	const ext = extOf(name);
	let IconCmp = FileIcon;
	if (["ts", "tsx", "js", "jsx", "rs", "go", "py", "sh", "css", "html"].includes(ext)) IconCmp = FileCode;
	else if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"].includes(ext)) IconCmp = FileImage;
	else if (ext === "json") IconCmp = FileJson;
	else if (["md", "txt", "toml", "yml", "yaml"].includes(ext)) IconCmp = FileText;
	else if (["ttf", "otf", "woff", "woff2"].includes(ext)) IconCmp = FileType;
	return <IconCmp size={12} className="gui-filepane-icon" />;
}

/** Virtual-row index of the inline editor: renames replace their target
 *  row; new entries sit right after the parent dir's last descendant (or
 *  the parent row itself when it is collapsed). */
function editingIndex(rows: Array<{ node: TreeNode; depth: number }>, editing: Editing): number {
	if (editing.kind === "rename") {
		return rows.findIndex(r => r.node.entry.path === editing.entry.path);
	}
	const parent = editing.parentDir;
	let last = -1;
	for (let i = 0; i < rows.length; i++) {
		const p = rows[i]!.node.entry.path;
		if (p === parent || p.startsWith(`${parent}/`)) last = i;
	}
	return last + 1;
}

export function FilePane({
	rpc,
	cwd,
	openRequest = null,
}: {
	rpc: RpcClient;
	cwd: string;
	/** External reveal (artifact cards / transcript paths): preview this
	 *  path via the same pipeline as a tree click. */
	openRequest?: { path: string; nonce: number } | null;
}): ReactNode {
	const [entries, setEntries] = useState<WorkspaceEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [preview, setPreview] = useState<PreviewState | null>(null);
	const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null);
	/** .html preview: "live" (rendered page) or "source" (highlighted text). */
	const [htmlLiveMode, setHtmlLiveMode] = useState<"live" | "source">("live");
	const [ctx, setCtx] = useState<MenuState | null>(null);
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [query, setQuery] = useState("");
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [editing, setEditing] = useState<Editing | null>(null);
	const [editValue, setEditValue] = useState("");
	const [scrollTop, setScrollTop] = useState(0);
	const [viewH, setViewH] = useState(400);
	const listRef = useRef<HTMLDivElement | null>(null);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const editRef = useRef<HTMLInputElement | null>(null);
	const highlight = useChatHighlight();

	// pdf.js worker: copied next to index.html by the build script
	// (scripts/build copies node_modules/pdfjs-dist/build/pdf.worker.min.mjs
	// into dist/); file:// workers load fine from the same origin.
	useEffect(() => {
		pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", window.location.href).toString();
	}, []);

	const load = useCallback(async (): Promise<void> => {
		setError(null);
		try {
			const res = await rpc.request<{ entries: WorkspaceEntry[] }>("workspace.tree", {
				cwd,
				maxDepth: 4,
				perDirLimit: 80,
			});
			setEntries(res.entries ?? []);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEntries(null);
		}
	}, [rpc, cwd]);

	useEffect(() => {
		void load();
	}, [load]);

	// Track the list viewport height for virtualization.
	useEffect(() => {
		const el = listRef.current;
		if (!el) return;
		const measure = (): void => setViewH(el.clientHeight);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// Focus the inline editor when it mounts.
	useEffect(() => {
		if (editing) editRef.current?.focus();
	}, [editing]);

	// Revoke stale preview blob URLs so large images don't leak memory.
	useEffect(() => {
		return () => {
			if (preview?.imageUrl) URL.revokeObjectURL(preview.imageUrl);
		};
	}, [preview?.imageUrl]);

	const tree = useMemo(() => compressTree(buildTree(entries ?? [])), [entries]);
	const rows = useMemo(() => flattenVisible(tree, collapsed, query.trim()), [tree, collapsed, query]);
	const total = rows.length + (editing ? 1 : 0);
	const start = Math.max(0, Math.floor(scrollTop / ROW_H) - ROW_BUFFER);
	const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + ROW_BUFFER);
	const editIndex = editing ? editingIndex(rows, editing) : -1;

	const openPreview = useCallback(
		async (entry: WorkspaceEntry): Promise<void> => {
			if (entry.isDir) return;
			setSelectedPath(entry.path);
			// workspace.tree paths are relative to the session cwd; external
			// reveals (artifact cards) may carry absolute paths — don't join.
			const absPath = entry.path.startsWith("/") ? entry.path : `${cwd}/${entry.path}`;
			try {
				const res = await rpc.request<{ base64?: string; size?: number; mime?: string; error?: string }>(
					"fs.readBytes",
					{ path: absPath },
				);
				if (res.error || !res.base64) {
					setPreview({ path: absPath, name: entry.name, size: entry.size, error: res.error ?? "read failed" });
					return;
				}
				const bytes = Uint8Array.from(atob(res.base64), c => c.charCodeAt(0));
				const isText =
					(res.mime?.startsWith("text/") ?? false) ||
					(TEXT_EXT.has(extOf(entry.name)) && !bytes.subarray(0, 4096).includes(0));
				if (isText) {
					const text = new TextDecoder().decode(bytes);
					// HTML pages render live in a sandboxed iframe (openchamber
					// parity) — the preview IS the page, not its source.
					const ext = extOf(entry.name);
					if (ext === "html" || ext === "htm") {
						setHtmlLiveMode("live");
						setPreview({ path: absPath, name: entry.name, size: res.size ?? bytes.length, htmlLive: text });
						return;
					}
					// Markdown previews render through the shared component;
					// other text files highlight via the tree-sitter bridge.
					const lang = EXT_LANG[ext];
					if (lang && ext !== "md" && highlight) {
						try {
							const hl = await highlight(text, lang);
							if (hl) {
								setPreview({
									path: absPath,
									name: entry.name,
									size: res.size ?? bytes.length,
									html: highlightToCodeHtml(hl),
								});
								return;
							}
						} catch {
							// fall through to plain text
						}
					}
					setPreview({ path: absPath, name: entry.name, size: res.size ?? bytes.length, text });
					return;
				}
				if (res.mime?.startsWith("image/")) {
					const url = URL.createObjectURL(new Blob([bytes], { type: res.mime }));
					setPreview({ path: absPath, name: entry.name, size: res.size ?? bytes.length, imageUrl: url });
					return;
				}
				if (res.mime === "application/pdf") {
					// Inline PDF preview via pdf.js (VS Code-style): render every
					// page to a canvas → data URL. Falls back to the OS default
					// app when rendering fails (corrupt/encrypted PDFs).
					try {
						const doc = await pdfjs.getDocument({ data: bytes }).promise;
						const pages: string[] = [];
						for (let i = 1; i <= doc.numPages; i++) {
							const page = await doc.getPage(i);
							const viewport = page.getViewport({ scale: 1.5 });
							const canvas = document.createElement("canvas");
							canvas.width = Math.ceil(viewport.width);
							canvas.height = Math.ceil(viewport.height);
							const pctx = canvas.getContext("2d");
							if (!pctx) throw new Error("canvas unavailable");
							await page.render({ canvas, canvasContext: pctx, viewport }).promise;
							pages.push(canvas.toDataURL("image/png"));
						}
						setPreview({ path: absPath, name: entry.name, size: res.size ?? bytes.length, pdfPages: pages });
						return;
					} catch {
						// fall through to system default app
					}
				}
				// Other binaries: open in the system default app.
				await window.electronAPI?.openWith("", absPath);
				setPreview({ path: absPath, name: entry.name, size: res.size ?? bytes.length, external: true });
			} catch (err) {
				setPreview({
					path: absPath,
					name: entry.name,
					size: entry.size,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[rpc, cwd, highlight],
	);

	// Scroll the inline editor into the virtual window (it may sit outside
	// the visible slice otherwise and never mount). Declared after `rows`.
	useEffect(() => {
		if (!editing) return;
		const idx = editingIndex(rows, editing);
		const list = listRef.current;
		if (list && idx >= 0) {
			list.scrollTop = Math.max(0, Math.min(idx * ROW_H, list.scrollHeight - list.clientHeight));
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editing, rows]);

	// External reveal (artifact cards / transcript path clicks): preview
	// via the same pipeline as a tree click. The path is absolute; the
	// preview joins cwd + entry.path, so relativize when inside cwd.
	useEffect(() => {
		if (!openRequest) return;
		const abs = openRequest.path;
		const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
		const rel = abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
		const name = rel.slice(Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\")) + 1);
		void openPreview({ path: rel, name, size: 0, isDir: false, mtime: 0, depth: 0 });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [openRequest, openPreview, cwd.endsWith, cwd]);

	const toggleDir = useCallback((path: string): void => {
		setCollapsed(prev => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}, []);

	const copyPath = useCallback(
		async (entry: WorkspaceEntry): Promise<void> => {
			try {
				await window.electronAPI?.copyText(`${cwd}/${entry.path}`);
			} catch {
				// clipboard unavailable — nothing to do
			}
		},
		[cwd],
	);

	const startNewFile = useCallback((parentDir: string, depth: number): void => {
		setEditing({ kind: "new-file", parentDir, depth });
		setEditValue("");
	}, []);

	const startNewDir = useCallback((parentDir: string, depth: number): void => {
		setEditing({ kind: "new-dir", parentDir, depth });
		setEditValue("");
	}, []);

	const startRename = useCallback((entry: WorkspaceEntry, depth: number): void => {
		setEditing({ kind: "rename", entry, depth });
		setEditValue(entry.name);
	}, []);

	const commitEdit = useCallback(async (): Promise<void> => {
		if (!editing) return;
		const name = editValue.trim();
		if (!name || name.includes("/") || name === "." || name === "..") {
			setEditing(null);
			return;
		}
		const target = editing.kind === "rename" ? editing.entry : null;
		if (target && name === target.name) {
			setEditing(null);
			return;
		}
		const parentDir =
			editing.kind === "rename"
				? target!.path.includes("/")
					? target!.path.slice(0, target!.path.lastIndexOf("/"))
					: ""
				: editing.parentDir;
		const rel = parentDir ? `${parentDir}/${name}` : name;
		setEditing(null);
		try {
			if (editing.kind === "new-file") await rpc.request("fs.write", { cwd, path: rel, content: "" });
			else if (editing.kind === "new-dir") await rpc.request("fs.mkdir", { cwd, path: rel });
			else await rpc.request("fs.rename", { cwd, from: target!.path, to: rel });
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [editing, editValue, rpc, cwd, load]);

	const confirmDelete = useCallback(async (): Promise<void> => {
		const target = ctx?.entry;
		if (!target) return;
		setCtx(null);
		try {
			await rpc.request("fs.delete", { cwd, path: target.path });
			setSelectedPath(cur => (cur === target.path ? null : cur));
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [ctx, rpc, cwd, load]);

	const menuItems = useMemo(() => {
		if (!ctx) return [];
		const { entry } = ctx;
		const depth = entry.depth;
		const parentDir = entry.isDir
			? entry.path
			: entry.path.includes("/")
				? entry.path.slice(0, entry.path.lastIndexOf("/"))
				: "";
		const parentDepth = entry.isDir ? depth : Math.max(1, depth - 1);
		const items: ContextMenuItem[] = [];
		items.push({
			label: t("new file"),
			icon: "file-add",
			onSelect: () => startNewFile(parentDir, parentDepth + (entry.isDir ? 1 : 1)),
		});
		items.push({
			label: t("new folder"),
			icon: "folder-add",
			onSelect: () => startNewDir(parentDir, parentDepth + (entry.isDir ? 1 : 1)),
		});
		items.push({ divider: true });
		if (!entry.isDir) {
			items.push({ label: t("open preview"), icon: "eye", onSelect: () => void openPreview(entry) });
			items.push({
				label: t("open with app"),
				icon: "external-link",
				onSelect: () => void window.electronAPI?.openWith("", `${cwd}/${entry.path}`),
			});
		}
		items.push({ label: t("rename"), icon: "pencil", onSelect: () => startRename(entry, depth) });
		items.push({ label: t("copy path"), icon: "clipboard", onSelect: () => void copyPath(entry) });
		items.push({ divider: true });
		items.push({
			label: ctx.confirmDelete ? t("confirm delete?") : t("delete"),
			icon: "delete-bin",
			danger: true,
			onSelect: () => {
				if (ctx.confirmDelete) void confirmDelete();
				else setCtx({ ...ctx, confirmDelete: true });
			},
		});
		items.push({ label: t("refresh"), icon: "refresh", onSelect: () => void load() });
		return items;
	}, [ctx, openPreview, copyPath, load, startNewFile, startNewDir, startRename, confirmDelete, cwd]);

	const renderRow = (row: { node: TreeNode; depth: number }, posInSet?: number, setSize?: number): ReactNode => {
		const { node, depth } = row;
		const { entry } = node;
		const isDir = entry.isDir;
		const closed = isDir && collapsed.has(entry.path);
		const selected = selectedPath === entry.path;
		const indent = (depth - 1) * 14;
		if (isDir) {
			return (
				<li
					key={entry.path}
					className="gui-filepane-vrow gui-filepane-dir"
					style={{ paddingLeft: indent }}
					role="treeitem"
					aria-level={depth}
					aria-posinset={posInSet}
					aria-setsize={setSize}
					aria-expanded={!closed}
				>
					<button
						type="button"
						className="gui-filepane-dir-btn"
						onClick={() => toggleDir(entry.path)}
						onContextMenu={ev => {
							ev.preventDefault();
							setCtx({ entry, x: ev.clientX, y: ev.clientY });
						}}
					>
						<span className={`gui-filepane-caret${closed ? " gui-filepane-caret--closed" : ""}`}>▾</span>
						<Folder size={12} className="gui-filepane-icon" />
						<span className="gui-filepane-name" title={entry.path}>
							{node.label}
						</span>
					</button>
				</li>
			);
		}
		return (
			<li
				key={entry.path}
				className={`gui-filepane-vrow${selected ? " gui-filepane-selected" : ""}${
					!isDir && Date.now() - entry.mtime < 60_000 ? " gui-filepane-recent" : ""
				}`}
				style={{ paddingLeft: indent }}
				role="treeitem"
				aria-level={depth}
				aria-posinset={posInSet}
				aria-setsize={setSize}
			>
				<button
					type="button"
					className="gui-filepane-file-btn"
					onClick={() => void openPreview(entry)}
					onContextMenu={ev => {
						ev.preventDefault();
						setCtx({ entry, x: ev.clientX, y: ev.clientY });
					}}
				>
					<TypeIcon name={entry.name} />
					<span
						className={`gui-filepane-name${entry.name === "AGENTS.md" ? " gui-filepane-agents" : ""}`}
						title={entry.path}
					>
						{node.label}
					</span>
				</button>
			</li>
		);
	};

	const editingRow = editing ? (
		<li
			key="editing"
			className="gui-filepane-vrow gui-filepane-editing"
			style={{ paddingLeft: (editing.depth - 1) * 14 }}
		>
			{editing.kind === "rename" ? <FileIcon size={12} className="gui-filepane-icon" /> : null}
			<input
				ref={editRef}
				className="gui-filepane-edit-input"
				value={editValue}
				placeholder={editing.kind === "new-dir" ? t("new folder") : t("new file")}
				onChange={ev => setEditValue(ev.target.value)}
				onKeyDown={ev => {
					if (ev.key === "Enter") void commitEdit();
					else if (ev.key === "Escape") setEditing(null);
				}}
				onBlur={() => setEditing(null)}
				spellCheck={false}
			/>
		</li>
	) : null;

	return (
		<div className="gui-filepane">
			<div className="gui-filepane-head">
				<span className="gui-sidebar-title">{t("Files")}</span>
				<div className="gui-filepane-actions">
					<button
						className="gui-btn gui-btn-icon"
						type="button"
						title={t("new file")}
						onClick={() => startNewFile("", 1)}
					>
						<FilePlus size={12} />
					</button>
					<button
						className="gui-btn gui-btn-icon"
						type="button"
						title={t("new folder")}
						onClick={() => startNewDir("", 1)}
					>
						<FolderPlus size={12} />
					</button>
					<label className="gui-filepane-search" title={t("search files")}>
						<Search size={12} className="gui-filepane-search-icon" />
						<input
							type="text"
							value={query}
							placeholder={t("search")}
							onChange={ev => {
								setQuery(ev.target.value);
								setScrollTop(0);
							}}
							spellCheck={false}
						/>
					</label>
					<button className="gui-btn gui-btn-icon" type="button" onClick={() => void load()} title={t("refresh")}>
						<RefreshCw size={12} />
					</button>
				</div>
			</div>
			{/* Working-dir breadcrumb (proma/openchamber toolbar parity). */}
			<div className="gui-filepane-path" title={cwd}>
				<span className="gui-filepane-path-root">~/</span>
				<span className="truncate">{cwd.replace(/^\/Users\/[^/]+\//, "")}</span>
			</div>
			{error && <p className="gui-error">{error}</p>}
			{!entries && !error && <p className="gui-filepane-empty">{t("loading…")}</p>}
			<div className="gui-filepane-body" ref={bodyRef}>
				{entries && !preview && (
					<div
						className="gui-filepane-list"
						ref={listRef}
						onScroll={ev => setScrollTop(ev.currentTarget.scrollTop)}
						role="tree"
					>
						<div className="gui-filepane-spacer" style={{ height: total * ROW_H }}>
							<div style={{ transform: `translateY(${start * ROW_H}px)` }}>
								{Array.from({ length: end - start }, (_, k) => {
									const i = start + k;
									if (editing && i === editIndex) return editingRow;
									return i < rows.length ? renderRow(rows[i]!, i + 1, rows.length) : null;
								})}
							</div>
						</div>
					</div>
				)}
				{preview && (
					<div className="gui-filepane-preview">
						<div className="gui-filepane-preview-head">
							<button
								type="button"
								className="gui-btn gui-btn-icon"
								title={t("back to files")}
								onClick={() => setPreview(null)}
							>
								<ArrowLeft size={12} />
							</button>
							<span className="gui-filepane-preview-name" title={preview.path}>
								{preview.name}
							</span>
							<button
								type="button"
								className="gui-btn gui-btn-icon"
								title={t("close")}
								onClick={() => setPreview(null)}
							>
								✕
							</button>
						</div>
						<div className="gui-filepane-preview-body">
							{preview.error && <p className="gui-error">{preview.error}</p>}
							{preview.htmlLive !== undefined && (
								<HtmlPreview
									live={htmlLiveMode === "live"}
									source={preview.htmlLive}
									onToggle={setHtmlLiveMode}
								/>
							)}
							{preview.html !== undefined && (
								<pre className="gui-filepane-preview-text" dangerouslySetInnerHTML={{ __html: preview.html }} />
							)}
							{preview.text !== undefined && extOf(preview.name) === "md" ? (
								<div className="gui-filepane-preview-md">
									<Markdown text={preview.text} basePath={cwd} />
								</div>
							) : preview.text !== undefined ? (
								<pre className="gui-filepane-preview-text">{preview.text}</pre>
							) : null}
							{preview.imageUrl && (
								<div className="gui-filepane-preview-img-wrap">
									<button
										type="button"
										className="gui-filepane-preview-img-btn"
										title={t("open image viewer")}
										onClick={() => setLightbox({ src: preview.imageUrl!, name: preview.name })}
									>
										<img className="gui-filepane-preview-img" src={preview.imageUrl} alt={preview.name} />
									</button>
								</div>
							)}
							{preview.pdfPages && (
								<div className="gui-filepane-preview-img-wrap">
									{preview.pdfPages.map((page, i) => (
										<img
											key={i}
											className="gui-filepane-preview-img gui-filepane-preview-pdf"
											src={page}
											alt={`${preview.name} p${i + 1}`}
										/>
									))}
								</div>
							)}
							{preview.external && (
								<p className="gui-filepane-preview-note">
									{t("opened in default app")} — {preview.size.toLocaleString()} B
								</p>
							)}
						</div>
					</div>
				)}
			</div>
			<ContextMenu
				open={ctx !== null}
				x={ctx?.x ?? 0}
				y={ctx?.y ?? 0}
				items={menuItems}
				onClose={() => setCtx(null)}
			/>
			<ImageLightbox
				items={lightbox ? [{ src: lightbox.src, alt: lightbox.name }] : []}
				index={lightbox ? 0 : null}
				onClose={() => setLightbox(null)}
				onIndexChange={() => {}}
			/>
		</div>
	);
}

/** HTML file preview: live page in a sandboxed iframe (openchamber
 *  parity) with a preview/source toggle. */
function HtmlPreview({
	live,
	source,
	onToggle,
}: {
	live: boolean;
	source: string;
	onToggle(mode: "live" | "source"): void;
}): ReactNode {
	return (
		<div className="gui-filepane-preview-html">
			<div className="gui-filepane-preview-html-bar">
				<button
					type="button"
					className={`gui-seg-btn${live ? " gui-seg-btn--active" : ""}`}
					onClick={() => onToggle("live")}
				>
					{t("page preview")}
				</button>
				<button
					type="button"
					className={`gui-seg-btn${live ? "" : " gui-seg-btn--active"}`}
					onClick={() => onToggle("source")}
				>
					{t("source code")}
				</button>
			</div>
			{live ? (
				<iframe
					className="gui-filepane-preview-html-frame"
					title={t("preview")}
					sandbox="allow-scripts"
					srcDoc={source}
				/>
			) : (
				<pre className="gui-filepane-preview-text">{source}</pre>
			)}
		</div>
	);
}
