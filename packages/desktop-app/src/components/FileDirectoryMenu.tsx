import { t } from "@musepi/client-core";
import { FileText, Folder, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { FadeScroll } from "./FadeScroll";
import type { WorkspaceEntry } from "./FilePane";

/** A searchable, non-modal directory menu anchored to its breadcrumb segment.
 * Directories navigate in place; files open a tab and dismiss the menu. */
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

	return renderMenu(
		<>
			<div className="gui-filepane-directory-head">
				<span className="gui-filepane-directory-title" title={currentPath || cwd}>
					{currentPath || cwd}
				</span>
			</div>
			<label className="gui-filepane-directory-search">
				<Search size={13} />
				<input
					autoFocus
					type="search"
					value={query}
					placeholder={t("settings.searchFiles")}
					aria-label={t("settings.searchFiles")}
					onChange={event => setQuery(event.target.value)}
					spellCheck={false}
				/>
			</label>
			<FadeScroll className="gui-filepane-directory-list">
				{error && <p className="gui-error">{error}</p>}
				{!error && filtered === null && <p className="gui-filepane-empty">{t("settings.loading2")}</p>}
				{!error && filtered?.length === 0 && <p className="gui-filepane-empty">{t("general.noResults")}</p>}
				{filtered?.map(entry => (
					<button
						type="button"
						className="gui-filepane-directory-entry"
						key={entry.path}
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
	);
}
