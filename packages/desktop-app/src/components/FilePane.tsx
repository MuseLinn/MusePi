import { highlightToCodeHtml, ImageLightbox, Markdown, Segmented, type SegmentedOption, t } from "@musepi/client-core";
import { createFileQuoteContext } from "@musepi/client-core/src/messages/display-context";
import { renderAsync as renderDocx } from "docx-preview";
import {
	ClipboardCopy,
	Download,
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
	PanelLeft,
	Presentation,
	Quote,
	RefreshCw,
	Save,
	ScanEye,
	Search,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { owningArtifact, useArtifactIndex } from "../lib/artifact-index";
// Import order below is alphabetical by module path (biome).
import { type BuiltinViewerDeps, builtinFileViewers } from "../lib/builtin-file-viewers";
import type { EditorLocation } from "../lib/editor-navigation";
import { listFileViewers, orderViewers, renderWithViewerList } from "../lib/file-viewers";
import {
	onGitPrefsChanged,
	readShowHidden,
	readShowIgnored,
	writeShowHidden,
	writeShowIgnored,
} from "../lib/git-prefs";
import { useChatHighlight } from "../lib/highlight";
import { downloadMarkdownDocx } from "../lib/markdown-docx";
import type { MonacoPeekBuffer } from "../lib/monaco-lsp";
import { previewMappingFor } from "../lib/preview-from-viewer";
import { useConfirm } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import { captureSelectionContext } from "../lib/selection-capture";
import { Icon } from "../vendor/oc-icons";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { FileCodeEditor, type FileEditorSelection } from "./FileCodeEditor";
import { FileDirectoryMenu } from "./FileDirectoryMenu";
import { FileMarkdownEditor, hasYamlFrontMatter, type FileMarkdownEditorHandle } from "./FileMarkdownEditor";
import type { PdfEditorSelection } from "./FilePdfPreview";
import { FileOpenWith } from "./FileOpenWith";
import { ImagePreview } from "./FilePaneImagePreview";
import { useMarkdownFileNavigation } from "./FilePaneMarkdownNav";
import { FontPreview, MediaPreview, MermaidPreview } from "./FilePanePreviews";
import { SelectionToolbar } from "./SelectionToolbar";

/** Markdown preview switch: rendered markdown vs the raw source text. */
const MD_VIEW_SEGMENTS: SegmentedOption<"rendered" | "source">[] = [
	{ value: "rendered", label: t("settings.renderedView") },
	{ value: "source", label: t("settings.sourceCode") },
];

/** HTML preview switch: live iframe vs the raw source text. */
const HTML_VIEW_SEGMENTS: SegmentedOption<"live" | "source">[] = [
	{ value: "live", label: t("settings.pagePreview") },
	{ value: "source", label: t("settings.sourceCode") },
];

/** The PDFium reader is a real split point: ordinary text and image files do
 * not pay for its engine or plugin graph. */
const FilePdfPreview = lazy(() => import("./FilePdfPreview"));

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
	/** live-rendered HTML page (.html previews render) */
	htmlLive?: string;
	/** blob URL for image preview */
	imageUrl?: string;
	/** Original PDF bytes; the lazy reader renders only visible pages. */
	pdfBytes?: ArrayBuffer;
	/** docx bytes for the docx-preview renderer */
	docxBytes?: ArrayBuffer;
	/** xlsx/xls/csv sheets rendered to standalone HTML tables. Readonly: the
	 *  sheet builder's output is handed to the pane to render, never edited. */
	officeSheets?: ReadonlyArray<{ name: string; html: string; truncated: boolean }>;
	/** an audio/video file, played by the browser's own media element */
	media?: { kind: "audio" | "video"; url: string };
	/** a font file, shown as a type specimen */
	fontUrl?: string;
	/** a Mermaid diagram source, rendered by the transcript's diagram renderer */
	mermaidSource?: string;
	error?: string;
	/** preview shown but content opens externally (unsupported binaries) */
	external?: boolean;
	/** The workspace artifact this file belongs to, when its directory carries
	 *  a valid `artifact.manifest.json` (M3-3.4). Undefined for plain files —
	 *  most of the tree is not an artifact, and the badge's absence is the
	 *  ordinary case. */
	artifact?: { kind: string; renderer: string; exports?: string[]; errors?: string[] };
}

/** sheet_to_html truncation point per sheet (parse-time sheetRows cap). */
const OFFICE_SHEET_ROWS = 1000;

/** Fixed virtual-row height (px); keep in sync with .gui-filepane-vrow CSS. */
const ROW_H = 26;
const ROW_BUFFER = 6;

interface FilePreviewBuffer {
	text: string;
	saved: string;
}

/** Monaco and file tabs can spell the same Windows path with different slash
 * directions and drive-letter casing. Cache identity must not depend on either. */
function filePreviewBufferKey(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	return /^[A-Za-z]:\//.test(normalized) ? `${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}` : normalized;
}

/** Module scope preserves dirty text while an inactive tab's pane is unmounted.
 * Only unsaved text is retained; saving or restoring the saved text drops it. */
const unsavedBuffers = new Map<string, FilePreviewBuffer>();
const unsavedBufferCache = {
	get(path: string): FilePreviewBuffer | undefined {
		return unsavedBuffers.get(filePreviewBufferKey(path));
	},
	set(path: string, buffer: FilePreviewBuffer): void {
		unsavedBuffers.set(filePreviewBufferKey(path), buffer);
	},
	delete(path: string): void {
		unsavedBuffers.delete(filePreviewBufferKey(path));
	},
};

interface TreeNode {
	entry: WorkspaceEntry;
	children: TreeNode[];
	/** Display label — "a/b" when a single-child dir chain is compressed
	 *  (VS Code path-compression). */
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
 *  listWorkspace is depth-first), then files attached to their parent dir.
 *  A truncated or filtered scan can omit a parent; its descendants stay hidden
 *  instead of becoming misleading root entries. */
