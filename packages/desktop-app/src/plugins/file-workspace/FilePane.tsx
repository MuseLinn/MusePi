import { highlightToCodeHtml, ImageLightbox, Markdown, Segmented, type SegmentedOption, t } from "@musepi/client-core";
import { createFileQuoteContext } from "@musepi/client-core/src/messages/display-context";
import { renderAsync as renderDocx } from "docx-preview";
import {
	Eye as EyeIconData,
	EyeOff as EyeOffIconData,
	Folder as FolderIconData,
	FolderOpen as FolderOpenIconData,
	ScanEye as ScanEyeIconData,
} from "lucide";
import {
	ChevronDown,
	ClipboardCopy,
	Download,
	ExternalLink,
	FileArchive,
	FileAudio,
	FileCode,
	FileCog,
	File as FileIcon,
	FileImage,
	FileJson,
	FileLock,
	FilePlus,
	FileSpreadsheet,
	FileText,
	FileType,
	FileVideo,
	Folder,
	FolderPlus,
	Link2,
	PanelLeft,
	PanelRight,
	Presentation,
	Quote,
	RefreshCw,
	Save,
	Search,
} from "lucide-react";
import { MorphIcon } from "morphicons/react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { ContextMenu, type ContextMenuItem } from "../../components/ContextMenu";
import { FileCodeEditor, type FileEditorSelection } from "../../components/FileCodeEditor";
import { FileDirectoryMenu } from "../../components/FileDirectoryMenu";
import {
	FileMarkdownEditor,
	type FileMarkdownEditorHandle,
	hasYamlFrontMatter,
} from "../../components/FileMarkdownEditor";
import { FileOfficePreview, type OfficeEditorSelection } from "../../components/FileOfficePreview";
import { FileOpenWith } from "../../components/FileOpenWith";
import { ImagePreview } from "../../components/FilePaneImagePreview";
import { useMarkdownFileNavigation } from "../../components/FilePaneMarkdownNav";
import { FontPreview, MediaPreview, MermaidPreview } from "../../components/FilePanePreviews";
import type { PdfEditorSelection } from "../../components/FilePdfPreview";
import { SelectionToolbar } from "../../components/SelectionToolbar";
import { dismissActionToastSource, pushActionToast } from "../../lib/action-toast";
import { owningArtifact, useArtifactIndex } from "../../lib/artifact-index";
import { type BuiltinViewerDeps, builtinFileViewers } from "../../lib/builtin-file-viewers";
import type { EditorLocation } from "../../lib/editor-navigation";
import { openExternalUrl } from "../../lib/electron";
import { listFileViewers, orderViewers, renderWithViewerList } from "../../lib/file-viewers";
import {
	type FilePreviewBufferStore,
	filePreviewPathEquals,
	filePreviewWorkspacePath,
	panelBrowserPreviewUrl,
	resolveFilePreviewPath,
	type WorkspaceEntry,
} from "../../lib/file-workspace";
import {
	onGitPrefsChanged,
	readShowHidden,
	readShowIgnored,
	writeShowHidden,
	writeShowIgnored,
} from "../../lib/git-prefs";
import { useChatHighlight } from "../../lib/highlight";
import { htmlPreviewRequiresBuild, inlineHtmlPreviewStyles, withHtmlPreviewBase } from "../../lib/html-preview";
import { downloadMarkdownDocx } from "../../lib/markdown-docx";
import { type MonacoPeekBuffer, revealEditorLocation } from "../../lib/monaco-lsp";
import { type OfficeDraft, parseOfficeDraft, serializeOfficeDraft, writeOfficeDraft } from "../../lib/office-documents";
import { previewMappingFor } from "../../lib/preview-from-viewer";
import { pathBaseName } from "../../lib/project-label";
import { useConfirm } from "../../lib/prompt-dialog";
import type { RpcClient } from "../../lib/rpc";
import { captureSelectionContext } from "../../lib/selection-capture";
import { directoriesEqual } from "../../lib/workspace-projects";
import { Icon } from "../../vendor/oc-icons";
import "../../styles/gui-file-workspace.css";

export type { WorkspaceEntry };
export { filePreviewPathEquals, filePreviewWorkspacePath, resolveFilePreviewPath };

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
const FilePdfPreview = lazy(() => import("../../components/FilePdfPreview"));

interface PreviewState {
	path: string;
	name: string;
	size: number;
	text?: string;
	raw?: string;
	html?: string;
	htmlLive?: string;
	imageUrl?: string;
	pdfBytes?: ArrayBuffer;
	docxBytes?: ArrayBuffer;
	office?: { bytes: Uint8Array<ArrayBuffer>; draft: OfficeDraft };
	officeSheets?: ReadonlyArray<{ name: string; html: string; truncated: boolean }>;
	media?: { kind: "audio" | "video"; url: string };
	fontUrl?: string;
	mermaidSource?: string;
	error?: string;
	external?: boolean;
	artifact?: { kind: string; renderer: string; exports?: string[]; errors?: string[] };
}

