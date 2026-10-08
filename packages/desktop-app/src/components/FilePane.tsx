import { highlightToCodeHtml, ImageLightbox, Markdown, Segmented, type SegmentedOption, t } from "@musepi/client-core";
import { renderAsync as renderDocx } from "docx-preview";
import {
	ArrowLeft,
	ClipboardCopy,
	ExternalLink,
	Eye,
	EyeOff,
	FileCode,
	File as FileIcon,
	FileImage,
	FileJson,
	FilePlus,
	FileSpreadsheet,
	FileText,
	FileType,
	Folder,
	FolderPlus,
	Pencil,
	Presentation,
	Quote,
	RefreshCw,
	Save,
	ScanEye,
	Search,
} from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { owningArtifact, useArtifactIndex } from "../lib/artifact-index";
// Import order below is alphabetical by module path (biome).
import { type BuiltinViewerDeps, builtinFileViewers } from "../lib/builtin-file-viewers";
import { listFileViewers, orderViewers, renderWithViewerList } from "../lib/file-viewers";
import {
	onGitPrefsChanged,
	readShowHidden,
	readShowIgnored,
	writeShowHidden,
	writeShowIgnored,
} from "../lib/git-prefs";
import { useChatHighlight } from "../lib/highlight";
import { previewMappingFor } from "../lib/preview-from-viewer";
import { useConfirm } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

/** Markdown preview switch: rendered markdown vs the raw source text. */
const MD_VIEW_SEGMENTS: SegmentedOption<"rendered" | "source">[] = [
	{ value: "rendered", label: t("rendered view") },
	{ value: "source", label: t("source code") },
];

/** HTML preview switch: live iframe vs the raw source text. */
const HTML_VIEW_SEGMENTS: SegmentedOption<"live" | "source">[] = [
	{ value: "live", label: t("page preview") },
	{ value: "source", label: t("source code") },
];

/**
 * Inline PDF preview via pdf.js (VS Code-style): render every page to a canvas
 * → data URL. Throws on a corrupt/encrypted PDF; the pdf viewer turns that into
 * a decline, which the pane reads as "open in the system default app".
 */
async function renderPdfPagesToDataUrls(bytes: Uint8Array): Promise<string[]> {
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
	return pages;
}

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
	/** decoded source kept for the inline editor (same bytes as text/htmlLive) */
	raw?: string;
	/** highlighted text preview (tree-sitter spans) */
	html?: string;
	/** live-rendered HTML page (openchamber parity: .html previews render) */
	htmlLive?: string;
	/** blob URL for image preview */
	imageUrl?: string;
	/** rendered PDF pages as data URLs (inline pdf.js preview). Readonly: the
	 *  viewer produces them frozen and the pane only maps over them. */
	pdfPages?: readonly string[];
	/** docx bytes for the docx-preview renderer */
	docxBytes?: ArrayBuffer;
	/** xlsx/xls/csv sheets rendered to standalone HTML tables. Readonly: the
	 *  sheet builder's output is handed to the pane to render, never edited. */
	officeSheets?: ReadonlyArray<{ name: string; html: string; truncated: boolean }>;
	error?: string;
	/** preview shown but content opens externally (unsupported binaries) */
	external?: boolean;
	/** The workspace artifact this file belongs to, when its directory carries
	 *  a valid `artifact.manifest.json` (M3-3.4). Undefined for plain files —
	 *  most of the tree is not an artifact, and the badge's absence is the
	 *  ordinary case. */
	artifact?: { kind: string; renderer: string; exports?: string[]; errors?: string[] };
}

/** Files above this size open view-only — a textarea holding megabytes drags
 *  the whole panel down, and saving them through fs.write is not what the
 *  inline editor is for. */
const EDIT_MAX_BYTES = 2 * 1024 * 1024;
/** sheet_to_html truncation point per sheet (parse-time sheetRows cap). */
const OFFICE_SHEET_ROWS = 1000;

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

/** A minimal entry for a tab whose file is not in the current scan — restored
 *  from a previous session, hidden by the gitignored filter, or deleted.
 *  openPreview only needs path/name/isDir to fetch content; the scan-derived
 *  fields are zeroed and never rendered for this path. */