export function buildTree(entries: WorkspaceEntry[], browseRoot = ""): TreeNode[] {
	const seen = new Set<string>();
	const unique = entries.filter(entry => {
		if (seen.has(entry.path)) return false;
		seen.add(entry.path);
		return true;
	});
	const dirs = unique.filter(e => e.isDir);
	const files = unique.filter(e => !e.isDir);
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
		else if (parentPath === "" || parentPath === browseRoot) roots.push(node);
	}
	for (const e of files) {
		const slash = e.path.lastIndexOf("/");
		const parentPath = slash === -1 ? "" : e.path.slice(0, slash);
		const node: TreeNode = { entry: e, children: [], label: e.name };
		const parent = byPath.get(parentPath);
		if (parent) parent.children.push(node);
		else if (parentPath === "" || parentPath === browseRoot) roots.push(node);
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
	return { path, name: path.split(/[\\/]/).pop() ?? path, isDir: false, size: 0, mtime: 0, depth: 0 };
}

/** Resolve tree-relative paths without treating Windows or UNC absolute paths
 *  as workspace children. Preview state and the unsaved cache use this form. */
export function resolveFilePreviewPath(cwd: string, path: string): string {
	if (path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path)) return path;
	return `${cwd.replace(/[\\/]+$/, "")}/${path}`;
}

/** fs.write accepts workspace-relative paths only. Monaco normalizes Windows
 *  paths to lowercase drive letters and backslashes, so compare Windows roots
 *  case-insensitively and return slash-separated paths to the daemon. Paths
 *  outside the workspace stay absolute and are rejected by the file service. */
export function filePreviewWorkspacePath(cwd: string, path: string): string {
	const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	const candidate = path.replace(/\\/g, "/");
	const prefix = `${root}/`;
	const windows = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\");
	const inside = windows ? candidate.toLowerCase().startsWith(prefix.toLowerCase()) : candidate.startsWith(prefix);
	return inside ? candidate.slice(prefix.length) : path;
}