const OFFICE_SHEET_ROWS = 1000;
/** Virtual row height — must match --gui-file-row-h in gui-file-workspace.css. */
const ROW_H = 28;
const ROW_BUFFER = 6;
/** Indent per tree level; the disclosure/icon gutter is reserved inside each
 *  row, so only this step moves the text column. */
const TREE_INDENT = 14;

interface TreeNode {
	entry: WorkspaceEntry;
	children: TreeNode[];
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

/** Build the tree from the flat scan without promoting orphaned descendants. */
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
	for (const e of dirs) byPath.set(e.path, { entry: e, children: [], label: e.name });
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

function syntheticEntry(path: string): WorkspaceEntry {
	return { path, name: path.split(/[\\/]/).pop() ?? path, isDir: false, size: 0, mtime: 0, depth: 0 };
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

const CODE_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"mts",
	"cts",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"rs",
	"go",
	"py",
	"rb",
	"java",
	"kt",
	"kts",
	"swift",
	"php",
	"lua",
	"sh",
	"bash",
	"zsh",
	"fish",
	"ps1",
	"sql",
	"css",
	"scss",
	"sass",
	"less",
	"html",
	"htm",
	"xml",
	"vue",
	"svelte",
	"astro",
	"c",
	"h",
	"cc",
	"cpp",
	"hpp",
	"cs",
	"dart",
	"clj",
	"cljs",
	"ex",
	"exs",
	"hs",
	"scala",
	"zig",
]);
const CONFIG_EXTENSIONS = new Set(["toml", "ini", "conf", "cfg", "env", "properties", "yaml", "yml"]);
const DATA_EXTENSIONS = new Set(["json", "jsonc", "json5", "lock"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);
const TEXT_EXTENSIONS = new Set(["md", "markdown", "mdx", "txt", "log", "rst"]);
const FONT_EXTENSIONS = new Set(["ttf", "otf", "woff", "woff2"]);
const SHEET_EXTENSIONS = new Set(["xlsx", "xls", "csv", "tsv", "ods"]);
const DOC_EXTENSIONS = new Set(["docx", "doc", "odt", "rtf"]);
const SLIDE_EXTENSIONS = new Set(["pptx", "ppt", "key", "odp"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "rar", "7z", "zst"]);

/** Extension-aware file glyph: one recognizable family per row keeps the
 *  tree scannable without labelling every file. */
function TypeIcon({ name }: { name: string }): ReactElement {
	const ext = extOf(name);
	let IconCmp = FileIcon;
	if (CODE_EXTENSIONS.has(ext)) IconCmp = FileCode;
	else if (CONFIG_EXTENSIONS.has(ext)) IconCmp = FileCog;
	else if (DATA_EXTENSIONS.has(ext)) IconCmp = ext === "lock" ? FileLock : FileJson;
	else if (IMAGE_EXTENSIONS.has(ext)) IconCmp = FileImage;
	else if (SHEET_EXTENSIONS.has(ext)) IconCmp = FileSpreadsheet;
	else if (SLIDE_EXTENSIONS.has(ext)) IconCmp = Presentation;
	else if (DOC_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext)) IconCmp = FileText;
	else if (FONT_EXTENSIONS.has(ext)) IconCmp = FileType;
	else if (AUDIO_EXTENSIONS.has(ext)) IconCmp = FileAudio;
	else if (VIDEO_EXTENSIONS.has(ext)) IconCmp = FileVideo;
	else if (ARCHIVE_EXTENSIONS.has(ext)) IconCmp = FileArchive;
	return <IconCmp size={14} strokeWidth={1.8} className="gui-filepane-icon" aria-hidden="true" />;
}

/** Link marker for symlink rows. A followed directory link expands through the
 *  same collapse state as any other folder; the badge keeps the indirection
 *  visible and its tooltip names the raw target. */
function SymlinkBadge({ entry }: { entry: WorkspaceEntry }): ReactElement | null {
	if (!entry.isSymlink) return null;
	const label = entry.linkTarget
		? t("tools.fileTreeSymlinkTarget", { target: entry.linkTarget })
		: t("tools.fileTreeSymlink");
	return (
		<span
			className="gui-filepane-symlink"
			role="img"
			aria-label={label}
			title={label}
			style={{ display: "inline-flex", flex: "0 0 auto", color: "var(--color-text-faint)" }}
		>
			<Link2 size={11} aria-hidden="true" />
		</span>
	);
}

/** Directory that relative Markdown media and links resolve against. */
function parentDirectory(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const slash = normalized.lastIndexOf("/");
	if (slash < 0) return normalized;
	return slash === 0 ? "/" : normalized.slice(0, slash);
}

