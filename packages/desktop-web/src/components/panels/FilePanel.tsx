import type { WorkspaceEntry } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import type { SessionClient } from "../../lib/client";

/**
 * Guest workspace file panel: workspace.tree rendered as an expandable
 * directory tree (loaded once, folded locally), fs.read for text previews,
 * and (for write guests) delete, rename and new-file write via fs.delete /
 * fs.rename / fs.write. Root is the session cwd from the snapshot.
 * Read-only guests get browse + preview only.
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
	const [preview, setPreview] = useState<{ text: string; size: number; mime: string } | null>(null);
	const [previewErr, setPreviewErr] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null); // entry path being renamed
	const [renameValue, setRenameValue] = useState("");
	const [newFileName, setNewFileName] = useState("");
	const [busy, setBusy] = useState(false);

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

	const openFile = useCallback(
		async (entry: WorkspaceEntry): Promise<void> => {
			setSelected(entry);
			setPreview(null);
			setPreviewErr(null);
			try {
				const res = await client.rpc<{ base64: string; size: number; mime: string; error?: string }>("fs.read", {
					path: entry.path,
					maxBytes: 64 * 1024,
				});
				if (res.error) {
					setPreviewErr(res.error);
					return;
				}
				setPreview({ text: atob(res.base64), size: res.size, mime: res.mime });
			} catch (err) {
				setPreviewErr(err instanceof Error ? err.message : String(err));
			}
		},
		[client],
	);

	const del = useCallback(
		async (entry: WorkspaceEntry): Promise<void> => {
			if (!window.confirm(t("delete file? {name}", { name: entry.name }))) return;
			setBusy(true);
			try {
				await client.rpc("fs.delete", { path: entry.path });
				await load();
				if (selected?.path === entry.path) {
					setSelected(null);
					setPreview(null);
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[client, load, selected],
	);

	const doRename = useCallback(async (): Promise<void> => {
		if (!renaming || !renameValue.trim()) return;
		setBusy(true);
		try {
			await client.rpc("fs.rename", { from: renaming, to: joinPath(dirOf(renaming), renameValue.trim()) });
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
			const dir = selected ? dirOf(selected.path) : rootPath;
			await client.rpc("fs.write", { path: joinPath(dir || rootPath, newFileName.trim()), content: "" });
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
				<h2 className="sh-panel-title">{t("files")}</h2>
				<span className="sh-panel-muted sh-files-root" title={rootPath || cwd || ""}>
					{rootPath || cwd || ""}
				</span>
			</div>
			{error !== null && (
				<div className="sh-panel-state">
					<p className="sh-panel-error">{error}</p>
					<button type="button" className="sh-btn" onClick={() => void load()}>
						{t("retry")}
					</button>
				</div>
			)}
			<div className="sh-files-body">
				<div className="sh-files-tree">
					{tree === null ? (
						<p className="sh-panel-state">{t("loading…")}</p>
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
						<p className="sh-panel-muted">{t("select a file to preview")}</p>
					) : previewErr !== null ? (
						<p className="sh-panel-error">{previewErr}</p>
					) : preview === null ? (
						<p className="sh-panel-state">{t("loading…")}</p>
					) : (
						<>
							<div className="sh-files-preview-head">
								<span className="sh-files-preview-name">{selected.name}</span>
								<span className="sh-panel-muted">
									{preview.size} B · {preview.mime}
								</span>
							</div>
							<pre className="sh-files-preview-text">{preview.text}</pre>
						</>
					)}
				</div>
			</div>
			{!readOnly && (
				<div className="sh-files-actions">
					<input
						className="sh-input"
						placeholder={t("new file name")}
						value={newFileName}
						onChange={e => setNewFileName(e.target.value)}
					/>
					<button type="button" className="sh-btn" disabled={busy} onClick={() => void createFile()}>
						{t("create file")}
					</button>
				</div>
			)}
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
				>
					▸
				</button>
			) : (
				<span className="sh-tree-spacer" />
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
						title={t("rename")}
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
						title={t("delete")}
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
		const parent = dir === "/" || dir === "" ? null : nodes.get(dir);
		if (parent && parent.children) parent.children.push(node);
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

function normalize(p: string): string {
	if (p === "/") return "/";
	return "/" + p.split("/").filter(Boolean).join("/");
}

function dirOf(p: string): string {
	const parts = normalize(p).split("/").filter(Boolean);
	parts.pop();
	return "/" + parts.join("/");
}

function joinPath(dir: string, name: string): string {
	if (name.startsWith("/")) return normalize(name);
	return normalize(`${dir}/${name}`);
}