/** Compare canonical workspace-relative paths, including Windows drive case. */
export function filePreviewPathEquals(cwd: string, left: string, right: string): boolean {
	const a = filePreviewWorkspacePath(cwd, left);
	const b = filePreviewWorkspacePath(cwd, right);
	const windows = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\");
	return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Accepted close operations must survive the pane's unmount cleanup, which
 * otherwise writes the dirty buffer straight back into the cache. */
const discardedBufferPaths = new Set<string>();

export function discardFilePreviewBuffer(cwd: string, path: string): void {
	const absolute = resolveFilePreviewPath(cwd, path);
	unsavedBufferCache.delete(absolute);
	discardedBufferPaths.add(filePreviewBufferKey(absolute));
}

/** Stash a dirty buffer for a deactivation, but never for an accepted close. */
export function stashFilePreviewBuffer(path: string, buffer: FilePreviewBuffer): void {
	if (buffer.text !== buffer.saved && !discardedBufferPaths.has(filePreviewBufferKey(path)))
		unsavedBufferCache.set(path, buffer);
}

/** Restore a deactivated buffer. A deliberate reopen starts a new close cycle. */
export function restoreFilePreviewBuffer(path: string): FilePreviewBuffer | null {
	discardedBufferPaths.delete(filePreviewBufferKey(path));
	return unsavedBufferCache.get(path) ?? null;
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
 *  (VS Code path-compression):
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

/** Extension-aware file glyph: code, image,
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
	else if (["xlsx", "xls", "csv", "tsv"].includes(ext)) IconCmp = FileSpreadsheet;
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
	onClosePreview,
	onNewSession,
	canNavigateBack = false,
	canNavigateForward = false,
	onNavigateBack,
	onNavigateForward,
	onEditorNavigate,
	onEditorPositionChange,
}: {
	rpc: RpcClient;
	cwd: string;
	/** External reveal (artifact cards / transcript paths): preview this
	 *  path via the same pipeline as a tree click. */
	openRequest?: { path: string; nonce: number; pdf?: PdfEditorSelection["anchor"]; quote?: string } | null;
	/** Tab-primary model (docs §3.3.2): file instances live in the PANEL
	 *  strip. The pane loads whatever file tab the panel activated. */
	activeFile?: string | null;
	/** Workspace-relative directory this instance browses (M1.12 target
	 *  picker). `null`/absent means the whole workspace. Distinct from
	 *  `activeFile`, which addresses a file to preview — one tab is a directory
	 *  to browse or a file to preview, never both. */
	browseRoot?: string | null;
	/** Tree selection registers a preview; a double click pins it. `newTab`
	 *  preserves the file page whose inline tree initiated the open. */
	onOpenFile?: (path: string, name: string, options: { pin: boolean; newTab?: boolean }) => void;
	/** Inline-editor dirty state for the given tree path, mirrored onto the
	 *  panel tab (dot + close guard). Reported with the same path the pane
	 *  passed to onOpenFile, so the strip can find its tab. */
	onDirty?: (path: string, dirty: boolean) => void;
	/** Close the owning file tab. The panel retains its dirty-close guard. */
	onClosePreview?: () => void;
	/** Start a session from selected file text, using the chat's existing flow. */
	onNewSession?: (text: string) => void;
	/** VS Code-style editor-location history, owned by ContextPanel per cwd. */
	canNavigateBack?: boolean;
	canNavigateForward?: boolean;
	onNavigateBack?(): void;
	onNavigateForward?(): void;
	onEditorNavigate?(source: EditorLocation, target: EditorLocation): void;
	onEditorPositionChange?(location: EditorLocation): void;
}): ReactNode {
	const [entries, setEntries] = useState<WorkspaceEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [preview, setPreview] = useState<PreviewState | null>(null);
	// The markdown FILE preview's container: its relative links open the target
	// file in this pane and #fragment links scroll within it (local-asset
	// resolution, minus what resolveLocalImages already
	// covers). The transcript's Markdown has no such concept — a chat message
	// has no file to resolve against.
	const mdPreviewRef = useRef<HTMLDivElement | null>(null);
	// Manifest awareness (M3-3.4): one daemon scan, shared with the artifacts
	// panel, consulted when a preview opens so the header can name the artifact
	// the file belongs to.
	const { byDir: artifactByDir } = useArtifactIndex(rpc, cwd);
	const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null);
	/** Inline editor buffer: null = view mode; text/saved drive the dirty dot. */
	const [edit, setEdit] = useState<{ text: string; saved: string } | null>(null);
	const [fileSelection, setFileSelection] = useState<FileEditorSelection | null>(null);
	const [pdfSelection, setPdfSelection] = useState<PdfEditorSelection | null>(null);
	const [saving, setSaving] = useState(false);
	const [exportingWord, setExportingWord] = useState(false);
	/** .html preview: "live" (rendered page) or "source" (highlighted text). */
	const [htmlLiveMode, setHtmlLiveMode] = useState<"live" | "source">("live");
	/** .md preview: rendered Markdown (default) or raw source. */
	const [mdRender, setMdRender] = useState(true);
	/** File pages hide their non-modal project tree until explicitly expanded. */
	const [treeExpanded, setTreeExpanded] = useState(false);
	/** Workspace-relative directory and clicked segment for the anchored menu. */
	const [directoryPath, setDirectoryPath] = useState<string | null>(null);
	const [directoryAnchor, setDirectoryAnchor] = useState<HTMLElement | null>(null);
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
	const markdownEditorRef = useRef<FileMarkdownEditorHandle | null>(null);
	const updateEditText = (text: string): void =>
		setEdit(cur => {
			const next = cur ? { ...cur, text } : null;
			if (next && preview) {
				unsavedBufferCache.set(preview.path, next);
				if (text === next.saved) unsavedBufferCache.delete(preview.path);
			}
			return next;
		});
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
	/** Only the latest file load may publish preview state. */
	const previewRequestRef = useRef(0);

	// File instances live in the PANEL tab strip (tab-primary, docs §3.3.2):
	// this pane is the body of whichever `files:<path>` tab is active, so it
	// loads on activeFile changes and registers tree clicks via onOpenFile.

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
	}, [entries, preview, treeExpanded]);

	// Focus the inline editor when it mounts.
	useEffect(() => {
		if (editing) editRef.current?.focus();
	}, [editing]);

	// Revoke stale preview blob URLs so large images don't leak memory.
	useEffect(() => {
		return () => {
			if (preview?.imageUrl) URL.revokeObjectURL(preview.imageUrl);
			// Media and font previews hold their bytes in a blob URL for as long
			// as the preview is open; without this a long session of opening
			// clips and fonts would pin every one of them in memory.
			if (preview?.media) URL.revokeObjectURL(preview.media.url);
			if (preview?.fontUrl) URL.revokeObjectURL(preview.fontUrl);
		};
	}, [preview?.imageUrl, preview?.media, preview?.fontUrl]);

	// Editor buffer cache keyed by path (see `unsavedBufferCache`): leaving a
	// tab unmounts the pane, so the unsaved textarea would reset to the
	// on-disk text on return. The cache holds the last buffer per path; a
	// saved file drops its entry.

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
			previewRequestRef.current += 1;
			const buf = editBufRef.current;
			const path = previewPathRef.current;
			if (buf && path) stashFilePreviewBuffer(path, buf);
		};
	}, []);

	const tree = useMemo(() => {
		// Dotfile filter is client-side only: the daemon scan always returns
		// hidden entries, so the toggle just narrows what the tree builds.
		const visible = showHidden ? (entries ?? []) : (entries ?? []).filter(e => !e.name.startsWith("."));
		return compressTree(buildTree(visible, browseRoot ?? ""));
	}, [entries, showHidden, browseRoot]);
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
		const ok = await confirm(t("settings.discardUnsavedChanges"), t("general.discard"), { destructive: true });
		if (ok) {
			const path = previewPathRef.current;
			if (path) unsavedBufferCache.delete(path);
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
		async (entry: WorkspaceEntry): Promise<boolean> => {
			if (entry.isDir) return false;
			if (!(await confirmDiscard())) return false;
			const request = ++previewRequestRef.current;
			setSelectedPath(entry.path);
			setEdit(null);
			setFileSelection(null);
			setPdfSelection(null);
			previewRegPathRef.current = entry.path;
			const absPath = resolveFilePreviewPath(cwd, entry.path);
			// A cached buffer wins over disk after a pane unmount. Every supported
			// text file opens editable; read-only viewers never seed this state.
			const buffer = restoreFilePreviewBuffer(absPath);
			if (!buffer) unsavedBufferCache.delete(absPath);
			try {
				const res = await rpc.request<{ base64?: string; size?: number; mime?: string; error?: string }>(
					"fs.readBytes",
					{ path: absPath, maxBytes: 32 * 1024 * 1024 },
				);
				if (request !== previewRequestRef.current) return true;
				if (res.error || !res.base64) {
					setPreview({ path: absPath, name: entry.name, size: entry.size, error: res.error ?? "read failed" });
					return true;
				}
				const bytes = Uint8Array.from(atob(res.base64), c => c.charCodeAt(0));
				// Viewer rendering is asynchronous too, so the same epoch guards
				// both the byte response and the decoded/rendered result.
				const ext = extOf(entry.name);
				const result = await renderWithViewerList(viewers, {
					name: entry.name,
					path: absPath,
					size: res.size ?? bytes.length,
					bytes,
					mime: res.mime,
					ext,
				});
				if (request !== previewRequestRef.current) return true;
				if (result === undefined) {
					await window.electronAPI?.openWith("", absPath);
					if (request !== previewRequestRef.current) return true;
					setPreview({ path: absPath, name: entry.name, size: res.size ?? bytes.length, external: true });
					return true;
				}
				const mapped = previewMappingFor(result);
				if (mapped.htmlLiveMode === "live") setHtmlLiveMode("live");
				if (mapped.mdRender === true) setMdRender(true);
				setPreview({ path: absPath, name: entry.name, size: res.size ?? bytes.length, ...mapped.fields });
				if (mapped.editable !== undefined) {
					setEdit(buffer ?? { text: mapped.editable, saved: mapped.editable });
				}
				return true;
			} catch (err) {
				if (request !== previewRequestRef.current) return true;
				setPreview({
					path: absPath,
					name: entry.name,
					size: entry.size,
					error: err instanceof Error ? err.message : String(err),
				});
				return true;
			}
		},
		[rpc, cwd, viewers, confirmDiscard],
	);

	/** In panel mode the tree only registers intent. The selected file tab is
	 *  the sole content loader, which removes the old tree+tab double read. */
	const openFile = useCallback(
		(entry: WorkspaceEntry, opts?: { pin?: boolean; newTab?: boolean }): void => {
			if (entry.isDir) return;
			if (onOpenFile) {
				setSelectedPath(entry.path);
				const absolute = resolveFilePreviewPath(cwd, entry.path);
				if (opts?.newTab && preview && filePreviewBufferKey(preview.path) === filePreviewBufferKey(absolute)) return;
				onOpenFile(entry.path, entry.name, { pin: opts?.pin ?? false, newTab: opts?.newTab ?? false });
				return;
			}
			void openPreview(entry);
		},
		[cwd, onOpenFile, openPreview, preview],
	);

	// The active file tab owns content loading. A cancelled leave-guard rolls
	// the ref back so the declined tab can still be activated later.
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

	// Standalone panes consume external reveals directly. Panel mode already
	// loads the active tab above, so consuming the request again would read twice.
	useEffect(() => {
		if (!openRequest || onOpenFile) return;
		const path = filePreviewWorkspacePath(cwd, openRequest.path);
		const name = path.split(/[\\/]/).pop() ?? path;
		void openPreview({ path, name, size: 0, isDir: false, mtime: 0, depth: 0 });
		// openPreview is stable for the lifetime of one file request.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [openRequest, onOpenFile, cwd]);

	// A markdown FILE preview's relative links open the target here; the
	// hook takes the previewed file's workspace-relative path so the link
	// resolves against its directory, not the workspace root.
	const mdFileNavigation = useCallback(
		(absoluteTarget: string): void => {
			const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
			const rel = absoluteTarget.startsWith(prefix) ? absoluteTarget.slice(prefix.length) : absoluteTarget;
			const name = rel.slice(Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\")) + 1);
			openFile({ path: rel, name, size: 0, isDir: false, mtime: 0, depth: 0 });
		},
		[cwd, openFile],
	);
	const mdPreviewPath = useMemo(
		() =>
			preview && extOf(preview.name) === "md" && preview.path.startsWith(`${cwd}/`)
				? preview.path.slice(cwd.length + 1)
				: null,
		[preview, cwd],
	);
	useMarkdownFileNavigation(bodyRef.current, mdPreviewPath, mdFileNavigation);

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
				openFile({ path: rel, name, isDir: false, size: 0, mtime: 0, depth: 0 }, { pin: true });
			} else if (editing.kind === "new-dir") await rpc.request("fs.mkdir", { cwd, path: rel });
			else await rpc.request("fs.rename", { cwd, from: target!.path, to: rel });
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [editing, editValue, rpc, cwd, load, openFile]);

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

	/** Persist the edited buffer. Monaco supplies its current model text for
	 *  Ctrl+S so a pending React render cannot omit the last edit. The saved
	 *  marker uses that same snapshot; newer typing during fs.write stays dirty. */
	const saveEdit = useCallback(
		async (modelText?: string): Promise<void> => {
			if (!edit || !preview || saving) return;
			const text = modelText ?? edit.text;
			const rel = filePreviewWorkspacePath(cwd, preview.path);
			setSaving(true);
			try {
				const result = await rpc.request<{ ok: boolean; error?: string }>("fs.write", {
					cwd,
					path: rel,
					content: text,
				});
				if (!result.ok) throw new Error(result.error ?? "File save failed");
				setEdit(cur => (cur ? { ...cur, saved: text } : cur));
				unsavedBufferCache.delete(preview.path);
				// Disk save is authoritative. A missing or slow language server must
				// not turn a successful write into a visible save failure.
				void rpc
					.request("editor.saved", { cwd, path: preview.path, content: text }, { timeoutMs: 12_000 })
					.catch(() => {});
				await load();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setSaving(false);
			}
		},
		[edit, preview, cwd, rpc, load, saving],
	);

	const loadPeekFile = useCallback(
		async (path: string): Promise<MonacoPeekBuffer | null> => {
			const absolute = resolveFilePreviewPath(cwd, filePreviewWorkspacePath(cwd, path));
			const cached = unsavedBufferCache.get(absolute);
			if (cached) return { path: absolute, ...cached };
			try {
				const result = await rpc.request<{ base64?: string; size?: number; error?: string }>("fs.readBytes", {
					path: absolute,
				});
				if (result.error || result.base64 === undefined || (result.size ?? 0) > 2 * 1024 * 1024) return null;
				const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0));
				const text = new TextDecoder().decode(bytes);
				return { path: absolute, text, saved: text };
			} catch {
				return null;
			}
		},
		[cwd, rpc],
	);

	const changePeekBuffer = useCallback(
		(buffer: MonacoPeekBuffer): void => {
			const absolute = resolveFilePreviewPath(cwd, filePreviewWorkspacePath(cwd, buffer.path));
			const next = { text: buffer.text, saved: buffer.saved };
			if (buffer.text === buffer.saved) unsavedBufferCache.delete(absolute);
			else unsavedBufferCache.set(absolute, next);
			if (previewPathRef.current === absolute && editBufRef.current) setEdit(next);
			onDirty?.(absolute, buffer.text !== buffer.saved);
		},
		[cwd, onDirty],
	);

	const savePeekFile = useCallback(
		async (path: string, text: string): Promise<boolean> => {
			const absolute = resolveFilePreviewPath(cwd, filePreviewWorkspacePath(cwd, path));
			try {
				const result = await rpc.request<{ ok: boolean; error?: string }>("fs.write", {
					cwd,
					path: filePreviewWorkspacePath(cwd, absolute),
					content: text,
				});
				if (!result.ok) throw new Error(result.error ?? "File save failed");
				if (previewPathRef.current === absolute)
					setEdit(current => (current ? { ...current, saved: text } : current));
				void rpc
					.request("editor.saved", { cwd, path: absolute, content: text }, { timeoutMs: 12_000 })
					.catch(() => {});
				await load();
				return true;
			} catch (reason) {
				setError(reason instanceof Error ? reason.message : String(reason));
				return false;
			}
		},
		[cwd, rpc, load],
	);

	const exportWord = useCallback(async (): Promise<void> => {
		if (!preview || exportingWord) return;
		setExportingWord(true);
		setError(null);
		try {
			await downloadMarkdownDocx(edit?.text ?? preview.raw ?? preview.text ?? "", preview.name);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setExportingWord(false);
		}
	}, [preview, edit?.text, exportingWord]);

	/** Quote the latest Monaco selection. Read-only previews can still supply a
	 * DOM selection; with neither, the header action quotes the whole file. */
	const appendFileQuote = useCallback(
		(selection: FileEditorSelection | PdfEditorSelection | null): void => {
			if (!preview) return;
			const pdfSelection = selection && "anchor" in selection ? selection : null;
			const codeSelection = selection && !("anchor" in selection) ? selection : null;
			const dom = selection ? null : captureSelectionContext();
			const domMatch = dom?.file?.path === preview.path ? dom : null;
			const quote =
				selection?.text ?? domMatch?.text ?? edit?.text ?? preview.raw ?? preview.text ?? preview.htmlLive ?? "";
			const startLine = codeSelection?.startLine ?? domMatch?.file?.startLine;
			const endLine = codeSelection?.endLine ?? domMatch?.file?.endLine;
			const displayContext = createFileQuoteContext({
				path: filePreviewWorkspacePath(cwd, preview.path),
				quote,
				language: codeSelection?.language ?? domMatch?.file?.language ?? extOf(preview.name),
				...(startLine !== undefined && endLine !== undefined ? { startLine, endLine } : {}),
				...(pdfSelection
					? { pdf: { ...pdfSelection.anchor, fileSize: preview.size } }
					: {}),
			});
			window.dispatchEvent(
				new CustomEvent("musepi-gui-quote-append", {
					detail: { text: selection?.text ?? domMatch?.text ?? "", displayContext },
				}),
			);
		},
		[preview, edit?.text, cwd],
	);

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
			label: t("settings.newFile"),
			icon: "file-add",
			onSelect: () => startNewFile(parentDir, parentDepth + (entry.isDir ? 1 : 1)),
		});
		items.push({
			label: t("settings.newFolder"),
			icon: "folder-add",
			onSelect: () => startNewDir(parentDir, parentDepth + (entry.isDir ? 1 : 1)),
		});
		items.push({ divider: true });
		if (!entry.isDir) {
			items.push({ label: t("general.openPreview"), icon: "eye", onSelect: () => openFile(entry) });
			items.push({
				label: t("general.openApp"),
				icon: "external-link",
				onSelect: () => void window.electronAPI?.openWith("", `${cwd}/${entry.path}`),
			});
		}
		items.push({ label: t("settings.rename"), icon: "pencil", onSelect: () => startRename(entry, depth) });
		items.push({ label: t("settings.copyPath"), icon: "clipboard", onSelect: () => void copyPath(entry) });
		items.push({ divider: true });
		items.push({
			label: ctx.confirmDelete ? t("settings.confirmDelete") : t("settings.delete"),
			icon: "delete-bin",
			danger: true,
			onSelect: () => {
				if (ctx.confirmDelete) void confirmDelete();
				else setCtx({ ...ctx, confirmDelete: true });
			},
		});
		items.push({ label: t("settings.refresh"), icon: "refresh", onSelect: () => void load() });
		return items;
	}, [ctx, openFile, copyPath, load, startNewFile, startNewDir, startRename, confirmDelete, cwd]);

	const renderRow = (row: { node: TreeNode; depth: number }, posInSet?: number, setSize?: number): ReactNode => {
		const { node, depth } = row;
		const { entry } = node;
		const isDir = entry.isDir;
		const closed = isDir && collapsed.has(entry.path);
		const selected = selectedPath === entry.path;
		const indent = (depth - 1) * 14;
		// A hover action opens the entry in
		// the OS default app (folder → Explorer/Finder, file → default app).
		const openInApp = (
			<button
				type="button"
				className="gui-filepane-open-btn"
				title={t("general.openApp")}
				aria-label={t("general.openApp")}
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
					onClick={() => openFile(entry, { pin: false, newTab: activeFile !== null })}
					onDoubleClick={() => openFile(entry, { pin: true, newTab: activeFile !== null })}
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
				placeholder={editing.kind === "new-dir" ? t("settings.newFolder") : t("settings.newFile")}
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

	const fileTree = entries ? (
		<div
			className={`gui-filepane-list${preview ? " gui-filepane-list--inline" : ""}`}
			ref={listRef}
			onScroll={ev => setScrollTop(ev.currentTarget.scrollTop)}
			role="tree"
			aria-hidden={preview ? !treeExpanded : undefined}
			inert={preview ? !treeExpanded : undefined}
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
	) : null;

	return (
		<div className="gui-filepane">
			<div className="gui-filepane-head">
				<span className="gui-sidebar-title">{t("settings.files2")}</span>
				<div className="gui-filepane-actions">
					<button
						className="gui-btn gui-btn-icon"
						type="button"
						title={t("settings.newFile")}
						onClick={() => startNewFile("", 1)}
					>
						<FilePlus size={12} />
					</button>
					<button
						className="gui-btn gui-btn-icon"
						type="button"
						title={t("settings.newFolder")}
						onClick={() => startNewDir("", 1)}
					>
						<FolderPlus size={12} />
					</button>
					<label className="gui-filepane-search" title={t("settings.searchFiles")}>
						<Search size={12} className="gui-filepane-search-icon" />
						<input
							type="text"
							value={query}
							placeholder={t("settings.search")}
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
						title={t("general.showGitignored")}
						aria-label={t("general.showGitignored")}
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
						title={t("general.showHiddenFiles")}
						aria-label={t("general.showHiddenFiles")}
						aria-pressed={showHidden}
						onClick={() => {
							const next = !showHidden;
							setShowHidden(next);
							writeShowHidden(next);
						}}
					>
						{showHidden ? <ScanEye size={12} /> : <EyeOff size={12} />}
					</button>
					<button
						className="gui-btn gui-btn-icon"
						type="button"
						onClick={() => void load()}
						title={t("settings.refresh")}
					>
						<RefreshCw size={12} />
					</button>
				</div>
			</div>
			{/* Working-dir breadcrumb. */}
			<div className="gui-filepane-path" title={cwd}>
				<span className="gui-filepane-path-root">~/</span>
				<span className="truncate">{cwd.replace(/^\/Users\/[^/]+\//, "")}</span>
			</div>
			{error && <p className="gui-error">{error}</p>}
			{!entries && !error && <p className="gui-filepane-empty">{t("settings.loading2")}</p>}
			<div className="gui-filepane-body">
				{!preview && fileTree}
				{preview && (
					<div className="gui-filepane-preview">
						<div className="gui-filepane-preview-head">
							<button
								type="button"
								className="gui-btn gui-btn-icon gui-filepane-history-back"
								title={t("settings.editorBack")}
								aria-label={t("settings.editorBack")}
								disabled={!canNavigateBack}
								onClick={() => onNavigateBack?.()}
							>
								<Icon name="arrow-left" />
							</button>
							<button
								type="button"
								className="gui-btn gui-btn-icon gui-filepane-history-forward"
								title={t("settings.editorForward")}
								aria-label={t("settings.editorForward")}
								disabled={!canNavigateForward}
								onClick={() => onNavigateForward?.()}
							>
								<Icon name="arrow-right" />
							</button>
							<button
								type="button"
								className={`gui-btn gui-btn-icon gui-filepane-tree-toggle${treeExpanded ? " gui-btn-icon--active" : ""}`}
								title={t("settings.toggleFileTree")}
								aria-label={t("settings.toggleFileTree")}
								aria-expanded={treeExpanded}
								onClick={() => setTreeExpanded(value => !value)}
							>
								<PanelLeft size={12} />
							</button>
							<FileBreadcrumb
								cwd={cwd}
								path={preview.path}
								name={preview.name}
								onOpenDirectory={(directory, anchor) => {
									setDirectoryPath(directory);
									setDirectoryAnchor(anchor);
								}}
							/>
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
										{t("tools.artifactManifestInvalid")}
									</span>
								) : (
									<span
										className="gui-filepane-artifact-badge"
										title={
											preview.artifact.exports?.length
												? t("tools.artifactExportsHint", { exports: preview.artifact.exports.join(", ") })
												: t("tools.artifactBadgeHint", { kind: preview.artifact.kind })
										}
									>
										{preview.artifact.kind} · {preview.artifact.renderer}
									</span>
								))}
							{extOf(preview.name) === "md" && preview.text !== undefined && (
								<Segmented
									className="gui-seg--compact"
									ariaLabel={t("companion.preview")}
									value={mdRender ? "rendered" : "source"}
									options={MD_VIEW_SEGMENTS}
									onChange={value => {
										if (value === "source") {
											const latest = markdownEditorRef.current?.getMarkdown();
											if (latest != null) updateEditText(latest);
										}
										setMdRender(value === "rendered");
										setFileSelection(null);
									}}
								/>
							)}
							{preview.htmlLive !== undefined && (
								<Segmented
									className="gui-seg--compact"
									ariaLabel={t("companion.preview")}
									value={htmlLiveMode}
									options={HTML_VIEW_SEGMENTS}
									onChange={value => setHtmlLiveMode(value === "source" ? "source" : "live")}
								/>
							)}
							<span className="gui-filepane-preview-tools">
								{extOf(preview.name) === "md" && (
									<button
										type="button"
										className="gui-btn gui-btn-icon gui-filepane-export-word"
										title={t(exportingWord ? "settings.exportingWord" : "settings.exportWord")}
										aria-label={t("settings.exportWord")}
										disabled={exportingWord}
										onClick={() => void exportWord()}
									>
										<Download size={12} />
									</button>
								)}
								<button
									type="button"
									className="gui-btn gui-btn-icon"
									title={t("settings.copyPath")}
									onClick={() => {
										window.electronAPI?.copyText(preview.path).catch(() => {});
									}}
								>
									<ClipboardCopy size={12} />
								</button>
								<button
									type="button"
									className="gui-btn gui-btn-icon gui-filepane-quote"
									title={t("general.citeFileComposer")}
									aria-label={t("general.citeFileComposer")}
									onMouseDown={event => event.preventDefault()}
									onClick={() =>
										appendFileQuote(pdfSelection ?? (extOf(preview.name) === "md" && mdRender ? null : fileSelection))
									}
								>
									<Quote size={12} />
								</button>
								<button
									type="button"
									className="gui-btn gui-btn-icon"
									title={t("settings.openDefaultApp")}
									onClick={() => {
										window.electronAPI?.openWith("", preview.path).catch(() => {});
									}}
								>
									<ExternalLink size={12} />
								</button>
								<FileOpenWith path={preview.path} />
							</span>
							<button
								type="button"
								className="gui-btn gui-btn-icon"
								title={t("settings.close")}
								onClick={() => {
									if (onClosePreview) onClosePreview();
									else
										void confirmDiscard().then(ok => {
											if (ok) setPreview(null);
										});
								}}
							>
								✕
							</button>
						</div>
						<div className={`gui-filepane-preview-main${treeExpanded ? " gui-filepane-preview-main--tree-open" : ""}`}>
							{fileTree}
							<div
								className="gui-filepane-preview-body"
								ref={bodyRef}
							data-file-path={preview.path}
							data-file-language={extOf(preview.name)}
						>
							{preview.error && <p className="gui-error">{preview.error}</p>}
							{preview.htmlLive !== undefined && !edit && <HtmlPreview source={preview.htmlLive} />}
							{preview.html !== undefined && !edit && (
								<pre className="gui-filepane-preview-text" dangerouslySetInnerHTML={{ __html: preview.html }} />
							)}
							{preview.text !== undefined && extOf(preview.name) === "md" && mdRender && !edit ? (
								<div className="gui-filepane-preview-md" ref={mdPreviewRef}>
									<Markdown text={preview.text} basePath={cwd} />
								</div>
							) : preview.text !== undefined && !edit ? (
								<pre className="gui-filepane-preview-text">{preview.text}</pre>
							) : null}
							{edit && extOf(preview.name) === "md" && mdRender && hasYamlFrontMatter(edit.text) && (
								<div className="gui-filepane-markdown-warning" role="note">
									<span>{t("markdownFrontMatterWarning")}</span>
									<button
										type="button"
										className="gui-btn gui-btn-sm"
										onClick={() => {
											const latest = markdownEditorRef.current?.getMarkdown();
											if (latest != null) updateEditText(latest);
											setMdRender(false);
											setFileSelection(null);
										}}
									>
										{t("settings.sourceCode")}
									</button>
								</div>
							)}
							{edit && (
								<div
									className={`gui-filepane-edit-layout${
										preview.htmlLive !== undefined && htmlLiveMode === "live"
											? " gui-filepane-edit-layout--live-preview"
											: ""
									}`}
								>
									<FileEditor
										rpc={rpc}
										cwd={cwd}
										path={preview.path}
										value={edit.text}
										name={preview.name}
										dirty={dirty}
										saving={saving}
										markdownVisual={extOf(preview.name) === "md" && mdRender}
										markdownEditorRef={markdownEditorRef}
										onMarkdownError={message => {
											setError(message);
											setMdRender(false);
											setFileSelection(null);
										}}
										onNavigate={(source, target) => {
											if (onEditorNavigate) {
												onEditorNavigate(source, target);
												return;
											}
											if (source.path === target.path) return;
											openFile(
												{
													path: target.path,
													name: target.path.slice(
														Math.max(target.path.lastIndexOf("/"), target.path.lastIndexOf("\\")) + 1,
													),
													size: 0,
													isDir: false,
													mtime: 0,
													depth: 0,
												},
												{ pin: true, newTab: true },
											);
										}}
										onChange={updateEditText}
										onSave={text => void saveEdit(text)}
										onPositionChange={location => onEditorPositionChange?.(location)}
										onHistoryBack={() => onNavigateBack?.()}
										onHistoryForward={() => onNavigateForward?.()}
										onLoadFile={loadPeekFile}
										onSaveFile={savePeekFile}
										onBufferChange={changePeekBuffer}
										onSelectionChange={setFileSelection}
									/>
									{preview.htmlLive !== undefined && htmlLiveMode === "live" && (
										<HtmlPreview source={edit.text} />
									)}
								</div>
							)}
							{preview.docxBytes && <DocxPreview data={preview.docxBytes} path={preview.path} />}
							{preview.officeSheets && <SheetPreview name={preview.name} sheets={preview.officeSheets} />}
							{preview.media && (
								<MediaPreview kind={preview.media.kind} url={preview.media.url} name={preview.name} />
							)}
							{preview.fontUrl && <FontPreview url={preview.fontUrl} name={preview.name} />}
							{preview.mermaidSource !== undefined && <MermaidPreview source={preview.mermaidSource} />}
							{preview.imageUrl && (
								<ImagePreview
									src={preview.imageUrl}
									name={preview.name}
									onOpenLightbox={() => setLightbox({ src: preview.imageUrl!, name: preview.name })}
								/>
							)}
							{preview.pdfBytes && (
								<Suspense fallback={<div className="gui-pdf-status">{t("settings.pdfLoading")}</div>}>
									<FilePdfPreview
										data={preview.pdfBytes}
										name={preview.name}
										path={preview.path}
										onSelection={setPdfSelection}
										restore={
											openRequest?.pdf
												? { anchor: openRequest.pdf, quote: openRequest.quote ?? "", nonce: openRequest.nonce }
												: undefined
										}
									/>
								</Suspense>
							)}
							{preview.external && (
								<p className="gui-filepane-preview-note">
									{t("general.openedDefaultApp")} — {preview.size.toLocaleString()} B
								</p>
							)}
							</div>
						</div>
					</div>
				)}
			</div>
			<SelectionToolbar
				containerRef={bodyRef}
				avoidSelector='.milkdown-toolbar[data-show="true"]'
				selection={
					preview?.pdfBytes
						? pdfSelection
							? { ...pdfSelection, pdf: pdfSelection.anchor }
							: null
						: edit && !(preview && extOf(preview.name) === "md" && mdRender)
							? fileSelection
							: undefined
				}
				onQuote={(text, pdf) =>
					appendFileQuote(pdf && pdfSelection ? { ...pdfSelection, text, anchor: pdf } : fileSelection)
				}
				onAsk={(text, x, y) => window.dispatchEvent(new CustomEvent("musepi-gui-ask", { detail: { text, x, y } }))}
				onCopy={text => {
					const copy = window.electronAPI?.copyText(text);
					if (copy) void copy.catch(() => {});
					else void navigator.clipboard?.writeText(text);
				}}
				onNewSession={text => onNewSession?.(text)}
				onAddNote={text => {
					if (!preview) return;
					const path = filePreviewWorkspacePath(cwd, preview.path);
					const location = pdfSelection
						? `\n\n\`${path}#pages=${pdfSelection.anchor.startPage}-${pdfSelection.anchor.endPage}\``
						: fileSelection
							? `\n\n\`${path}:${fileSelection.startLine}-${fileSelection.endLine}\``
							: "";
					void rpc
						.request("notes.create", { cwd, body: `> ${text}${location}` })
						.then(() => window.dispatchEvent(new CustomEvent("musepi-notes-changed")))
						.catch(() => {});
				}}
			/>
			<ContextMenu
				open={ctx !== null}
				x={ctx?.x ?? 0}
				y={ctx?.y ?? 0}
				items={menuItems}
				onClose={() => setCtx(null)}
			/>
			<FileDirectoryMenu
				rpc={rpc}
				cwd={cwd}
				path={directoryPath}
				anchor={directoryAnchor}
				open={directoryPath !== null}
				onClose={() => setDirectoryPath(null)}
				onOpenFile={(path, name) => openFile({ ...syntheticEntry(path), name }, { pin: false, newTab: true })}
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

/** Clickable workspace-relative ancestors plus the current file name. Files
 * outside the workspace keep a plain name because workspace.tree cannot list
 * their parent directories. */
function FileBreadcrumb({
	cwd,
	path,
	name,
	onOpenDirectory,
}: {
	cwd: string;
	path: string;
	name: string;
	onOpenDirectory(path: string, anchor: HTMLElement): void;
}): ReactNode {
	const relative = filePreviewWorkspacePath(cwd, path);
	const outside = path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
	const parts = relative === path && outside ? [name] : relative.split("/").filter(Boolean);
	const scrollRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		const element = scrollRef.current;
		if (element) element.scrollLeft = element.scrollWidth;
	}, [path, cwd]);
	return (
		<nav ref={scrollRef} className="gui-filepane-preview-path" aria-label={path}>
			{parts.length > 1 && (
				<>
					<button
						type="button"
						className="gui-filepane-path-part"
						title={cwd}
						onClick={event => onOpenDirectory("", event.currentTarget)}
					>
						<Folder size={11} />
					</button>
					{parts.slice(0, -1).map((part, index) => {
						const directory = parts.slice(0, index + 1).join("/");
						return (
							<span className="gui-filepane-path-segment" key={directory}>
								<span aria-hidden="true">/</span>
								<button
									type="button"
									className="gui-filepane-path-part"
									title={directory}
									onClick={event => onOpenDirectory(directory, event.currentTarget)}
								>
									{part}
								</button>
							</span>
						);
					})}
					<span aria-hidden="true">/</span>
				</>
			)}
			<span className="gui-filepane-preview-name" title={path}>
				{parts.at(-1) ?? name}
			</span>
		</nav>
	);
}