function isAbsoluteFilePath(path: string): boolean {
	return path.startsWith("file://") || /^([A-Za-z]:[\\/]|[\\/])/.test(path);
}

/** Join a relative reference onto a directory (collapse `.`/`..`). */
function joinFilePath(directory: string, reference: string): string {
	const parts = directory.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
	for (const segment of reference.replace(/\\/g, "/").split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (parts.length > 1) parts.pop();
			continue;
		}
		parts.push(segment);
	}
	return parts.join("/");
}

/** Bounded data-URL cache: README images repeat across previews and a file
 *  page remounts whenever its panel tab is re-activated. */
const PREVIEW_IMAGE_CACHE = new Map<string, string>();
const PREVIEW_IMAGE_CACHE_MAX = 80;

function readHtmlAttribute(tag: string, name: string): string | null {
	const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
	if (!match) return null;
	return match[1] ?? match[2] ?? match[3] ?? "";
}

function markdownDestination(value: string): string {
	const trimmed = value.trim();
	return /[\s()<>]/.test(trimmed) ? `<${trimmed.replace(/[<>]/g, "")}>` : trimmed;
}

/** Turn README-style raw HTML inside Markdown into Markdown itself. The
 *  shared renderer escapes raw HTML on purpose (chat safety), so a file
 *  preview of text like `<img src="./shot.png">` would otherwise show the
 *  tag. Only images, links and `<br>` are translated; fenced and inline code
 *  are preserved verbatim. */
function normalizeMarkdownHtml(text: string): string {
	// A pathological file (multi-MB, many unclosed tags) is not worth the
	// rewrite: leave it to the shared renderer's escaping.
	if (text.length > 2_000_000) return text;
	const fenced: string[] = [];
	const withoutFences = text.replace(
		/(^[ \t]{0,3}(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]{0,3}(?:`{3,}|~{3,})[^\n]*$)/gm,
		match => {
			const token = `\u0000fence${fenced.length}\u0000`;
			fenced.push(match);
			return token;
		},
	);
	const inlineCode: string[] = [];
	const withoutCode = withoutFences.replace(/(`+[^`\n]*?`+)/g, match => {
		const token = `\u0000code${inlineCode.length}\u0000`;
		inlineCode.push(match);
		return token;
	});
	const converted = withoutCode
		.replace(/<img\b[^>]*>/gi, tag => {
			const src = readHtmlAttribute(tag, "src");
			if (!src) return "";
			const alt = (readHtmlAttribute(tag, "alt") ?? "").replace(/[\r\n]+/g, " ").replace(/[[\]]/g, "");
			return `![${alt}](${markdownDestination(src)})`;
		})
		.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (tag, inner: string) => {
			const href = readHtmlAttribute(tag, "href");
			if (!href) return inner;
			const label = inner.replace(/\s+/g, " ").trim();
			return label === "" ? "" : `[${label}](${markdownDestination(href)})`;
		})
		// Layout wrappers a README uses to centre a badge block: the Markdown
		// renderer has no alignment, so keep the content and drop the tags
		// rather than printing them.
		.replace(/<\/?(?:p|div|center|picture)\b[^>]*>/gi, "")
		.replace(/<source\b[^>]*>/gi, "")
		.replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi, (_tag, inner: string) => {
			const label = inner.replace(/\s+/g, " ").trim();
			return label === "" ? "" : `\n\n**${label}**\n\n`;
		})
		.replace(/<\/?details\b[^>]*>/gi, "")
		.replace(/<kbd\b[^>]*>([\s\S]*?)<\/kbd>/gi, (_tag, inner: string) => `\`${inner.replace(/`/g, "")}\``)
		.replace(/<br\s*\/?>/gi, "\n");
	return converted
		.replace(/\u0000code(\d+)\u0000/g, (_match, index: string) => inlineCode[Number(index)] ?? "")
		.replace(/\u0000fence(\d+)\u0000/g, (_match, index: string) => fenced[Number(index)] ?? "");
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

/** An absolute path (POSIX, UNC, or Windows drive) rather than a
 *  workspace-relative tree path. */
function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}

/** Whether a pane path belongs to `root`. Workspace-relative paths always do;
 *  absolute paths must sit inside it (Windows/UNC compare case-insensitively). */
function pathInsideRoot(root: string, path: string): boolean {
	if (!isAbsolutePath(path)) return true;
	const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
	const candidate = path.replace(/\\/g, "/");
	const windows = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\");
	return windows ? candidate.toLowerCase().startsWith(`${base.toLowerCase()}/`) : candidate.startsWith(`${base}/`);
}

