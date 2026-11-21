import { SearchField, t } from "@musepi/client-core";
import { FileText, Folder } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { resolveNativeFilePath, type WorkspaceEntry } from "../lib/file-workspace";
import type { RpcClient } from "../lib/rpc";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { addFileToChat, addToChatUnavailableReason } from "./composer/add-to-chat";
import { FadeScroll } from "./FadeScroll";

/** A searchable, non-modal directory menu anchored to its breadcrumb segment.
 * Directories navigate in place; files open a tab and dismiss the menu.
 * Right-clicking a row opens the file menu ("Add to chat"): the row gesture
 * replaces this popup with the floating menu, because two popups cannot share
 * the one-menu mutex. */
export function FileDirectoryMenu({
	rpc,
	cwd,
	path,
	anchor,
	open,
	onClose,
	onOpenFile,
}: {
	rpc: RpcClient;
	cwd: string;
	path: string | null;
	anchor: HTMLElement | null;
	open: boolean;
	onClose(): void;
	onOpenFile(path: string, name: string): void;
}): ReactNode {
	const [currentPath, setCurrentPath] = useState(path ?? "");
	const [entries, setEntries] = useState<WorkspaceEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	/** Row menu (right-click). It outlives the directory popup: the popup
	 *  closes on the right-click so only one floating menu is up at a time. */
	const [rowMenu, setRowMenu] = useState<{ entry: WorkspaceEntry; x: number; y: number } | null>(null);
	const { renderMenu } = useFloatingMenu(
		open,
		next => {
			if (!next) onClose();
		},
		{ className: "gui-filepane-directory-menu", anchor },
	);

	useEffect(() => {
		if (!open) return;
		setCurrentPath(path ?? "");
		setQuery("");
		setRowMenu(null);
	}, [open, path]);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setEntries(null);
		setError(null);
		void rpc
			.request<{ entries: WorkspaceEntry[] }>("workspace.tree", {
				cwd,
				...(currentPath ? { root: currentPath } : {}),
				maxDepth: 1,
				perDirLimit: 200,
			})
			.then(result => {
				if (cancelled) return;
				const sorted = [...(result.entries ?? [])].sort(
					(a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name),
				);
				setEntries(sorted);
			})
			.catch(reason => {
				if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => {
			cancelled = true;
		};
	}, [rpc, cwd, currentPath, open]);

	const filtered = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase();
		if (!normalized) return entries;
		return entries?.filter(entry => `${entry.name} ${entry.path}`.toLocaleLowerCase().includes(normalized));
	}, [entries, query]);

	// Row menu items. Read when the menu opens: a draft that went away
	// (read-only advisor view, closed scene) disables the entry with the reason
	// instead of failing after the click.
	const rowMenuItems: ContextMenuItem[] = rowMenu ? [addToChatItem(cwd, rowMenu.entry)] : [];

	return (
		<>
			{renderMenu(
				<>
					<div className="gui-filepane-directory-head">
						<span className="gui-filepane-directory-title" title={currentPath || cwd}>
							{currentPath || cwd}
						</span>
					</div>
					<SearchField
						className="gui-filepane-directory-search"
						size="compact"
						autoFocus
						iconSize={13}
						value={query}
						onChange={setQuery}
						placeholder={t("settings.searchFiles")}
						spellCheck={false}
					/>
					<FadeScroll className="gui-filepane-directory-list">
						{error && <p className="gui-error">{error}</p>}
						{!error && filtered === null && <p className="gui-filepane-empty">{t("settings.loading2")}</p>}
						{!error && filtered?.length === 0 && <p className="gui-filepane-empty">{t("general.noResults")}</p>}
						{filtered?.map(entry => (
							<button
								type="button"
								className="gui-filepane-directory-entry"
								key={entry.path}
								aria-haspopup="menu"
								onContextMenu={event => {
									event.preventDefault();
									event.stopPropagation();
									// One floating menu at a time (the shared mutex):
									// the row gesture replaces this popup.
									onClose();
									setRowMenu({ entry, x: event.clientX, y: event.clientY });
								}}
								onClick={() => {
									if (entry.isDir) {
										setCurrentPath(entry.path);
										setQuery("");
									} else {
										onOpenFile(entry.path, entry.name);
										onClose();
									}
								}}
							>
								{entry.isDir ? <Folder size={14} /> : <FileText size={14} />}
								<span>{entry.name}</span>
							</button>
						))}
					</FadeScroll>
				</>,
			)}
			{rowMenu && (
				<ContextMenu open x={rowMenu.x} y={rowMenu.y} items={rowMenuItems} onClose={() => setRowMenu(null)} />
			)}
		</>
	);
}

/** The row menu's one action. A directory has no file chip to ride, and a
 *  draft that cannot take the reference explains itself here — the item is
 *  disabled with that reason rather than failing after the click. */
function addToChatItem(cwd: string, entry: WorkspaceEntry): ContextMenuItem {
	const reason = entry.isDir ? t("settings.addToChatFolder") : addToChatUnavailableReason();
	return {
		label: t("settings.addToChat"),
		icon: "add",
		description: reason ?? undefined,
		disabled: reason !== null,
		onSelect: () => {
			void addFileToChat({
				path: resolveNativeFilePath(cwd, entry.path),
				name: entry.name,
				size: entry.size,
				isDir: entry.isDir,
			});
		},
	};
}