/** HTML file preview: a sandboxed live page. The file header owns the
 * live/source switch so editable and read-only files share one control. */
function HtmlPreview({ source }: { source: string }): ReactNode {
	return (
		<div className="gui-filepane-preview-html">
			<iframe
				className="gui-filepane-preview-html-frame"
				title={t("companion.preview")}
				sandbox="allow-scripts"
				srcDoc={source}
			/>
		</div>
	);
}

/** Editable file surface. FilePane owns saving, dirty state, and drafts;
 * Monaco owns code and Crepe owns single-column visual Markdown. */
function FileEditor({
	rpc,
	cwd,
	path,
	value,
	name,
	dirty,
	saving,
	markdownVisual,
	markdownEditorRef,
	onMarkdownError,
	onChange,
	onSave,
	onNavigate,
	onPositionChange,
	onHistoryBack,
	onHistoryForward,
	onLoadFile,
	onSaveFile,
	onBufferChange,
	onSelectionChange,
}: {
	rpc: RpcClient;
	cwd: string;
	path: string;
	value: string;
	name: string;
	dirty: boolean;
	saving: boolean;
	markdownVisual: boolean;
	markdownEditorRef: { current: FileMarkdownEditorHandle | null };
	onMarkdownError(message: string): void;
	onChange(text: string): void;
	onSave(text?: string): void;
	onNavigate(source: EditorLocation, target: EditorLocation): void;
	onPositionChange(location: EditorLocation): void;
	onHistoryBack(): void;
	onHistoryForward(): void;
	onLoadFile(path: string): Promise<MonacoPeekBuffer | null>;
	onSaveFile(path: string, text: string): Promise<boolean>;
	onBufferChange(buffer: MonacoPeekBuffer): void;
	onSelectionChange(selection: FileEditorSelection | null): void;
}): ReactNode {
	return (
		<div className="gui-filepane-editor">
			{markdownVisual ? (
				<FileMarkdownEditor
					ref={markdownEditorRef}
					path={path}
					name={name}
					value={value}
					onChange={onChange}
					onSave={onSave}
					onError={onMarkdownError}
				/>
			) : (
				<FileCodeEditor
					rpc={rpc}
					cwd={cwd}
					path={path}
					value={value}
					name={name}
					onChange={onChange}
					onSave={onSave}
					onNavigate={onNavigate}
					onPositionChange={onPositionChange}
					onHistoryBack={onHistoryBack}
					onHistoryForward={onHistoryForward}
					onLoadFile={onLoadFile}
					onSaveFile={onSaveFile}
					onBufferChange={onBufferChange}
					onSelectionChange={onSelectionChange}
				/>
			)}
			<div className="gui-filepane-editor-foot">
				<button
					type="button"
					className="gui-btn gui-btn-sm"
					disabled={saving}
					onClick={() => onSave()}
					title={t("general.save")}
				>
					<Save size={12} />
					{t("general.save")}
				</button>
				<span className="gui-panel-muted">{t("settings.cmdSSave")}</span>
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
			{t("guest.cannotPreviewFile")} —{" "}
			<button
				type="button"
				className="gui-btn gui-btn-sm"
				onClick={() => window.electronAPI?.openWith("", path).catch(() => {})}
			>
				{t("settings.openDefaultApp")}
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
				<p className="gui-filepane-preview-note">
					{t("settings.onlyFirstRowsShownWithN", { n: OFFICE_SHEET_ROWS })}
				</p>
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
	if (rows.length > 0) {
		lines.push("<thead><tr>");
		for (const cell of rows[0]) lines.push(`<th>${escapeCell(cell)}</th>`);
		lines.push("</tr></thead>");
	}
	lines.push("<tbody>");
	for (const row of rows.slice(1)) {
		lines.push("<tr>");
		for (const cell of row) lines.push(`<td>${escapeCell(cell)}</td>`);
		lines.push("</tr>");
	}
	lines.push("</tbody></table>");
	return lines.join("");
}