function syntheticEntry(path: string): WorkspaceEntry {
	return { path, name: path.split("/").pop() ?? path, isDir: false, size: 0, mtime: 0, depth: 0 };
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

/** Every directory path in the tree — the seed for the collapsed-by-default
 *  view. Collected from the compressed tree so the keys match what
 *  `flattenVisible` tests. */
function collectDirPaths(nodes: TreeNode[], out: Set<string> = new Set()): Set<string> {
	for (const node of nodes) {
		if (!node.entry.isDir) continue;
		out.add(node.entry.path);
		collectDirPaths(node.children, out);
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
	else if (["xlsx", "xls", "csv"].includes(ext)) IconCmp = FileSpreadsheet;
	else if (["docx", "doc"].includes(ext)) IconCmp = FileText;
	else if (["pptx", "ppt"].includes(ext)) IconCmp = Presentation;
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
	activeFile = null,
	browseRoot = null,
	onOpenFile,
	onDirty,
	onShowTree,
}: {
	rpc: RpcClient;
	cwd: string;
	/** External reveal (artifact cards / transcript paths): preview this
	 *  path via the same pipeline as a tree click. */
	openRequest?: { path: string; nonce: number } | null;
	/** Tab-primary model (docs §3.3.2): file instances live in the PANEL
	 *  strip. The pane loads whatever file tab the panel activated. */
	activeFile?: string | null;
	/** Workspace-relative directory this instance browses (M1.12 target
	 *  picker). `null`/absent means the whole workspace. Distinct from
	 *  `activeFile`, which addresses a file to preview — one tab is a directory
	 *  to browse or a file to preview, never both. */
	browseRoot?: string | null;
	/** Tree clicks / previews register back into the panel strip. */
	onOpenFile?: (path: string, name: string) => void;
	/** Inline-editor dirty state for the given tree path, mirrored onto the
	 *  panel tab (dot + close guard). Reported with the same path the pane
	 *  passed to onOpenFile, so the strip can find its tab. */
	onDirty?: (path: string, dirty: boolean) => void;
	/** Panel-level file instances split the tree and the preview into two
	 *  tabs: the preview's back button shows the tree tab instead of
	 *  unmounting its own preview (dsh tree/preview tab parity). */
	onShowTree?: () => void;
}): ReactNode {
	const [entries, setEntries] = useState<WorkspaceEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [preview, setPreview] = useState<PreviewState | null>(null);
	// Manifest awareness (M3-3.4): one daemon scan, shared with the artifacts
	// panel, consulted when a preview opens so the header can name the artifact
	// the file belongs to.
	const { byDir: artifactByDir } = useArtifactIndex(rpc, cwd);
	const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null);
	/** Inline editor buffer: null = view mode; text/saved drive the dirty dot. */
	const [edit, setEdit] = useState<{ text: string; saved: string } | null>(null);
	const [saving, setSaving] = useState(false);
	/** .html preview: "live" (rendered page) or "source" (highlighted text). */
	const [htmlLiveMode, setHtmlLiveMode] = useState<"live" | "source">("live");
	/** .md preview: rendered Markdown (default) or raw source. */
	const [mdRender, setMdRender] = useState(true);
	const [ctx, setCtx] = useState<MenuState | null>(null);
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	/** List .gitignore'd paths too (shared pref with the Git tab / changes
	 *  view; on by default — see lib/git-prefs). */
	const [showIgnored, setShowIgnored] = useState<boolean>(() => readShowIgnored());
	/** List dotfiles too. The daemon scan always returns them (`hidden:
	 *  true`), so hiding is a pure client-side filter (lib/git-prefs). */
	const [showHidden, setShowHidden] = useState<boolean>(() => readShowHidden());
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
	// Viewers are built once per pane from the component's own services, not
	// from a process-wide registry: the highlighter is a hook result scoped to
	// this instance, and a global table would let one pane's bytes be answered
	// by another's services. The set is stable for the pane's life because its
	// only moving part is the highlighter identity.
	const viewerDeps = useMemo<BuiltinViewerDeps>(
		() => ({
			highlight: (text, lang) => Promise.resolve(highlight(text, lang)),
			highlightToHtml: highlightToCodeHtml,
			buildSheets: buildSheetModels,
			renderPdfPages: renderPdfPagesToDataUrls,
		}),
		[highlight],
	);
	// Built-ins from this pane's services, then anything registered globally,
	// ordered by declared priority. The global half is what makes the seam real
	// rather than decorative: without it a plugin calling `registerFileViewer`
	// would register into a table no component consults. Ordering merges them
	// instead of concatenating, so a plugin at `override` priority takes a format
	// the built-ins also claim, and one at `fallback` only sees what they
	// declined. The table is read at setup — a registration that arrives after
	// this pane mounted is seen on the next pane, not mid-life.
	const viewers = useMemo(() => orderViewers([...builtinFileViewers(viewerDeps), ...listFileViewers()]), [viewerDeps]);
	const { confirm } = useConfirm();
	// Mirror of `edit` for async guards (openPreview/activeFile effect read it
	// without re-memoizing their callbacks on every keystroke).
	const editBufRef = useRef<{ text: string; saved: string } | null>(null);
	editBufRef.current = edit;
	/** The tree path the current preview registered under (onOpenFile arg) —
	 *  the key onDirty reports so the strip can find the tab. */
	const previewRegPathRef = useRef<string | null>(null);
	/** Ref mirror of `preview.path` so the unmount cleanup can stash a dirty
	 *  editor buffer without depending on `preview` (which would re-arm the
	 *  cleanup on every preview switch). */
	const previewPathRef = useRef<string | null>(null);

	// File instances live in the PANEL tab strip (tab-primary, docs §3.3.2):
	// this pane is the body of whichever `files:<path>` tab is active, so it
	// loads on activeFile changes and registers tree clicks via onOpenFile.

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
				// M1.12 target picker: a tab opened on a directory browses that
				// directory instead of the whole workspace. Entry paths stay
				// workspace-relative either way (daemon re-roots them), so every
				// path consumer below keeps one rule.
				...(browseRoot ? { root: browseRoot } : {}),
				maxDepth: 4,
				perDirLimit: 80,
				// Respect .gitignore only while the user has it off: a tree that
				// silently drops ignored paths reads as "my file is missing".
				gitignore: !showIgnored,
			});
			setEntries(res.entries ?? []);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEntries(null);
		}
	}, [rpc, cwd, browseRoot, showIgnored]);

	useEffect(() => {
		void load();
	}, [load]);

	// The Git tab / changes view write the same prefs — follow them here.
	useEffect(
		() =>
			onGitPrefsChanged(() => {
				setShowIgnored(readShowIgnored());
				setShowHidden(readShowHidden());
			}),
		[],
	);

	// Track the list viewport height for virtualization. Deps deliberately
	// include the things that (un)mount the list: the first run bails while
	// `entries` is still null, and a once-only effect would leave viewH at its
	// 400px default — rows past that never render, so the bottom of a taller
	// list stays blank until a scroll event recomputes the window.
	useEffect(() => {
		const el = listRef.current;
		if (!el) return;
		const measure = (): void => setViewH(el.clientHeight);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [entries, preview]);

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

	// Editor buffer cache keyed by path: leaving a tab unmounts the pane, so
	// the unsaved textarea would reset to the on-disk text on return. The
	// cache holds the last buffer per path; a saved file drops its entry.
	const bufferCacheRef = useRef(new Map<string, { text: string; saved: string }>());

	// Tree↔file tab switches unmount this pane (renderPanelBody mounts only
	// the active tab). Stash a dirty editor buffer keyed by the preview path
	// so the re-mounted pane restores the unsaved text instead of disk bytes;
	// openPreview reads the cache back through the normal restore path.
	useEffect(() => {
		previewPathRef.current = preview?.path ?? null;
	}, [preview]);
	// Attach manifest awareness to whatever preview is open (M3-3.4). Keyed on
	// the path rather than woven into openPreview's branches: every branch that
	// produces a preview gets the badge, and a file outside any manifest
	// directory simply clears it.
	useEffect(() => {
		if (!preview) return;
		const rel = preview.path.startsWith(`${cwd}/`) ? preview.path.slice(cwd.length + 1) : preview.path;
		const artifact = owningArtifact(rel, artifactByDir);
		const artifactFields = artifact
			? { kind: artifact.kind, renderer: artifact.renderer, exports: artifact.exports, errors: artifact.errors }
			: undefined;
		setPreview(current =>
			current && current.path === preview.path && JSON.stringify(current.artifact) !== JSON.stringify(artifactFields)
				? { ...current, artifact: artifactFields }
				: current,
		);
	}, [preview?.path, artifactByDir, cwd]);
	useEffect(() => {
		return () => {
			const buf = editBufRef.current;
			const path = previewPathRef.current;
			if (buf && buf.text !== buf.saved && path) bufferCacheRef.current.set(path, buf);
		};
	}, []);

	const tree = useMemo(() => {
		// Dotfile filter is client-side only: the daemon scan always returns
		// hidden entries, so the toggle just narrows what the tree builds.
		const visible = showHidden ? (entries ?? []) : (entries ?? []).filter(e => !e.name.startsWith("."));
		return compressTree(buildTree(visible));
	}, [entries, showHidden]);
	// Collapsed by default: a fresh Files view is a folder
	// list, not an expanded dump — the expanded form is what reads as noise.
	// Seeded once from the first tree that carries directories, so a later
	// refresh (or the gitignore toggle reload) doesn't fight the user's own
	// expansion.
	const seededRef = useRef(false);
	useEffect(() => {
		if (seededRef.current || tree.length === 0) return;
		const dirs = collectDirPaths(tree);
		if (dirs.size === 0) return;
		seededRef.current = true;
		setCollapsed(dirs);
	}, [tree]);
	const rows = useMemo(() => flattenVisible(tree, collapsed, query.trim()), [tree, collapsed, query]);
	const total = rows.length + (editing ? 1 : 0);
	const start = Math.max(0, Math.floor(scrollTop / ROW_H) - ROW_BUFFER);
	const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + ROW_BUFFER);
	const editIndex = editing ? editingIndex(rows, editing) : -1;

	/** Leave-guard for the inline editor: unsaved buffers must be confirmed
	 *  away before any preview switch (tree click, tab activation, external
	 *  reveal). Reads the ref so stale callbacks still see the live buffer. */
	const confirmDiscard = useCallback(async (): Promise<boolean> => {
		const buf = editBufRef.current;
		if (!buf || buf.text === buf.saved) return true;
		const ok = await confirm(t("discard unsaved changes?"), t("discard"));
		if (ok) {
			editBufRef.current = null;
			setEdit(null);
		}
		return ok;
	}, [confirm]);

	// Mirror the editor's dirty state onto the panel tab strip. On a preview
	// switch the previous path is explicitly cleared — the ref already points
	// at the new tab, so a plain "dirty → report" would strand the old dot.
	const dirty = edit !== null && edit.text !== edit.saved;
	const lastDirtyRef = useRef<{ path: string; dirty: boolean } | null>(null);
	useEffect(() => {
		if (!onDirty) return;
		const path = previewRegPathRef.current;
		const prev = lastDirtyRef.current;
		if (prev && prev.path !== path && prev.dirty) onDirty(prev.path, false);
		lastDirtyRef.current = path ? { path, dirty } : null;
		if (path && (prev?.path !== path || prev.dirty !== dirty)) onDirty(path, dirty);
	}, [dirty, onDirty, preview]);

	const openPreview = useCallback(
		async (entry: WorkspaceEntry, opts?: { enterEdit?: boolean }): Promise<boolean> => {
			if (entry.isDir) return false;
			if (!(await confirmDiscard())) return false;
			setSelectedPath(entry.path);
			setEdit(null);
			previewRegPathRef.current = entry.path;
			onOpenFile?.(entry.path, entry.name);
			// workspace.tree paths are relative to the session cwd; external
			// reveals (artifact cards) may carry absolute paths — don't join.
			const absPath = entry.path.startsWith("/") ? entry.path : `${cwd}/${entry.path}`;
			// A re-open of the same file (tree click on the tab already open)
			// keeps its unsaved buffer; anything else starts from disk. A
			// DIRTY cached buffer also re-enters the editor straight away
			// (pane unmount across a tree↔file tab switch): the user comes
			// back to their unsaved text, not a silent reset to disk bytes.
			const buffer = bufferCacheRef.current.get(absPath) ?? null;
			if (!buffer) bufferCacheRef.current.delete(absPath);
			// If the editor opened straight into a freshly created file, a
			// tree click before any save would otherwise drop its content.
			const enterEdit = opts?.enterEdit ?? false;
			const restoreEdit = enterEdit || (buffer !== null && buffer.text !== buffer.saved);
			try {
				const res = await rpc.request<{ base64?: string; size?: number; mime?: string; error?: string }>(
					"fs.readBytes",
					{ path: absPath },
				);
				if (res.error || !res.base64) {
					setPreview({ path: absPath, name: entry.name, size: entry.size, error: res.error ?? "read failed" });
					return true;
				}
				const bytes = Uint8Array.from(atob(res.base64), c => c.charCodeAt(0));
				// Classification, decode, and per-format rendering live in the
				// viewer registry (lib/file-viewers), ordered by priority; the pane
				// hands these bytes to the first viewer that takes the file and maps
				// the result back onto preview state through `previewMappingFor`.
				// That mapping is pure and unit-tested so the two editor-seed
				// asymmetries that were in the branch chain this replaced — html and
				// a highlighted file open read-only, plain text and Markdown seed the
				// inline editor — stay pinned without mounting the component.
				const ext = extOf(entry.name);
				const result = await renderWithViewerList(viewers, {
					name: entry.name,
					path: absPath,
					size: res.size ?? bytes.length,
					bytes,
					mime: res.mime,
					ext,
				});
				if (result === undefined) {
					// No viewer took the file (an unknown binary, or a corrupt/encrypted
					// document that declined to render): open it in the system app, the
					// same fall-through the chain had.
					await window.electronAPI?.openWith("", absPath);
					setPreview({ path: absPath, name: entry.name, size: res.size ?? bytes.length, external: true });
					return true;
				}
				const mapped = previewMappingFor(result);
				if (mapped.htmlLiveMode === "live") setHtmlLiveMode("live");
				if (mapped.mdRender === true) setMdRender(true);
				setPreview({ path: absPath, name: entry.name, size: res.size ?? bytes.length, ...mapped.fields });
				// The editor seeds only for a format whose preview IS its text
				// (plain text, Markdown); an html or highlighted view opens
				// read-only, and a dirty cached buffer re-enters the editor.
				if (restoreEdit && mapped.editable !== undefined) {
					setEdit(buffer ?? { text: mapped.editable, saved: mapped.editable });
				}
				return true;
			} catch (err) {
				setPreview({
					path: absPath,
					name: entry.name,
					size: entry.size,
					error: err instanceof Error ? err.message : String(err),
				});
				return true;
			}
		},
		[rpc, cwd, viewers, onOpenFile, confirmDiscard],
	);

	// Load whichever file tab the panel strip activated. Skipped when the
	// preview already shows that path (the tab was opened by this pane, so
	// openPreview already ran and re-running would reload the same bytes).
	// A cancelled leave-guard (user keeps their unsaved buffer) rolls the
	// ref back so the declined tab can still be activated later.
	const lastLoadedRef = useRef<string | null>(null);
	useEffect(() => {
		if (!activeFile) {
			lastLoadedRef.current = null;
			return;
		}
		if (activeFile === lastLoadedRef.current) return;
		const prev = lastLoadedRef.current;
		lastLoadedRef.current = activeFile;
		void openPreview(syntheticEntry(activeFile)).then(ok => {
			if (!ok) lastLoadedRef.current = prev;
		});
		// openPreview is stable (useCallback) — deliberately not a trigger.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeFile]);

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
			if (editing.kind === "new-file") {
				await rpc.request("fs.write", { cwd, path: rel, content: "" });
				// A fresh empty file is a dead end in an external app — open it
				// straight into the inline editor instead.
				void openPreview({ path: rel, name, isDir: false, size: 0, mtime: 0, depth: 0 }, { enterEdit: true });
			} else if (editing.kind === "new-dir") await rpc.request("fs.mkdir", { cwd, path: rel });
			else await rpc.request("fs.rename", { cwd, from: target!.path, to: rel });
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [editing, editValue, rpc, cwd, load, openPreview]);

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

	/** Enter the inline editor for the file currently being previewed.
	 *  Files without a text representation (images/PDFs/office binaries) or
	 *  past the size cap stay view-only. */
	const startEdit = useCallback(async (): Promise<void> => {
		if (!preview) return;
		if (preview.raw !== undefined) {
			const cached = bufferCacheRef.current.get(preview.path);
			if (cached) {
				if (edit && edit.text !== edit.saved) {
					if (!(await confirm(t("discard unsaved changes?"), t("discard")))) return;
				}
				setEdit(cached);
			} else if (!edit) setEdit({ text: preview.raw, saved: preview.raw });
			else if (edit.text !== edit.saved) {
				if (!(await confirm(t("discard unsaved changes?"), t("discard")))) return;
				setEdit({ text: preview.raw, saved: preview.raw });
			}
			editRef.current?.focus();
		} else if (preview.size > EDIT_MAX_BYTES) {
			window.dispatchEvent(new CustomEvent("musepi-gui-toast", { detail: t("file too large to edit") }));
		} else {
			window.dispatchEvent(new CustomEvent("musepi-gui-toast", { detail: t("unsupported edit") }));
		}
	}, [preview, edit, confirm]);

	const exitEdit = useCallback(async (): Promise<void> => {
		if (!edit || edit.text === edit.saved) {
			setEdit(null);
			return;
		}
		if (await confirm(t("discard unsaved changes?"), t("discard"))) setEdit(null);
	}, [edit, confirm]);

	/** Persist the edited buffer. fs.write takes cwd-relative paths; the
	 *  preview joined cwd already, so split the tail back off. */
	const saveEdit = useCallback(async (): Promise<void> => {
		if (!edit || !preview || saving) return;
		const rel = preview.path.startsWith(`${cwd}/`) ? preview.path.slice(cwd.length + 1) : preview.path;
		setSaving(true);
		try {
			await rpc.request("fs.write", { cwd, path: rel, content: edit.text });
			setEdit(cur => (cur ? { ...cur, saved: cur.text } : cur));
			bufferCacheRef.current.delete(preview.path);
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [edit, preview, cwd, rpc, load, saving]);

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
		// dsh rc.2 ui-open-in-app parity: a hover action opens the entry in
		// the OS default app (folder → Explorer/Finder, file → default app).
		const openInApp = (
			<button
				type="button"
				className="gui-filepane-open-btn"
				title={t("open with app")}
				aria-label={t("open with app")}
				onClick={ev => {
					ev.stopPropagation();
					void window.electronAPI?.openWith("", `${cwd}/${entry.path}`);
				}}
			>
				<ExternalLink size={12} />
			</button>
		);
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
					{openInApp}
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
				{openInApp}
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
					<button
						className={`gui-btn gui-btn-icon${showIgnored ? " gui-btn-icon--active" : ""}`}
						type="button"
						title={t("show gitignored")}
						aria-label={t("show gitignored")}
						aria-pressed={showIgnored}
						onClick={() => {
							const next = !showIgnored;
							setShowIgnored(next);
							writeShowIgnored(next);
						}}
					>
						{showIgnored ? <Eye size={12} /> : <EyeOff size={12} />}
					</button>
					<button
						className={`gui-btn gui-btn-icon${showHidden ? " gui-btn-icon--active" : ""}`}
						type="button"
						title={t("show hidden files")}
						aria-label={t("show hidden files")}
						aria-pressed={showHidden}
						onClick={() => {
							const next = !showHidden;
							setShowHidden(next);
							writeShowHidden(next);
						}}
					>
						{showHidden ? <ScanEye size={12} /> : <EyeOff size={12} />}
					</button>
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
								onClick={() => {
									// Panel-level file instances split tree and
									// preview into two tabs: back
									// activates the tree tab. Standalone (legacy
									// sidebar) usage has no tree tab — drop the
									// preview inside this pane instead.
									if (onShowTree) onShowTree();
									else void exitEdit().then(() => setPreview(null));
								}}
							>
								<ArrowLeft size={12} />
							</button>
							<span className="gui-filepane-preview-name" title={preview.path}>
								{preview.name}
							</span>
							{/* M3-3.4: a file inside an artifact directory previews with its
							    manifest's identity. An invalid manifest names itself — the
							    agent's mistake is visible where the person is looking, the
							    same rule the artifacts panel follows by listing broken
							    manifests instead of dropping them. */}
							{preview.artifact &&
								(preview.artifact.errors && preview.artifact.errors.length > 0 ? (
									<span
										className="gui-filepane-artifact-badge gui-filepane-artifact-badge--invalid"
										title={preview.artifact.errors.join("\n")}
									>
										{t("artifact manifest invalid")}
									</span>
								) : (
									<span
										className="gui-filepane-artifact-badge"
										title={
											preview.artifact.exports?.length
												? t("artifact exports hint", { exports: preview.artifact.exports.join(", ") })
												: t("artifact badge hint", { kind: preview.artifact.kind })
										}
									>
										{preview.artifact.kind} · {preview.artifact.renderer}
									</span>
								))}
							{extOf(preview.name) === "md" && preview.text !== undefined && !edit && (
								<Segmented
									className="gui-seg--compact"
									ariaLabel={t("preview")}
									value={mdRender ? "rendered" : "source"}
									options={MD_VIEW_SEGMENTS}
									onChange={v => setMdRender(v === "rendered")}
								/>
							)}
							<span className="gui-filepane-preview-tools">
								{preview.raw !== undefined && !edit && (
									<button
										type="button"
										className="gui-btn gui-btn-icon"
										title={t("edit")}
										onClick={() => void startEdit()}
									>
										<Pencil size={12} />
									</button>
								)}
								<button
									type="button"
									className="gui-btn gui-btn-icon"
									title={t("copy path")}
									onClick={() => {
										window.electronAPI?.copyText(preview.path).catch(() => {});
									}}
								>
									<ClipboardCopy size={12} />
								</button>
								<button
									type="button"
									className="gui-btn gui-btn-icon"
									title={t("cite file in composer")}
									onClick={() => {
										// Cite the workspace-relative path into the
										// chat draft (shared insert channel — the
										// composer listens window-wide).
										const rel = preview.path.startsWith(`${cwd}/`)
											? preview.path.slice(cwd.length + 1)
											: preview.path;
										window.dispatchEvent(
											new CustomEvent("musepi-gui-insert-text", { detail: { text: `@${rel}` } }),
										);
									}}
								>
									<Quote size={12} />
								</button>
								<button
									type="button"
									className="gui-btn gui-btn-icon"
									title={t("open with default app")}
									onClick={() => {
										window.electronAPI?.openWith("", preview.path).catch(() => {});
									}}
								>
									<ExternalLink size={12} />
								</button>
							</span>
							<button
								type="button"
								className="gui-btn gui-btn-icon"
								title={t("close")}
								onClick={() => void exitEdit().then(() => setPreview(null))}
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
							{preview.html !== undefined && !edit && (
								<pre className="gui-filepane-preview-text" dangerouslySetInnerHTML={{ __html: preview.html }} />
							)}
							{preview.text !== undefined && extOf(preview.name) === "md" && mdRender && !edit ? (
								<div className="gui-filepane-preview-md">
									<Markdown text={preview.text} basePath={cwd} />
								</div>
							) : preview.text !== undefined && !edit ? (
								<pre className="gui-filepane-preview-text">{preview.text}</pre>
							) : null}
							{edit && (
								<FileEditor
									value={edit.text}
									name={preview.name}
									saving={saving}
									onChange={text =>
										setEdit(cur => {
											const next = cur ? { ...cur, text } : null;
											if (next && preview) {
												// Stash so a tab switch (pane unmount) or a
												// re-open of this file restores the unsaved
												// buffer instead of re-reading disk.
												bufferCacheRef.current.set(preview.path, next);
												if (text === next.saved) bufferCacheRef.current.delete(preview.path);
											}
											return next;
										})
									}
									onSave={() => void saveEdit()}
									onExit={() => void exitEdit()}
								/>
							)}
							{preview.docxBytes && <DocxPreview data={preview.docxBytes} path={preview.path} />}
							{preview.officeSheets && <SheetPreview name={preview.name} sheets={preview.officeSheets} />}
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
				<Segmented
					className="gui-seg--compact"
					ariaLabel={t("preview")}
					value={live ? "live" : "source"}
					options={HTML_VIEW_SEGMENTS}
					onChange={onToggle}
				/>
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

/** Inline text editor: plain textarea, save-on-Cmd/Ctrl+S, dirty badge,
 *  and a leave guard handled by the parent (onExit asks before discarding).
 *  Deliberately not a code editor — a textarea never breaks on partial
 *  parses and stays fast on megabyte buffers. */
function FileEditor({
	value,
	name,
	saving,
	onChange,
	onSave,
	onExit,
}: {
	value: string;
	name: string;
	saving: boolean;
	onChange(text: string): void;
	onSave(): void;
	onExit(): void;
}): ReactNode {
	const ref = useRef<HTMLTextAreaElement | null>(null);
	useEffect(() => {
		ref.current?.focus();
	}, []);
	return (
		<div className="gui-filepane-editor">
			<div className="gui-filepane-editor-bar">
				<Pencil size={12} className="gui-filepane-icon" />
				<span className="gui-filepane-editor-name" title={name}>
					{name}
				</span>
				<button
					type="button"
					className="gui-btn gui-btn-icon"
					title={t("discard changes and close editor")}
					onClick={onExit}
				>
					<ArrowLeft size={12} />
				</button>
			</div>
			<textarea
				ref={ref}
				className="gui-filepane-editor-text"
				value={value}
				spellCheck={false}
				onChange={ev => onChange(ev.target.value)}
				onKeyDown={ev => {
					if ((ev.metaKey || ev.ctrlKey) && ev.key === "s") {
						ev.preventDefault();
						onSave();
					} else if (ev.key === "Escape") {
						onExit();
					}
				}}
			/>
			<div className="gui-filepane-editor-foot">
				<button type="button" className="gui-btn gui-btn-sm" disabled={saving} onClick={onSave} title={t("save")}>
					<Save size={12} />
					{t("save")}
				</button>
				<span className="gui-panel-muted">{t("cmd s to save")}</span>
			</div>
		</div>
	);
}

/** .docx preview: docx-preview renders into a container element. Errors
 *  (encrypted/corrupt documents) surface as a note with the OS fallback. */
function DocxPreview({ data, path }: { data: ArrayBuffer; path: string }): ReactNode {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (!containerRef.current) return;
		const container = containerRef.current;
		let cancelled = false;
		void renderDocx(new Blob([data]), container, undefined, {
			className: "gui-filepane-docx",
			inWrapper: true,
			ignoreWidth: true,
			ignoreHeight: true,
			breakPages: true,
			useBase64URL: true,
		})
			.then(() => {
				if (cancelled) container.innerHTML = "";
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
			container.innerHTML = "";
		};
	}, [data, path]);
	return failed ? (
		<p className="gui-error">
			{t("cannot preview this file")} —{" "}
			<button
				type="button"
				className="gui-btn gui-btn-sm"
				onClick={() => window.electronAPI?.openWith("", path).catch(() => {})}
			>
				{t("open with default app")}
			</button>
		</p>
	) : (
		<div className="gui-filepane-docx-wrap">
			<div ref={containerRef} />
		</div>
	);
}

/** Spreadsheet preview: each sheet becomes an escaped HTML table. */
function SheetPreview({
	name,
	sheets,
}: {
	name: string;
	// Readonly: the pane maps over the sheet models and indexes the active one,
	// never mutates them, so a caller holding a frozen array should not have to
	// copy it to satisfy this prop.
	sheets: ReadonlyArray<{ name: string; html: string; truncated: boolean }>;
}): ReactNode {
	const [active, setActive] = useState(0);
	useEffect(() => {
		if (active >= sheets.length) setActive(0);
	}, [sheets.length, active]);
	const sheet = sheets[Math.min(active, sheets.length - 1)];
	return (
		<div className="gui-filepane-sheets">
			{sheets.length > 1 && (
				<div className="gui-filepane-preview-modes">
					{sheets.map((s, i) => (
						<button
							key={`${name}:${s.name}`}
							type="button"
							className={`gui-seg-btn${i === active ? " gui-seg-btn--active" : ""}`}
							onClick={() => setActive(i)}
						>
							{s.name}
						</button>
					))}
				</div>
			)}
			{sheet?.truncated && (
				<p className="gui-filepane-preview-note">{t("only first {n} rows shown", { n: OFFICE_SHEET_ROWS })}</p>
			)}
			{sheet && (
				<div
					className="gui-filepane-sheet"
					// HTML is built locally from escaped cell values — no user
					// markup, no remote content.
					dangerouslySetInnerHTML={{ __html: sheet.html }}
				/>
			)}
		</div>
	);
}

/** Parse a spreadsheet into renderable sheet models: each sheet becomes an
 *  escaped HTML table plus a truncation flag. Returns null when the workbook
 *  cannot be read (encrypted/corrupt), so the caller falls back to the OS
 *  default app instead of a broken preview.
 *
 *  Rows cap at OFFICE_SHEET_ROWS per sheet: SheetJS parses one row past the
 *  cap (sheetRows), and the returned row count is then itself the truncation
 *  signal — `!ref` is rewritten by the cap and would report the already
 *  truncated range. Cell text is escaped here because XLSX.utils.sheet_to_html
 *  does not escape cell values, so a spreadsheet containing markup would
 *  otherwise inject it into the preview. */
export function buildSheetModels(data: Uint8Array): Array<{
	name: string;
	html: string;
	truncated: boolean;
}> | null {
	let wb: XLSX.WorkBook;
	try {
		wb = XLSX.read(data, { type: "array", sheetRows: OFFICE_SHEET_ROWS + 1 });
	} catch {
		return null;
	}
	// Junk bytes do not throw — SheetJS reads them as a degenerate workbook
	// (no sheets, or a single empty cell). Either form means "nothing to
	// preview", so let the OS default app take it instead of an empty table
	// pretending to be the document.
	const models = wb.SheetNames.map(name => {
		const ws = wb.Sheets[name];
		if (!ws) return { name, html: "", truncated: false, empty: true };
		const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" });
		const truncated = rows.length > OFFICE_SHEET_ROWS;
		const empty = rows.every(row => row.every(cell => String(cell ?? "").trim() === ""));
		return {
			name,
			html: buildSheetHtml(truncated ? rows.slice(0, OFFICE_SHEET_ROWS) : rows),
			truncated,
			empty,
		};
	});
	if (models.length === 0 || models.every(m => m.empty)) return null;
	return models.map(({ name, html, truncated }) => ({ name, html, truncated }));
}

/** Build an escaped HTML table from a cell matrix (SheetJS sheet_to_json with
 *  header:1). Cell text is escaped here — XLSX.utils.sheet_to_html does not
 *  escape cell values, so a spreadsheet containing markup would inject it. */
function buildSheetHtml(rows: string[][]): string {
	const escapeCell = (v: unknown): string =>
		String(v ?? "")
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;");
	const lines: string[] = ['<table class="gui-filepane-sheet-table">'];
	for (const row of rows) {
		lines.push("<tr>");
		for (const cell of row) lines.push(`<td>${escapeCell(cell)}</td>`);
		lines.push("</tr>");
	}
	lines.push("</table>");
	return lines.join("");
}
