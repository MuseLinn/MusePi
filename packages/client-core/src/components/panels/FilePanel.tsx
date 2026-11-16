import type { WorkspaceEntry } from "@musepi/pi-wire";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import type { SessionClient } from "../../lib/client";
import { type FilePreviewResult, readFilePreview, releaseFilePreview } from "../../lib/file-preview";
import { ConfirmDialog } from "../shell/ConfirmDialog";
import { FilePreviewBody } from "./FilePreviewBody";

/**
 * Guest workspace file panel: workspace.tree rendered as an expandable
 * directory tree (loaded once, folded locally), fs.readBytes previews chosen
 * by mime (text, image, audio, video, download), and (for write guests)
 * delete, rename and new-file write via fs.delete / fs.rename / fs.write.
 * Root is the session cwd from the snapshot. Read-only guests get browse +
 * preview only.
 */

interface FilePanelProps {
	client: SessionClient;
	/** Session cwd; null before the first state frame. */
	cwd: string | null;
	readOnly: boolean;
}

interface TreeNode extends WorkspaceEntry {
	children: TreeNode[] | null; // null for files
	expanded: boolean;
}

export function FilePanel({ client, cwd, readOnly }: FilePanelProps): ReactNode {
	const [tree, setTree] = useState<TreeNode[] | null>(null);
	const [rootPath, setRootPath] = useState<string>("");
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<WorkspaceEntry | null>(null);
	const [preview, setPreview] = useState<FilePreviewResult | null>(null);
	const previewRef = useRef<FilePreviewResult | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null); // entry path being renamed
	const [renameValue, setRenameValue] = useState("");
	const [newFileName, setNewFileName] = useState("");
	const [busy, setBusy] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<WorkspaceEntry | null>(null);

	const workspaceRoot = cwd ?? rootPath;

	const load = useCallback(async (): Promise<void> => {
		try {
			const res = await client.rpc<{ rootPath: string; truncated: boolean; entries: WorkspaceEntry[] }>(
				"workspace.tree",
				{ cwd: cwd ?? undefined, maxDepth: 5, perDirLimit: 300 },
			);
			setRootPath(res.rootPath);
			setTree(buildTree(res.entries));
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [client, cwd]);

	useEffect(() => {
		void load();
	}, [load]);

	const readSeq = useRef(0);

	const setPreviewOwned = useCallback((next: FilePreviewResult | null): void => {
		releaseFilePreview(previewRef.current);
		previewRef.current = next;
		setPreview(next);
	}, []);

	// The last preview owns an object URL until it is replaced or the panel
	// unmounts; leaking it keeps the whole file in memory.
	useEffect(() => () => releaseFilePreview(previewRef.current), []);

	const openFile = useCallback(
		async (entry: WorkspaceEntry): Promise<void> => {
			const seq = ++readSeq.current;
			setSelected(entry);
			setPreviewOwned(null);
			const result = await readFilePreview(client, entry, { cwd: cwd ?? rootPath ?? null });
			// A slower read must not replace the file the user picked after it.
			if (seq !== readSeq.current) {
				releaseFilePreview(result);
				return;
			}
			setPreviewOwned(result);
		},
		[client, cwd, rootPath, setPreviewOwned],
	);

	const del = useCallback((entry: WorkspaceEntry): void => {
		setPendingDelete(entry);
	}, []);

	const confirmDelete = useCallback(async (): Promise<void> => {
		if (!pendingDelete) return;
		setBusy(true);
		try {
			await client.rpc("fs.delete", { cwd: workspaceRoot, path: pendingDelete.path });
			await load();
			if (selected?.path === pendingDelete.path) {
				readSeq.current += 1;
				setSelected(null);
				setPreviewOwned(null);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
			setPendingDelete(null);
		}
	}, [client, load, pendingDelete, selected]);

	const doRename = useCallback(async (): Promise<void> => {
		if (!renaming || !renameValue.trim()) return;
		setBusy(true);
		try {
			await client.rpc("fs.rename", {
				cwd: workspaceRoot,
				from: renaming,
				to: joinPath(dirOf(renaming), renameValue.trim()),
			});
			setRenaming(null);
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [client, load, renaming, renameValue]);

	const createFile = useCallback(async (): Promise<void> => {
		if (!newFileName.trim()) return;
		setBusy(true);
		try {
			const dir = selected ? dirOf(selected.path) : "";
			await client.rpc("fs.write", {
				cwd: workspaceRoot,
				path: joinPath(dir, newFileName.trim()),
				content: "",
			});
			setNewFileName("");
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [client, load, newFileName, rootPath, selected]);

	return (
		<div className="sh-files">
			<div className="sh-panel-head">
				<h2 className="sh-panel-title">{t("settings.files")}</h2>
				<span className="sh-panel-muted sh-files-root" title={rootPath || cwd || ""}>
					{rootPath || cwd || ""}
				</span>
			</div>
			{error !== null && (
				<div className="sh-panel-state">
					<p className="sh-panel-error">{error}</p>
					<button type="button" className="sh-btn" onClick={() => void load()}>
						{t("settings.retry")}
					</button>
				</div>
			)}
			<div className="sh-files-body" data-selected={selected !== null ? "true" : undefined}>
				<div className="sh-files-tree">
					{tree === null ? (
						<p className="sh-panel-state">{t("settings.loading2")}</p>
					) : (
						<ul className="sh-tree">
							{tree.map(node => (
								<TreeRow
									key={node.path}
									node={node}
									depth={0}
									selected={selected?.path === node.path}
									onToggle={(n: TreeNode) => setTree(current => setExpanded(current, n.path))}
									onOpen={openFile}
									readOnly={readOnly}
									busy={busy}
									renaming={renaming === node.path}
									renameValue={renameValue}
									onRenameValue={setRenameValue}
									onRenameStart={(n: TreeNode) => {
										setRenaming(n.path);
										setRenameValue(n.name);
									}}
									onRenameCancel={() => setRenaming(null)}
									onRenameCommit={() => void doRename()}
									onDelete={del}
								/>
							))}
						</ul>
					)}
				</div>
				<div className="sh-files-preview">
					{selected === null ? (
						<p className="sh-panel-muted">{t("guest.selectFilePreview")}</p>
					) : preview === null ? (
						<p className="sh-panel-state">{t("settings.loading2")}</p>
					) : (
						<>
							<div className="sh-files-preview-head">
								<button
									type="button"
									className="sh-files-back"
									aria-label={t("settings.files")}
									onClick={() => {
										readSeq.current += 1;
										setSelected(null);
										setPreviewOwned(null);
									}}
								>
									<ChevronLeft size={16} aria-hidden />
								</button>
								<span className="sh-files-preview-name">{selected.name}</span>
								{preview.kind !== "error" && (
									<span className="sh-panel-muted">
										{preview.size} B · {preview.mime || "—"}
									</span>
								)}
							</div>
							<FilePreviewBody preview={preview} />
						</>
					)}
				</div>
			</div>
			{!readOnly && (
				<div className="sh-files-actions">
					<input
						className="sh-input"
						placeholder={t("guest.newFileName")}
						value={newFileName}
						onChange={e => setNewFileName(e.target.value)}
					/>
					<button type="button" className="sh-btn" disabled={busy} onClick={() => void createFile()}>
						{t("guest.createFile")}
					</button>
				</div>
			)}
			<ConfirmDialog
				open={pendingDelete !== null}
				title={pendingDelete ? t("guest.deleteFileWithName.info", { name: pendingDelete.name }) : ""}
				confirmLabel={t("settings.delete")}
				busy={busy}
				destructive
				onConfirm={() => void confirmDelete()}
				onClose={() => setPendingDelete(null)}
			/>
		</div>
	);
}

function TreeRow({
	node,
	depth,
	selected,
	onToggle,
	onOpen,
	readOnly,
	busy,
	renaming,
	renameValue,
	onRenameValue,
	onRenameStart,
	onRenameCancel,
	onRenameCommit,
	onDelete,
}: {
	node: TreeNode;
	depth: number;
	selected: boolean;
	onToggle(node: TreeNode): void;
	onOpen(node: TreeNode): void;
	readOnly: boolean;
	busy: boolean;
	renaming: boolean;
	renameValue: string;
	onRenameValue(v: string): void;
	onRenameStart(node: TreeNode): void;
	onRenameCancel(): void;
	onRenameCommit(): void;
	onDelete(node: TreeNode): void;
}): ReactNode {
	return (
		<li className="sh-tree-row" style={{ paddingLeft: `${8 + depth * 14}px` }}>
			{node.isDir ? (
				<button
					type="button"
					className={`sh-tree-toggle${node.expanded ? " sh-tree-toggle--open" : ""}`}
					onClick={() => onToggle(node)}
					aria-expanded={node.expanded}
				>
					<ChevronRight size={14} aria-hidden />
				</button>
			) : (
				<span className="sh-tree-file-icon" aria-hidden>
					<FileText size={14} />
				</span>
			)}
			{renaming ? (
				<input
					className="sh-input sh-tree-rename"
					value={renameValue}
					autoFocus
					onChange={e => onRenameValue(e.target.value)}
					onKeyDown={e => {
						if (e.key === "Enter") onRenameCommit();
						else if (e.key === "Escape") onRenameCancel();
					}}
					onBlur={onRenameCommit}
				/>
			) : (
				<button
					type="button"
					className={`sh-tree-name${selected ? " sh-tree-name--selected" : ""}`}
					onClick={() => (node.isDir ? onToggle(node) : onOpen(node))}
				>
					{node.name}
				</button>
			)}
			{!readOnly && !renaming && (
				<span className="sh-tree-ops">
					<button
						type="button"
						className="sh-btn-icon sh-tree-op"
						title={t("settings.rename")}
						disabled={busy}
						onClick={e => {
							e.stopPropagation();
							onRenameStart(node);
						}}
					>
						✎
					</button>
					<button
						type="button"
						className="sh-btn-icon sh-tree-op sh-tree-op--danger"
						title={t("settings.delete")}
						disabled={busy}
						onClick={e => {
							e.stopPropagation();
							onDelete(node);
						}}
					>
						✕
					</button>
				</span>
			)}
			{node.children !== null && node.expanded && node.children.length > 0 && (
				<ul className="sh-tree">
					{node.children.map(child => (
						<TreeRow
							key={child.path}
							node={child}
							depth={depth + 1}
							selected={selected}
							onToggle={onToggle}
							onOpen={onOpen}
							readOnly={readOnly}
							busy={busy}
							renaming={renaming}
							renameValue={renameValue}
							onRenameValue={onRenameValue}
							onRenameStart={onRenameStart}
							onRenameCancel={onRenameCancel}
							onRenameCommit={onRenameCommit}
							onDelete={onDelete}
						/>
					))}
				</ul>
			)}
		</li>
	);
}

function buildTree(entries: WorkspaceEntry[]): TreeNode[] {
	// Daemon returns a depth-first list with a `depth` field; rebuild the
	// nesting using parent-path chains so tree shape survives any ordering.
	const nodes = new Map<string, TreeNode>();
	const top: TreeNode[] = [];
	for (const entry of entries) {
		const full = normalize(entry.path);
		const node: TreeNode = { ...entry, path: full, children: entry.isDir ? [] : null, expanded: false };
		nodes.set(full, node);
		const dir = dirOf(full);
		const parent = dir === "" ? null : nodes.get(dir);
		if (parent?.children) parent.children.push(node);
		else top.push(node);
	}
	return top;
}

function setExpanded(nodes: TreeNode[] | null, path: string): TreeNode[] | null {
	if (nodes === null) return nodes;
	return nodes.map(node => {
		if (node.path === path) return { ...node, expanded: !node.expanded };
		if (node.children !== null) {
			const next = setExpanded(node.children, path);
			if (next !== node.children) return { ...node, children: next };
		}
		return node;
	});
}

/** Workspace-relative tree key. No leading slash: the same string is what
 *  every `fs.*` RPC accepts (the collab host rejects absolute paths, and the
 *  daemon resolves it against the session cwd). */
function normalize(p: string): string {
	return p.split("/").filter(Boolean).join("/");
}

function dirOf(p: string): string {
	const parts = normalize(p).split("/").filter(Boolean);
	parts.pop();
	return parts.join("/");
}

function joinPath(dir: string, name: string): string {
	if (name.startsWith("/")) return normalize(name);
	return normalize(dir ? `${dir}/${name}` : name);
}