export function FilePane({
	rpc,
	cwd: primaryCwd,
	root: activeRoot = null,
	roots = [],
	onRootChange,
	bufferStore,
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
	/** Session primary directory (workspace root of the session). */
	cwd: string;
	/** Directory this pane currently browses: the primary root or one of the
	 *  session's additional working directories. */
	root?: string | null;
	/** Selectable roots (primary first), offered by the host. Fewer than two
	 *  hides the root switcher. */
	roots?: readonly string[];
	onRootChange?(root: string): void;
	bufferStore: FilePreviewBufferStore;
	/** External reveal (artifact cards / transcript paths): preview this
	 *  path via the same pipeline as a tree click. */
	openRequest?: {
		path: string;
		nonce: number;
		pdf?: PdfEditorSelection["anchor"];
		office?: OfficeEditorSelection["anchor"];
		quote?: string;
		line?: number;
		column?: number;
		pin?: boolean;
	} | null;
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
	// A session can expose several working directories. `cwd` below is the
	// directory this pane reads and writes through; every path rule (fs RPCs,
	// preview resolution, save) is workspace-relative to it. Tab identity stays
	// the primary root, which is why files opened from an additional root are
	// registered by absolute path (see `openFile`).
	const cwd = activeRoot && activeRoot !== primaryCwd ? activeRoot : primaryCwd;
	/** Floating menu position for the breadcrumb root switcher (null = closed). */
	const [rootMenu, setRootMenu] = useState<{ x: number; y: number } | null>(null);
	// Keep the existing editor code on one injected, host-owned draft lifecycle.
	const unsavedBufferCache = bufferStore;
	const stashFilePreviewBuffer = bufferStore.stash;
	const restoreFilePreviewBuffer = bufferStore.restore;
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
	const [officeSelection, setOfficeSelection] = useState<OfficeEditorSelection | null>(null);
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
				if (opts?.newTab && preview && filePreviewPathEquals(cwd, preview.path, absolute)) return;
				// Panel tabs are keyed by path. A file under an additional root
				// would collide with the same relative path in the primary root, so
				// those tabs register the absolute path instead.
				const tabPath = cwd === primaryCwd ? entry.path : absolute;
				onOpenFile(tabPath, entry.name, { pin: opts?.pin ?? false, newTab: opts?.newTab ?? false });
				return;
			}
			void openPreview(entry);
		},
		[cwd, primaryCwd, onOpenFile, openPreview, preview],
	);

	// The active file tab owns content loading. A cancelled leave-guard rolls
	// the ref back so the declined tab can still be activated later.
	const lastLoadedRef = useRef<string | null>(null);

	// Switching the browsing root invalidates everything tied to the old root:
	// stash a dirty buffer, then drop the preview so the active tab reloads
	// against the new root. Declared BEFORE the active-file loader so the reset
	// runs first in the same commit; the mount run early-returns and leaves the
	// initial tab load alone.
	const previousRootRef = useRef(cwd);
	useEffect(() => {
		if (previousRootRef.current === cwd) return;
		previousRootRef.current = cwd;
		previewRequestRef.current += 1;
		const buffer = editBufRef.current;
		const path = previewPathRef.current;
		if (buffer && path) stashFilePreviewBuffer(path, buffer);
		lastLoadedRef.current = null;
		setPreview(null);
		setEdit(null);
		setSelectedPath(null);
		setError(null);
	}, [cwd]);

	useEffect(() => {
		if (!activeFile) {
			lastLoadedRef.current = null;
			return;
		}
		// A tab from another root cannot be resolved against this one.
		if (!pathInsideRoot(cwd, activeFile)) {
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
	}, [activeFile, cwd]);

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

	// Line-based reveals wait for the same edit buffer that Monaco will mount.
	// Visual Markdown first returns to source mode; the next effect pass reveals
	// after FileCodeEditor has registered the resource and consumed its content.
	const revealedLineRequestRef = useRef(0);
	useEffect(() => {
		const line = openRequest?.line;
		if (
			!openRequest ||
			line === undefined ||
			!Number.isInteger(line) ||
			line <= 0 ||
			revealedLineRequestRef.current === openRequest.nonce ||
			!preview ||
			!edit ||
			!filePreviewPathEquals(cwd, preview.path, openRequest.path)
		) {
			return;
		}
		if (extOf(preview.name) === "md" && mdRender) {
			const latest = markdownEditorRef.current?.getMarkdown();
			if (latest != null) updateEditText(latest);
			setMdRender(false);
			setFileSelection(null);
			return;
		}
		revealedLineRequestRef.current = openRequest.nonce;
		revealEditorLocation({
			path: preview.path,
			lineNumber: line,
			column: openRequest.column ?? 1,
		});
	}, [openRequest, preview, edit, cwd, mdRender]);

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

	// Markdown FILE preview. The shared renderer escapes raw HTML (correct for
	// chat, wrong for a README), so the previewed text is normalized to
	// Markdown first and relative media resolves against this file's directory
	// rather than the workspace root.
	const mdPreviewDir = useMemo(() => (preview ? parentDirectory(preview.path) : null), [preview?.path]);
	const mdPreviewText = useMemo(
		() =>
			preview && extOf(preview.name) === "md" && preview.text !== undefined
				? normalizeMarkdownHtml(preview.text)
				: "",
		[preview],
	);

	// Local images are read through the desktop bridge, exactly like the
	// transcript's, but resolved against the markdown file's own directory —
	// which is what `./screenshot.png` in a README means.
	useEffect(() => {
		if (!preview || extOf(preview.name) !== "md" || !mdRender || edit) return;
		const container = mdPreviewRef.current;
		if (!container) return;
		const directory = parentDirectory(preview.path);
		for (const img of Array.from(container.querySelectorAll<HTMLImageElement>("img[src]"))) {
			const src = img.getAttribute("src") ?? "";
			if (!src || /^(https?:|data:|blob:)/i.test(src)) continue;
			const rawPath = src.startsWith("file://") ? src.slice("file://".length) : src;
			const path = isAbsoluteFilePath(rawPath) ? rawPath.replace(/\\/g, "/") : joinFilePath(directory, rawPath);
			const cached = PREVIEW_IMAGE_CACHE.get(path);
			if (cached !== undefined) {
				img.src = cached;
				continue;
			}
			img.dataset.filepanePending = "true";
			void Promise.resolve(window.electronAPI?.readFileDataUrl(path))
				.then(result => {
					delete img.dataset.filepanePending;
					if (!result?.dataUrl || !img.isConnected) return;
					PREVIEW_IMAGE_CACHE.set(path, result.dataUrl);
					if (PREVIEW_IMAGE_CACHE.size > PREVIEW_IMAGE_CACHE_MAX) {
						const oldest = PREVIEW_IMAGE_CACHE.keys().next().value;
						if (oldest !== undefined) PREVIEW_IMAGE_CACHE.delete(oldest);
					}
					img.src = result.dataUrl;
				})
				.catch(() => {
					// Unreadable asset: show the browser's alt/broken state rather
					// than leaving an invisible placeholder.
					delete img.dataset.filepanePending;
				});
		}
	}, [preview, mdRender, edit, mdPreviewText]);

	// A file preview's links belong to the file, not to the chat: web links
	// open in the system browser, and rendered local paths open in this pane
	// when they live inside the workspace.
	useEffect(() => {
		if (!preview || extOf(preview.name) !== "md" || !mdRender || edit) return;
		const container = mdPreviewRef.current;
		if (!container) return;
		const directory = parentDirectory(preview.path);
		const handleClick = (event: MouseEvent): void => {
			if (event.defaultPrevented || event.button !== 0) return;
			if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			const target = event.target;
			if (!(target instanceof Element)) return;
			const anchor = target.closest("a[href]");
			if (anchor instanceof HTMLAnchorElement && container.contains(anchor)) {
				const href = anchor.getAttribute("href") ?? "";
				if (!/^https?:\/\//i.test(href)) return;
				event.preventDefault();
				event.stopPropagation();
				void openExternalUrl(href);
				return;
			}
			const pathElement = target.closest("[data-open-path]");
			if (!(pathElement instanceof HTMLElement) || !container.contains(pathElement)) return;
			const raw = pathElement.getAttribute("data-open-path") ?? "";
			if (!raw) return;
			event.preventDefault();
			event.stopPropagation();
			const rawPath = raw.startsWith("file://") ? raw.slice("file://".length) : raw;
			const absolute = isAbsoluteFilePath(rawPath) ? rawPath.replace(/\\/g, "/") : joinFilePath(directory, rawPath);
			const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
			const windows = /^[A-Za-z]:[\\/]/.test(cwd);
			const inside = windows
				? absolute.toLowerCase().startsWith(`${root.toLowerCase()}/`)
				: absolute.startsWith(`${root}/`);
			if (!inside) {
				void window.electronAPI?.openWith("", absolute);
				return;
			}
			const rel = absolute.slice(root.length + 1);
			openFile({ path: rel, name: rel.slice(rel.lastIndexOf("/") + 1), size: 0, isDir: false, mtime: 0, depth: 0 });
		};
		container.addEventListener("click", handleClick, true);
		return () => container.removeEventListener("click", handleClick, true);
	}, [preview, mdRender, edit, cwd, openFile, mdPreviewText]);

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

	const reportSaveError = useCallback((path: string, reason: unknown): void => {
		const details = reason instanceof Error ? reason.message : String(reason);
		setError(details);
		pushActionToast({
			kind: "error",
			title: t("tools.extConfigSaveFailed"),
			message: path,
			details,
			dedupeKey: `file:save:${path}`,
		});
	}, []);
	const clearSaveError = useCallback((path: string): void => {
		setError(null);
		dismissActionToastSource(`file:save:${path}`);
	}, []);

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
				let content = text;
				let encoding: "base64" | undefined;
				if (preview.office) {
					const draft = parseOfficeDraft(text);
					if (!draft) throw new Error("Invalid Office draft");
					const bytes = writeOfficeDraft(preview.office.bytes, draft);
					let binary = "";
					for (let offset = 0; offset < bytes.length; offset += 0x8000) {
						binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
					}
					content = btoa(binary);
					encoding = "base64";
				}
				const result = await rpc.request<{ ok: boolean; error?: string }>("fs.write", {
					cwd,
					path: rel,
					content,
					...(encoding ? { encoding } : {}),
				});
				if (!result.ok) throw new Error(result.error ?? "File save failed");
				setEdit(cur => (cur ? { ...cur, saved: text } : cur));
				unsavedBufferCache.delete(preview.path);
				clearSaveError(preview.path);
				// Disk save is authoritative. A missing or slow language server must
				// not turn a successful write into a visible save failure. Office
				// packages have no text document to synchronize with the LSP.
				if (!preview.office) {
					void rpc
						.request("editor.saved", { cwd, path: preview.path, content: text }, { timeoutMs: 12_000 })
						.catch(() => {});
				}
				await load();
			} catch (err) {
				reportSaveError(preview.path, err);
			} finally {
				setSaving(false);
			}
		},
		[edit, preview, cwd, rpc, load, saving, clearSaveError, reportSaveError],
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
				clearSaveError(absolute);
				void rpc
					.request("editor.saved", { cwd, path: absolute, content: text }, { timeoutMs: 12_000 })
					.catch(() => {});
				await load();
				return true;
			} catch (reason) {
				reportSaveError(absolute, reason);
				return false;
			}
		},
		[cwd, rpc, load, clearSaveError, reportSaveError],
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
		(selection: FileEditorSelection | PdfEditorSelection | OfficeEditorSelection | null, comment?: string): void => {
			if (!preview) return;
			const pdfSelection: PdfEditorSelection | null =
				selection && "anchor" in selection && "startPage" in selection.anchor
					? (selection as PdfEditorSelection)
					: null;
			const officeSelection: OfficeEditorSelection | null =
				selection && "anchor" in selection && "kind" in selection.anchor
					? (selection as OfficeEditorSelection)
					: null;
			const codeSelection: FileEditorSelection | null = selection && !("anchor" in selection) ? selection : null;
			const dom = selection ? null : captureSelectionContext();
			const domMatch = dom?.file?.path === preview.path ? dom : null;
			const quote = preview.office
				? (selection?.text ?? domMatch?.text ?? "")
				: (selection?.text ??
					domMatch?.text ??
					edit?.text ??
					preview.raw ??
					preview.text ??
					preview.htmlLive ??
					"");
			const startLine = codeSelection?.startLine ?? domMatch?.file?.startLine;
			const endLine = codeSelection?.endLine ?? domMatch?.file?.endLine;
			const displayContext = createFileQuoteContext({
				path: filePreviewWorkspacePath(cwd, preview.path),
				quote,
				language: codeSelection?.language ?? domMatch?.file?.language ?? extOf(preview.name),
				...(startLine !== undefined && endLine !== undefined ? { startLine, endLine } : {}),
				...(pdfSelection ? { pdf: { ...pdfSelection.anchor, fileSize: preview.size } } : {}),
				...(officeSelection ? { office: officeSelection.anchor } : {}),
				...(comment?.trim() ? { comment: comment.trim() } : {}),
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
		const indent = (depth - 1) * TREE_INDENT;
		const rowStyle = { "--tree-indent": `${indent}px` } as CSSProperties;
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
					style={rowStyle}
					role="treeitem"
					aria-level={depth}
					aria-posinset={posInSet}
					aria-setsize={setSize}
					aria-expanded={!closed}
				>
					<button
						type="button"
						className="gui-filepane-row"
						onClick={() => toggleDir(entry.path)}
						onContextMenu={ev => {
							ev.preventDefault();
							setCtx({ entry, x: ev.clientX, y: ev.clientY });
						}}
					>
						<span
							className={`gui-filepane-twist${closed ? " gui-filepane-twist--closed" : ""}`}
							aria-hidden="true"
						>
							<ChevronDown size={12} />
						</span>
						<span className="gui-filepane-glyph" aria-hidden="true">
							<MorphIcon
								icon={closed ? FolderIconData : FolderOpenIconData}
								size={14}
								strokeWidth={1.8}
								spring="snappy"
								reducedMotion="user"
							/>
						</span>
						<span className="gui-filepane-name" title={entry.path}>
							{node.label}
						</span>
						<SymlinkBadge entry={entry} />
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
				style={rowStyle}
				role="treeitem"
				aria-level={depth}
				aria-posinset={posInSet}
				aria-setsize={setSize}
			>
				<button
					type="button"
					className="gui-filepane-row"
					onClick={() => openFile(entry, { pin: false, newTab: activeFile !== null })}
					onDoubleClick={() => openFile(entry, { pin: true, newTab: activeFile !== null })}
					onContextMenu={ev => {
						ev.preventDefault();
						setCtx({ entry, x: ev.clientX, y: ev.clientY });
					}}
				>
					<span className="gui-filepane-twist" aria-hidden="true" />
					<span className="gui-filepane-glyph" aria-hidden="true">
						<TypeIcon name={entry.name} />
					</span>
					<span
						className={`gui-filepane-name${entry.name === "AGENTS.md" ? " gui-filepane-agents" : ""}`}
						title={entry.path}
					>
						{node.label}
					</span>
					<SymlinkBadge entry={entry} />
				</button>
				{openInApp}
			</li>
		);
	};

	const editingRow = editing ? (
		<li
			key="editing"
			className="gui-filepane-vrow gui-filepane-editing"
			style={{ "--tree-indent": `${(editing.depth - 1) * TREE_INDENT}px` } as CSSProperties}
		>
			<span className="gui-filepane-twist" aria-hidden="true" />
			<span className="gui-filepane-glyph" aria-hidden="true">
				{editing.kind === "rename" && editing.entry.isDir ? (
					<Folder size={14} strokeWidth={1.8} />
				) : editing.kind === "new-dir" ? (
					<Folder size={14} strokeWidth={1.8} />
				) : editing.kind === "rename" ? (
					<TypeIcon name={editing.entry.name} />
				) : (
					<FileIcon size={14} strokeWidth={1.8} className="gui-filepane-icon" />
				)}
			</span>
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
						<MorphIcon
							icon={showIgnored ? EyeIconData : EyeOffIconData}
							size={12}
							spring="snappy"
							reducedMotion="user"
						/>
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
						<MorphIcon
							icon={showHidden ? ScanEyeIconData : EyeOffIconData}
							size={12}
							spring="snappy"
							reducedMotion="user"
						/>
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
			{/* Working-dir breadcrumb. With several session working directories the
			 *  leading segment switches which root this pane browses. */}
			<div className="gui-filepane-path" title={cwd}>
				{roots.length > 1 ? (
					<button
						type="button"
						className="gui-filepane-path-root flex items-center gap-1 border-0 bg-transparent p-0 text-[11px] hover:text-[var(--color-text)]"
						aria-haspopup="menu"
						aria-expanded={rootMenu !== null}
						title={t("settings.workspaceRootHint")}
						onClick={event => {
							if (rootMenu) {
								setRootMenu(null);
								return;
							}
							const rect = event.currentTarget.getBoundingClientRect();
							setRootMenu({ x: rect.left, y: rect.bottom + 4 });
						}}
					>
						<Folder size={11} />
						<span className="truncate">{pathBaseName(cwd)}</span>
						<ChevronDown size={11} />
					</button>
				) : (
					<span className="gui-filepane-path-root">~/</span>
				)}
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
									ariaLabel={t("settings.filePreview")}
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
									ariaLabel={t("settings.filePreview")}
									value={htmlLiveMode}
									options={HTML_VIEW_SEGMENTS}
									onChange={value => setHtmlLiveMode(value === "source" ? "source" : "live")}
								/>
							)}
							<span className="gui-filepane-preview-tools">
								{preview.office && (
									<button
										type="button"
										className="gui-btn gui-btn-icon"
										title={t("general.save")}
										aria-label={t("general.save")}
										disabled={saving || !dirty}
										onClick={() => void saveEdit()}
									>
										<Save size={12} />
									</button>
								)}
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
										appendFileQuote(
											pdfSelection ??
												officeSelection ??
												(extOf(preview.name) === "md" && mdRender ? null : fileSelection),
										)
									}
								>
									<Quote size={12} />
								</button>
								{preview.htmlLive !== undefined && (
									<button
										type="button"
										className="gui-btn gui-btn-icon"
										title={t("general.openInPanelBrowser")}
										aria-label={t("general.openInPanelBrowser")}
										onClick={() => {
											const absolute = resolveFilePreviewPath(cwd, preview.path);
											window.dispatchEvent(
												new CustomEvent("musepi-open-url", {
													detail: { url: panelBrowserPreviewUrl(absolute) },
												}),
											);
										}}
									>
										<PanelRight size={12} />
									</button>
								)}
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
						<div
							className={`gui-filepane-preview-main${treeExpanded ? " gui-filepane-preview-main--tree-open" : ""}`}
						>
							{fileTree}
							<div
								className="gui-filepane-preview-body"
								ref={bodyRef}
								data-file-path={preview.path}
								data-file-language={extOf(preview.name)}
							>
								{preview.error && <p className="gui-error">{preview.error}</p>}
								{preview.htmlLive !== undefined && !edit && (
									<HtmlPreview rpc={rpc} source={preview.htmlLive} documentPath={preview.path} />
								)}
								{preview.html !== undefined && !edit && (
									<pre
										className="gui-filepane-preview-text"
										dangerouslySetInnerHTML={{ __html: preview.html }}
									/>
								)}
								{preview.text !== undefined && extOf(preview.name) === "md" && mdRender && !edit ? (
									<div className="gui-filepane-preview-md" ref={mdPreviewRef}>
										<Markdown text={mdPreviewText} basePath={mdPreviewDir ?? cwd} />
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
									<div className="gui-filepane-edit-layout">
										<FileEditor
											rpc={rpc}
											cwd={cwd}
											path={preview.path}
											value={edit.text}
											name={preview.name}
											dirty={dirty}
											saving={saving}
											hidden={preview.htmlLive !== undefined && htmlLiveMode === "live"}
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
											<HtmlPreview rpc={rpc} source={edit.text} documentPath={preview.path} />
										)}
									</div>
								)}
								{preview.docxBytes && <DocxPreview data={preview.docxBytes} path={preview.path} />}
								{preview.office && edit && (
									<FileOfficePreview
										bytes={preview.office.bytes}
										draft={parseOfficeDraft(edit.text) ?? preview.office.draft}
										restore={
											openRequest?.office
												? {
														anchor: openRequest.office,
														quote: openRequest.quote ?? "",
														nonce: openRequest.nonce,
													}
												: undefined
										}
										onChange={draft => updateEditText(serializeOfficeDraft(draft))}
										onSave={() => void saveEdit()}
										onSelection={setOfficeSelection}
									/>
								)}
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
													? {
															anchor: openRequest.pdf,
															quote: openRequest.quote ?? "",
															nonce: openRequest.nonce,
														}
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
						: preview?.office
							? officeSelection
								? { ...officeSelection, office: officeSelection.anchor }
								: null
							: edit && !(preview && extOf(preview.name) === "md" && mdRender)
								? fileSelection
								: undefined
				}
				onQuote={(text, pdf, office, comment) =>
					appendFileQuote(
						pdf && pdfSelection
							? { ...pdfSelection, text, anchor: pdf }
							: office && officeSelection
								? { ...officeSelection, text, anchor: office }
								: fileSelection,
						comment,
					)
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
						: officeSelection?.anchor.kind === "word"
							? `\n\n\`${path}#paragraph=${officeSelection.anchor.paragraphId + 1}\``
							: officeSelection?.anchor.kind === "workbook"
								? `\n\n\`${path}#sheet=${officeSelection.anchor.sheet}&range=${officeSelection.anchor.startCell}:${officeSelection.anchor.endCell}\``
								: officeSelection?.anchor.kind === "presentation"
									? `\n\n\`${path}#slide=${officeSelection.anchor.slide}&shape=${officeSelection.anchor.shapeId}\``
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
				open={rootMenu !== null}
				x={rootMenu?.x ?? 0}
				y={rootMenu?.y ?? 0}
				items={roots.map(path => ({
					label: pathBaseName(path),
					description: path,
					icon: directoriesEqual(path, cwd) ? "check" : "folder",
					onSelect: () => {
						setRootMenu(null);
						onRootChange?.(path);
					},
				}))}
				onClose={() => setRootMenu(null)}
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
function HtmlPreview({
	rpc,
	source,
	documentPath,
}: {
	rpc: RpcClient;
	source: string;
	documentPath: string;
}): ReactNode {
	const [previewDoc, setPreviewDoc] = useState(() => withHtmlPreviewBase(source, documentPath));
	useEffect(() => {
		let alive = true;
		setPreviewDoc(withHtmlPreviewBase(source, documentPath));
		void inlineHtmlPreviewStyles(source, documentPath, async path => {
			const result = await rpc.request<{ content: string | null }>("fs.read", { path });
			return result.content;
		}).then(document => {
			if (alive) setPreviewDoc(document);
		});
		return () => {
			alive = false;
		};
	}, [rpc, source, documentPath]);
	return (
		<div className="gui-filepane-preview-html">
			{htmlPreviewRequiresBuild(source) && (
				<div className="gui-filepane-preview-html-bar" role="note">
					{t("settings.htmlBuildPreviewNotice")}
				</div>
			)}
			<iframe
				className="gui-filepane-preview-html-frame"
				title={t("settings.pagePreview")}
				sandbox="allow-scripts"
				srcDoc={previewDoc}
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
	hidden,
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
	hidden?: boolean;
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
		<div className="gui-filepane-editor" hidden={hidden}>
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
