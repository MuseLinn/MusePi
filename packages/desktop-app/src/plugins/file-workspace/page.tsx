import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { filePreviewPathEquals } from "../../lib/file-workspace";
import { revealEditorLocation } from "../../lib/monaco-lsp";
import type { SlotComponentProps } from "../../lib/slot-host";
import { directoriesEqual, listSessionDirectories } from "../../lib/workspace-projects";
import { fileRootSelection, resolveWorkspaceRoot, rootSelectionKey } from "../../lib/workspace-roots";
import { FilePane } from "./FilePane";

/** Adapter between the generic panel-tab seat and the file workspace contract. */
export default function FileWorkspacePage({
	rpc,
	cwd,
	sessionId,
	panelTab,
	fileWorkspace,
}: SlotComponentProps): ReactNode {
	// Roots offered by this session: the primary directory plus the live
	// session's additional working directories (`session.directories.list`).
	const [roots, setRoots] = useState<string[]>(cwd ? [cwd] : []);
	// Root choice lives in a session-keyed store so a sidebar menu can select it
	// and a remounted pane reads it back; switching sessions reads its own key.
	const selectionKey = cwd ? rootSelectionKey(sessionId, cwd) : null;
	const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
	useEffect(() => {
		if (!selectionKey) {
			setSelectedRoot(null);
			return;
		}
		setSelectedRoot(fileRootSelection.get(selectionKey));
		return fileRootSelection.subscribe((key, root) => {
			if (key === selectionKey) setSelectedRoot(root);
		});
	}, [selectionKey]);

	useEffect(() => {
		if (!cwd) {
			setRoots([]);
			return;
		}
		const primary = cwd;
		if (!rpc || !sessionId) {
			setRoots([primary]);
			return;
		}
		let cancelled = false;
		void listSessionDirectories(rpc, sessionId)
			.then(directories => {
				if (cancelled) return;
				const additional = directories
					.map(directory => directory.path)
					.filter(path => !directoriesEqual(path, primary));
				setRoots([primary, ...additional]);
			})
			.catch(() => {
				// A snapshot session has no live directory list: primary only.
				if (!cancelled) setRoots([primary]);
			});
		return () => {
			cancelled = true;
		};
	}, [rpc, sessionId, cwd]);

	const activeRoot = useMemo(
		() => (cwd ? resolveWorkspaceRoot(cwd, roots, selectedRoot) : undefined),
		[cwd, roots, selectedRoot],
	);

	if (!rpc || !cwd || !panelTab || !fileWorkspace) return null;
	const workspace = fileWorkspace;
	// A directory tab's browse root is relative to the primary workspace; once
	// the pane switches to an additional root that narrowing no longer applies.
	const browseRoot = activeRoot === cwd && panelTab.dedupeKey != null && panelTab.target ? panelTab.target : null;
	const openRequest =
		workspace.openRequest &&
		panelTab.target &&
		filePreviewPathEquals(cwd, workspace.openRequest.path, panelTab.target)
			? workspace.openRequest
			: null;
	return (
		<FilePane
			key={panelTab.id}
			rpc={rpc}
			cwd={cwd}
			root={activeRoot}
			roots={roots}
			onRootChange={root => {
				if (selectionKey) fileRootSelection.set(selectionKey, root);
			}}
			bufferStore={workspace.buffers}
			activeFile={panelTab.target}
			browseRoot={browseRoot}
			openRequest={openRequest}
			onOpenFile={workspace.openFile}
			onDirty={workspace.setDirty}
			onClosePreview={() => workspace.closeTab(panelTab.id)}
			onNewSession={workspace.onNewSession}
			canNavigateBack={workspace.canNavigateBack}
			canNavigateForward={workspace.canNavigateForward}
			onNavigateBack={() => {
				const location = workspace.navigateHistory("back");
				if (location) revealEditorLocation(location);
			}}
			onNavigateForward={() => {
				const location = workspace.navigateHistory("forward");
				if (location) revealEditorLocation(location);
			}}
			onEditorNavigate={(source, target) => {
				workspace.onEditorNavigate(source, target);
				revealEditorLocation(target);
			}}
			onEditorPositionChange={workspace.onEditorPositionChange}
		/>
	);
}
