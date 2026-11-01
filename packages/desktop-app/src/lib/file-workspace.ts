import type { PdfQuoteAnchor } from "@musepi/pi-wire";
import type { EditorHistoryDirection, EditorLocation } from "./editor-navigation";

/** The file surface keeps its persisted id while its renderer is plugin-owned. */
export const FILE_WORKSPACE_SURFACE = "files";
export const FILE_WORKSPACE_SLOT = "panel.tab.files";

export interface WorkspaceEntry {
	name: string;
	path: string;
	isDir: boolean;
	size: number;
	mtime: number;
	depth: number;
}

export interface FilePreviewOpenRequest {
	path: string;
	nonce: number;
	pdf?: PdfQuoteAnchor;
	quote?: string;
	line?: number;
	column?: number;
	pin?: boolean;
}

export interface FilePreviewBuffer {
	text: string;
	saved: string;
}

/** Host-owned draft lifecycle. The plugin must never bundle a second cache. */
export interface FilePreviewBufferStore {
	get(path: string): FilePreviewBuffer | undefined;
	set(path: string, buffer: FilePreviewBuffer): void;
	delete(path: string): void;
	stash(path: string, buffer: FilePreviewBuffer): void;
	restore(path: string): FilePreviewBuffer | null;
	discard(cwd: string, path: string): void;
}

/** Monaco and file tabs can spell the same Windows path with different slash
 * directions and drive-letter casing. Cache identity must not depend on either. */
function filePreviewBufferKey(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	return /^[A-Za-z]:\//.test(normalized) ? `${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}` : normalized;
}

/** Resolve tree-relative paths without treating Windows or UNC absolute paths
 * as workspace children. Preview state and the unsaved cache use this form. */
export function resolveFilePreviewPath(cwd: string, path: string): string {
	if (path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path)) return path;
	return `${cwd.replace(/[\\/]+$/, "")}/${path}`;
}

/** fs.write accepts workspace-relative paths only. Monaco normalizes Windows
 * paths to lowercase drive letters and backslashes, so compare Windows roots
 * case-insensitively and return slash-separated paths to the daemon. Paths
 * outside the workspace stay absolute and are rejected by the file service. */
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

export function createFilePreviewBufferStore(): FilePreviewBufferStore {
	const unsaved = new Map<string, FilePreviewBuffer>();
	const discarded = new Set<string>();
	return {
		get(path) {
			return unsaved.get(filePreviewBufferKey(path));
		},
		set(path, buffer) {
			unsaved.set(filePreviewBufferKey(path), buffer);
		},
		delete(path) {
			unsaved.delete(filePreviewBufferKey(path));
		},
		stash(path, buffer) {
			if (buffer.text !== buffer.saved && !discarded.has(filePreviewBufferKey(path))) {
				unsaved.set(filePreviewBufferKey(path), buffer);
			}
		},
		restore(path) {
			discarded.delete(filePreviewBufferKey(path));
			return unsaved.get(filePreviewBufferKey(path)) ?? null;
		},
		discard(cwd, path) {
			const absolute = resolveFilePreviewPath(cwd, path);
			unsaved.delete(filePreviewBufferKey(absolute));
			discarded.add(filePreviewBufferKey(absolute));
		},
	};
}

/** The desktop host's single draft owner, shared by every file-plugin mount. */
export const filePreviewBuffers = createFilePreviewBufferStore();

/** Compatibility entry for non-component hosts and focused contract tests. */
export function discardFilePreviewBuffer(cwd: string, path: string): void {
	filePreviewBuffers.discard(cwd, path);
}

export function stashFilePreviewBuffer(path: string, buffer: FilePreviewBuffer): void {
	filePreviewBuffers.stash(path, buffer);
}

export function restoreFilePreviewBuffer(path: string): FilePreviewBuffer | null {
	return filePreviewBuffers.restore(path);
}

/** Host operations supplied to panel.tab.files. All state remains in the host;
 * the compiled plugin receives this object through SlotComponentMount. */
export interface FileWorkspaceHost {
	buffers: FilePreviewBufferStore;
	openRequest: FilePreviewOpenRequest | null;
	openFile(path: string, name: string, options: { pin: boolean; newTab?: boolean }): void;
	setDirty(path: string, dirty: boolean): void;
	closeTab(id: string): void;
	onNewSession?(text: string): void;
	canNavigateBack: boolean;
	canNavigateForward: boolean;
	navigateHistory(direction: EditorHistoryDirection): EditorLocation | null;
	onEditorNavigate(source: EditorLocation, target: EditorLocation): void;
	onEditorPositionChange(location: EditorLocation): void;
}
